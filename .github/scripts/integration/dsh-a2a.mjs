/**
 * dsh-a2a base integration leg — the protocol surface against a real dsh
 * `web` profile boot: agent card discovery (current + legacy path), a
 * marker-file tool round-trip over SSE (deepseek-v4-flash through the
 * integration gateway) asserting the tool-call/tool-result data parts, the
 * text-delta messageId aggregation, and the final event's usage metadata, a
 * blocking message/send follow-up on the same task, the text-only boundary,
 * tasks/get, tasks/cancel, and the SDK's terminal-state guard.
 *
 * Two leg shapes driven by DSH_PROVIDER:
 * - base leg (unset): the full dsh + LLM flow above.
 * - backend-only leg (DSH_PROVIDER = redis): no dsh boot, no LLM, no
 *   secrets — drive RedisTaskStore (+ the SanitizedTaskStore wrapper) against
 *   the service Redis in DSH_DB_URL.
 *
 * Contract with .github/workflows/integration.yml:
 *   env in : DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL (base leg)
 *            DSH_DB_URL (provider legs)
 *   env opt: DSH_PROVIDER, DSH_HOME, DSH_CLI (default 'dsh'), RUNNER_TEMP
 *   exit   : non-zero on any failure
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  a2aClient,
  assert,
  bootA2a,
  readEvents,
  stopA2a,
  textOf,
  THINKING_OFF,
} from './lib/a2a-shared.mjs';

const provider = process.env.DSH_PROVIDER || '';
if (provider === 'redis') {
  await redisLeg();
  process.exit(0);
}
if (provider) throw new Error(`unknown DSH_PROVIDER ${provider}`);

const { a2a, proc, workDir } = await bootA2a({ tag: 'base', extraPatch: THINKING_OFF });
const client = a2aClient(a2a);

// The marker file's unique content can only reach the A2A answer through a
// tool result, proving the full A2A → bridge → agents.create → LLM → tool chain.
const markerFile = 'ci-marker.txt';
const markerContent = 'ci-dsh-a2a-marker-7788';
writeFileSync(join(workDir, markerFile), `${markerContent}\n`);

try {
  // 1. Discovery: current well-known path + legacy alias.
  const card = await (await fetch(`${a2a}/.well-known/agent-card.json`)).json();
  console.log('agent card:', JSON.stringify(card));
  assert(card.name === 'ci-a2a-agent', `card name ${card.name}`);
  assert(card.capabilities?.streaming === true, 'card must advertise streaming');
  assert(card.url === `${a2a}/a2a/`, `card url ${card.url}`);
  assert((await fetch(`${a2a}/.well-known/agent.json`)).ok, 'legacy agent.json alias');

  // 2. The marker turn over SSE. Model variance (garbled tool calls, empty
  //    wrap-up) is retried on a fresh task; once the marker lands, the event
  //    shape assertions run hard (a tool round-trip provably happened).
  const prompt = `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`;
  let task;
  for (let attempt = 1; attempt <= 3 && !task; attempt++) {
    console.log(`\n$ POST message/stream (attempt ${attempt})`);
    const res = await client.stream('message/stream', { message: client.userMessage(prompt) });
    assert(res.ok, `message/stream http ${res.status}`);
    assert(
      res.headers.get('content-type')?.includes('text/event-stream'),
      `stream content-type ${res.headers.get('content-type')}`,
    );
    const events = await readEvents(res);
    const final = events.at(-1);
    const answer = textOf(final);
    console.log(`events: ${events.length}, answer: ${JSON.stringify(answer.slice(0, 200))}`);
    if (!answer.includes(markerContent)) {
      console.log('::warning::answer missing the marker content — retrying on a fresh task');
      continue;
    }

    // Stream shape: working statuses, one aggregating messageId for the text
    // deltas, tool-call + tool-result data parts, usage on the final event.
    const updates = events.filter((e) => e.kind === 'status-update');
    assert(updates.some((e) => e.status?.state === 'working'), 'no working status-update');
    assert(
      final?.status?.state === 'input-required' && final.final === true,
      `stream must end on a final input-required, got ${JSON.stringify(final)}`,
    );
    const textIds = new Set(
      updates
        .filter((e) => e.metadata?.dshAgent?.kind === 'text-content')
        .map((e) => e.status.message?.messageId),
    );
    assert(textIds.size <= 1, `text deltas must share one messageId, got ${[...textIds]}`);
    const toolCall = updates.find((e) => e.metadata?.dshAgent?.kind === 'tool-call');
    const toolResult = updates.find((e) => e.metadata?.dshAgent?.kind === 'tool-result');
    assert(toolCall, 'no tool-call data part in the stream');
    assert(
      toolResult && JSON.stringify(toolResult.status.message?.parts).includes(markerContent),
      'no tool-result data part carrying the marker content',
    );
    assert(
      final.metadata?.usage?.inputTokens > 0,
      `final event missing usage metadata: ${JSON.stringify(final.metadata)}`,
    );
    task = { id: final.taskId, contextId: final.contextId };
  }
  assert(task, 'no stream contained the marker content — the model never read the marker file');

  // 3. Blocking follow-up on the SAME task: same-task continuation, and the
  //    blocking result shape — the answer rides status.message (the in-memory
  //    history ResultManager accumulates is the SDK's business; persisted
  //    history is stripped, see step 5).
  console.log('\n$ POST message/send (follow-up, blocking)');
  const follow = await client.rpc('message/send', {
    message: client.userMessage('只回复 ok 即可', { taskId: task.id, contextId: task.contextId }),
  });
  assert(!follow.body.error, `follow-up rpc error: ${JSON.stringify(follow.body.error)}`);
  assert(
    follow.body.result?.status?.state === 'input-required',
    `follow-up state ${follow.body.result?.status?.state}`,
  );
  assert(textOf(follow.body.result).length > 0, 'blocking result carries no answer text');

  // 4. The text-only boundary: a file part is rejected with a failed task
  //    (no LLM call is made — the executor rejects before session creation).
  const rejected = await client.rpc('message/send', {
    message: {
      ...client.userMessage('看这张图'),
      parts: [
        { kind: 'file', file: { uri: 'https://example.com/x.png', mimeType: 'image/png' } },
      ],
    },
  });
  assert(
    rejected.body.result?.status?.state === 'failed' &&
      JSON.stringify(rejected.body.result).includes('unsupported part kind'),
    `non-text parts must fail the task: ${JSON.stringify(rejected.body)}`,
  );

  // 5. Task state round-trip (history is stripped by design).
  const { body: got } = await client.rpc('tasks/get', { id: task.id });
  assert(
    got.result?.status?.state === 'input-required',
    `tasks/get state ${got.result?.status?.state}`,
  );
  assert(
    Array.isArray(got.result.history) && got.result.history.length === 0,
    'task history must be stripped (conversation history is dsh-storage)',
  );

  // 6. Cancel, then the SDK's terminal-state guard rejects further sends.
  const { body: canceled } = await client.rpc('tasks/cancel', { id: task.id });
  assert(
    canceled.result?.status?.state === 'canceled',
    `cancel state ${canceled.result?.status?.state}`,
  );
  const { body: terminal } = await client.rpc('message/send', {
    message: client.userMessage('还有吗', { taskId: task.id }),
  });
  assert(terminal.error, 'a terminal task must reject follow-up sends');

  console.log(`\nSCENARIO_OK base (task=${task.id})`);
} finally {
  await stopA2a(proc);
}

/**
 * Backend-only Redis leg: drive the production store path
 * (SanitizedTaskStore → RedisTaskStore) against the service Redis and check
 * the key layout, TTL, and history stripping. (Save deduping is covered by
 * the unit tests — it is not observable through key contents.)
 */
async function redisLeg() {
  const url = process.env.DSH_DB_URL;
  if (!url) throw new Error('DSH_DB_URL is required for provider legs');
  const pkgUrl = (rel) => new URL(`../../../packages/dsh-a2a/${rel}`, import.meta.url);
  const { RedisTaskStore } = await import(pkgUrl('lib/stores/redis.js').href);
  const { SanitizedTaskStore } = await import(pkgUrl('lib/task-store.js').href);
  const require = createRequire(pkgUrl('package.json'));
  const { Redis } = require('ioredis');

  const raw = new Redis(url);
  const store = new SanitizedTaskStore(new RedisTaskStore({ url, keyPrefix: 'ci', ttlSeconds: 60 }));
  await store.init();

  const base = {
    kind: 'task',
    id: 'ci-task-1',
    contextId: 'ci-ctx-1',
    history: [
      { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
    ],
    artifacts: [],
    metadata: { dshAgent: { kind: 'state-change' } },
  };
  // State changes persist; repeated same-state saves collapse.
  await store.save({ ...base, status: { state: 'working', timestamp: '2026-01-01T00:00:00Z' } });
  await store.save({ ...base, status: { state: 'working', timestamp: '2026-01-01T00:00:01Z' } });
  await store.save({ ...base, status: { state: 'input-required', timestamp: '2026-01-01T00:00:02Z' } });

  const keys = await raw.keys('ci:tasks:*');
  const ttl = await raw.ttl('ci:tasks:ci-task-1');
  const loaded = await store.load('ci-task-1');
  console.log(`keys: ${keys}, ttl: ${ttl}, loaded: ${JSON.stringify(loaded)}`);
  await store.close();
  await raw.quit();

  assert(keys.length === 1 && keys[0] === 'ci:tasks:ci-task-1', `unexpected keys ${keys}`);
  assert(ttl > 0 && ttl <= 60, `ttl ${ttl} outside (0, 60]`);
  assert(loaded?.status?.state === 'input-required', `loaded state ${loaded?.status?.state}`);
  assert(
    Array.isArray(loaded.history) && loaded.history.length === 0,
    'persisted task must carry no history',
  );
  console.log('SCENARIO_OK redis (backend-only leg)');
}
