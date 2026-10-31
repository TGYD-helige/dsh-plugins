/** Packed plugin + real CLI/model: native inbox management and checkpointed SSE. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { a2aClient, assert, bootA2a, stopA2a, THINKING_OFF, textOf } from './lib/a2a-shared.mjs';
import { requireEnv } from './lib/ci-shared.mjs';

requireEnv(['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY']);
const upstream = process.env.DSH_INTEGRATION_BASE_URL.replace(/\/$/, '');
const upstreamUrl = new URL(upstream);
const contextId = randomUUID();
const edited = `edited-${randomUUID().slice(0, 8)}`;
const steering = `steer-${randomUUID().slice(0, 8)}`;
let releaseModel;
const modelGate = new Promise((resolve) => {
  releaseModel = resolve;
});
let held = false;
let forwarded = 0;
const forwarding = new Set();

// Only delays the first edited request; all responses come from the real gateway.
const gateway = createServer(async (req, res) => {
  const controller = new AbortController();
  forwarding.add(controller);
  res.once('close', () => controller.abort());
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      assert(bytes <= 16 * 1024 * 1024, 'gateway request exceeds 16 MiB');
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (!held && body.includes(Buffer.from(edited))) {
      held = true;
      await modelGate;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([key]) => !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key),
      ),
    );
    const response = await fetch(`${upstreamUrl.origin}${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
    });
    forwarded++;
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json',
    });
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch {
    if (!res.destroyed) {
      res.statusCode = 502;
      res.end('Integration gateway forwarding failed');
    }
  } finally {
    forwarding.delete(controller);
  }
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
let proc;
const subscriptions = [];

async function eventually(check, label) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  process.env.DSH_INTEGRATION_BASE_URL = `http://127.0.0.1:${gateway.address().port}${upstreamUrl.pathname}`;
  const boot = await bootA2a({
    tag: 'inbox-api',
    inbox: true,
    extraPatch: `${THINKING_OFF}\n- id: session-title-llm\n  disabled: true\n`,
  });
  proc = boot.proc;
  process.env.DSH_INTEGRATION_BASE_URL = upstream;
  const card = await (
    await fetch(`${boot.a2a}/.well-known/agent-card.json`, {
      headers: { 'A2A-Version': '1.0' },
      signal: AbortSignal.timeout(10_000),
    })
  ).json();
  const uri = card.capabilities?.extensions?.find(
    (extension) =>
      extension.uri ===
      'https://github.com/TGYD-helige/dsh-plugins/blob/main/packages/dsh-a2a/README.md',
  )?.uri;
  assert(uri, 'agent card must advertise the native inbox extension');
  const client = a2aClient(boot.a2a, { extensions: [uri], signal: AbortSignal.timeout(240_000) });
  const rpc = async (method, params = {}) => {
    const { res, body } = await client.rpc(method, { contextId, ...params });
    assert(res.ok && !body.error, `${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const inbox = () => rpc('inbox/get');
  const park = async (text) =>
    (
      await rpc('SendMessage', {
        message: client.userMessage(text, { contextId, metadata: { [uri]: { wakeup: false } } }),
        configuration: { returnImmediately: true },
      })
    ).task;
  const settled = async (id, state) => {
    let task;
    await eventually(async () => {
      task = await rpc('GetTask', { id });
      assert(
        !['TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(task.status?.state),
        `task failed: ${textOf(task)}`,
      );
      return task.status?.state === state;
    }, `task ${id} -> ${state}`);
    return task;
  };
  const subscribe = async () => {
    const response = await client.stream('inbox/subscribe', { contextId });
    assert(
      response.ok && response.headers.get('content-type')?.includes('text/event-stream'),
      'inbox SSE response',
    );
    assert(response.headers.get('A2A-Extensions') === uri, 'inbox extension activation response');
    const reader = response.body.getReader();
    const state = { version: -Infinity, error: undefined };
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const frame = JSON.parse(buffer.slice(0, cut).replace(/^data: /, ''));
          assert(!frame.error, 'inbox subscription error');
          assert(
            frame.result.contextId === contextId && Number.isInteger(frame.result.version),
            'inbox invalidation identity/version',
          );
          assert(frame.result.version >= state.version, 'inbox version regressed');
          state.version = frame.result.version;
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
    })().catch((error) => {
      state.error = error;
    });
    subscriptions.push(async () => {
      await reader.cancel();
      await reading;
    });
    await eventually(() => {
      if (state.error) throw state.error;
      return Number.isFinite(state.version);
    }, 'initial checkpointed invalidation');
    return state;
  };
  const windows = [await subscribe(), await subscribe()];
  const notified = async (version, strictlyAfter = false) =>
    eventually(
      () =>
        windows.every((window) => {
          if (window.error) throw window.error;
          return strictlyAfter ? window.version > version : window.version >= version;
        }),
      `both subscribers checkpoint version ${version}`,
    );

  const cleared = await park('This queued message must be cleared without model execution.');
  const empty = await rpc('inbox/clear');
  assert(empty.nextTurn.length === 0, 'clear leaves an empty queue');
  await settled(cleared.id, 'TASK_STATE_CANCELED');
  await notified(empty.version);
  const active = await park(
    'Only reply UNEDITED_INPUT; this message will be edited before execution.',
  );
  const removed = await park('This queued message must be removed without model execution.');
  const steered = await park(
    `请回忆刚才记住的代号，再追加代号 ${steering}。仅回复这两个代号，不要使用工具。`,
  );
  let snapshot = await inbox();
  const entry = snapshot.nextTurn.find((item) => item.message.taskId === active.id);
  const toRemove = snapshot.nextTurn.find((item) => item.message.taskId === removed.id);
  const toSteer = snapshot.nextTurn.find((item) => item.message.taskId === steered.id);
  assert(entry && toRemove && toSteer, 'get returns all parked native identities');
  snapshot = await rpc('inbox/update', {
    id: entry.id,
    message: {
      ...entry.message,
      parts: [{ text: `记住代号 ${edited}。只回复这个代号，不要使用工具。` }],
    },
  });
  assert(
    snapshot.nextTurn[0].id === entry.id &&
      snapshot.nextTurn[0].message.messageId === entry.message.messageId,
    'editing preserves native/protocol identity',
  );
  snapshot = await rpc('inbox/move', { id: toSteer.id, index: 0 });
  assert(snapshot.nextTurn[0].id === toSteer.id, 'move uses the requested queue index');
  snapshot = await rpc('inbox/remove', { id: toRemove.id });
  assert(!snapshot.nextTurn.some((item) => item.id === toRemove.id), 'remove updates native queue');
  await settled(removed.id, 'TASK_STATE_CANCELED');
  await notified(snapshot.version);
  assert(!held && forwarded === 0, 'parked/edited input must not call the model');

  await rpc('inbox/execute', { id: entry.id });
  await eventually(() => held, 'edited request reaches the real model boundary');
  snapshot = await rpc('inbox/steer', { id: toSteer.id, taskId: active.id });
  assert(
    snapshot.nextStep.some((item) => item.id === toSteer.id),
    'steer transfers input to next-step',
  );
  await settled(steered.id, 'TASK_STATE_CANCELED');
  const beforeConsumption = snapshot.version;
  releaseModel();
  const completed = await settled(active.id, 'TASK_STATE_COMPLETED');
  const answer = textOf(completed);
  assert(
    answer.includes(edited) && answer.includes(steering),
    `model must use edited input and steering: ${answer}`,
  );
  await notified(beforeConsumption, true);
  snapshot = await inbox();
  assert(
    snapshot.nextTurn.length === 0 && snapshot.nextStep.length === 0,
    'native consumption empties both queues',
  );

  const continued = await rpc('SendMessage', {
    message: client.userMessage(
      '刚才记住的原始代号和追加代号分别是什么？仅回复两个代号，不要使用工具。',
      { contextId },
    ),
  });
  const recalled = textOf(continued.task);
  assert(
    recalled.includes(edited) && recalled.includes(steering),
    `context continuation must recall both codes: ${recalled}`,
  );
  assert(
    forwarded >= 3,
    'edited turn, steering step and continuation must reach the model gateway',
  );
  console.log(
    `SCENARIO_OK inbox-api (context=${contextId}, modelRequests=${forwarded}, versions=${windows.map((window) => window.version)})`,
  );
} finally {
  process.env.DSH_INTEGRATION_BASE_URL = upstream;
  releaseModel();
  await Promise.allSettled(subscriptions.map((close) => close()));
  try {
    if (proc) await stopA2a(proc);
  } finally {
    for (const controller of forwarding) controller.abort();
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  }
}
