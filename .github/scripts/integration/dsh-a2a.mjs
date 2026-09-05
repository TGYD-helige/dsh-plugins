/**
 * dsh-a2a base integration leg — the A2A 1.0 protocol surface against a real
 * dsh `web` profile boot: agent card discovery (v1 card + legacy card for
 * headerless clients), a marker-file tool round-trip over SSE
 * (the $DSH_INTEGRATION_MODEL, default deepseek-v4-flash, through the
 * integration gateway) asserting the
 * tool-call/tool-result data parts, the text-delta messageId aggregation, and
 * the final event's usage metadata, a blocking SendMessage follow-up on the
 * same task, ListTasks, the text-only boundary, GetTask, CancelTask, the
 * SDK's terminal-state guard, and one legacy 0.3 `message/send` through the
 * compat layer.
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
  STATES,
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
  // 1. Discovery: v1 card with both protocol versions declared, legacy card
  //    for headerless (0.3) clients, plus the pre-1.0 path alias.
  const card = await (
    await fetch(`${a2a}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })
  ).json();
  console.log('agent card:', JSON.stringify(card));
  assert(card.name === 'ci-a2a-agent', `card name ${card.name}`);
  assert(card.capabilities?.streaming === true, 'card must advertise streaming');
  const versions = (card.supportedInterfaces ?? []).map(
    (i) => `${i.protocolBinding}@${i.protocolVersion}`,
  );
  assert(versions.includes('JSONRPC@1.0'), `card must declare JSONRPC@1.0, got ${versions}`);
  assert(versions.includes('JSONRPC@0.3'), `card must declare the legacy mirror, got ${versions}`);
  const legacyCard = await (await fetch(`${a2a}/.well-known/agent-card.json`)).json();
  assert(legacyCard.protocolVersion === '0.3', `legacy card version ${legacyCard.protocolVersion}`);
  assert((await fetch(`${a2a}/.well-known/agent.json`)).ok, 'legacy agent.json alias');

  // 2. The marker turn over SSE. Model variance (garbled tool calls, empty
  //    wrap-up) is retried on a fresh task; once the marker lands, the event
  //    shape assertions run hard (a tool round-trip provably happened).
  const prompt = `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`;
  let task;
  for (let attempt = 1; attempt <= 3 && !task; attempt++) {
    console.log(`\n$ POST SendStreamingMessage (attempt ${attempt})`);
    const res = await client.stream('SendStreamingMessage', { message: client.userMessage(prompt) });
    assert(res.ok, `SendStreamingMessage http ${res.status}`);
    assert(
      res.headers.get('content-type')?.includes('text/event-stream'),
      `stream content-type ${res.headers.get('content-type')}`,
    );
    const events = await readEvents(res);
    const final = events.at(-1);
    const answer = textOf(final?.value);
    console.log(`events: ${events.length}, answer: ${JSON.stringify(answer.slice(0, 200))}`);
    if (!answer.includes(markerContent)) {
      console.log('::warning::answer missing the marker content — retrying on a fresh task');
      continue;
    }

    // Stream shape: task anchor first (1.0 ordering), working statuses, one
    // aggregating messageId for text deltas, tool-call + tool-result data
    // parts, usage on the final event.
    assert(events[0]?.kind === 'task', `first event must be the task anchor, got ${events[0]?.kind}`);
    assert(
      events[0].value.status?.state === STATES.submitted,
      `anchor state ${events[0].value.status?.state}`,
    );
    const updates = events.filter((e) => e.kind === 'statusUpdate').map((e) => e.value);
    assert(updates.some((e) => e.status?.state === STATES.working), 'no working statusUpdate');
    assert(
      final?.kind === 'statusUpdate' && final.value.status?.state === STATES.inputRequired,
      `stream must end on input-required, got ${JSON.stringify(final)}`,
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
      final.value.metadata?.usage?.inputTokens > 0,
      `final event missing usage metadata: ${JSON.stringify(final.value.metadata)}`,
    );
    task = { id: final.value.taskId, contextId: final.value.contextId };
  }
  assert(task, 'no stream contained the marker content — the model never read the marker file');

  // 3. Blocking follow-up on the SAME task: same-task continuation, and the
  //    blocking result shape — the answer rides result.task.status.message.
  console.log('\n$ POST SendMessage (follow-up, blocking)');
  const follow = await client.rpc('SendMessage', {
    message: client.userMessage('只回复 ok 即可', { taskId: task.id, contextId: task.contextId }),
  });
  assert(!follow.body.error, `follow-up rpc error: ${JSON.stringify(follow.body.error)}`);
  assert(
    follow.body.result?.task?.status?.state === STATES.inputRequired,
    `follow-up state ${follow.body.result?.task?.status?.state}`,
  );
  assert(textOf(follow.body.result.task).length > 0, 'blocking result carries no answer text');

  // 4. ListTasks finds the task with history stripped.
  const { body: listed } = await client.rpc('ListTasks', {});
  assert(!listed.error, `ListTasks error: ${JSON.stringify(listed.error)}`);
  const listedTask = (listed.result?.tasks ?? []).find((t) => t.id === task.id);
  assert(listedTask, `task ${task.id} missing from ListTasks`);
  assert(
    (listedTask.history ?? []).length === 0,
    'persisted task must carry no history (conversation history is dsh-storage)',
  );

  // 5. The text-only boundary: a file part is rejected with a failed task
  //    (no LLM call is made — the executor rejects before session creation).
  const rejected = await client.rpc('SendMessage', {
    message: {
      ...client.userMessage('看这张图'),
      parts: [{ url: 'https://example.com/x.png', mediaType: 'image/png' }],
    },
  });
  assert(
    rejected.body.result?.task?.status?.state === STATES.failed &&
      JSON.stringify(rejected.body.result).includes('unsupported part kind'),
    `non-text parts must fail the task: ${JSON.stringify(rejected.body)}`,
  );

  // 6. Legacy 0.3 clients keep working through the compat layer.
  console.log('\n$ POST message/send (legacy 0.3 spelling)');
  const legacy = await client.legacy('message/send', {
    message: {
      kind: 'message',
      messageId: 'legacy-1',
      role: 'user',
      parts: [{ kind: 'text', text: '只回复 ok 即可' }],
    },
  });
  const legacyBody = await legacy.json();
  assert(legacy.status === 200 && !legacyBody.error, `legacy send: ${JSON.stringify(legacyBody)}`);
  assert(legacyBody.result?.kind === 'task', 'legacy result must be a 0.3-shaped task');
  assert(
    legacyBody.result.status?.state === 'input-required',
    `legacy state ${legacyBody.result?.status?.state}`,
  );

  // 7. GetTask round-trip, CancelTask, then the terminal-state guard.
  const { body: got } = await client.rpc('GetTask', { id: task.id });
  assert(
    got.result?.status?.state === STATES.inputRequired,
    `GetTask state ${got.result?.status?.state}`,
  );
  const { body: canceled } = await client.rpc('CancelTask', { id: task.id });
  assert(
    canceled.result?.status?.state === STATES.canceled,
    `CancelTask state ${canceled.result?.status?.state}`,
  );
  const { body: terminal } = await client.rpc('SendMessage', {
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
 * the key layout, TTL, list(), and history stripping. (Save deduping is
 * covered by the unit tests — it is not observable through key contents.)
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
    id: 'ci-task-1',
    contextId: 'ci-ctx-1',
    history: [
      {
        messageId: 'm1',
        contextId: 'ci-ctx-1',
        taskId: 'ci-task-1',
        role: 1,
        parts: [
          {
            content: { $case: 'text', value: 'hi' },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
    ],
    artifacts: [],
    metadata: { dshAgent: { kind: 'state-change' } },
  };
  const shell = (state, timestamp) => ({
    ...base,
    status: { state, message: undefined, timestamp },
    history: [],
  });
  // State changes persist; repeated same-state saves collapse.
  await store.save(shell(2, '2026-01-01T00:00:00Z'), undefined);
  await store.save(shell(2, '2026-01-01T00:00:01Z'), undefined);
  await store.save(shell(6, '2026-01-01T00:00:02Z'), undefined);

  const keys = await raw.keys('ci:tasks:*');
  const ttl = await raw.ttl('ci:tasks:ci-task-1');
  const loaded = await store.load('ci-task-1', undefined);
  const listed = await store.list(
    { tenant: '', contextId: '', status: 0, pageToken: '', statusTimestampAfter: undefined },
    undefined,
  );
  console.log(
    `keys: ${keys}, ttl: ${ttl}, loaded: ${JSON.stringify(loaded)}, listed: ${listed.totalSize}`,
  );
  await store.close();
  await raw.quit();

  assert(keys.length === 1 && keys[0] === 'ci:tasks:ci-task-1', `unexpected keys ${keys}`);
  assert(ttl > 0 && ttl <= 60, `ttl ${ttl} outside (0, 60]`);
  assert(loaded?.status?.state === 6, `loaded state ${loaded?.status?.state}`);
  assert(
    Array.isArray(loaded.history) && loaded.history.length === 0,
    'persisted task must carry no history',
  );
  assert(listed.totalSize === 1 && listed.tasks[0]?.id === 'ci-task-1', 'list must find the task');
  console.log('SCENARIO_OK redis (backend-only leg)');
}
