/** Real loop, A2A HTTP, and JSONL restart; only model responses are scripted. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Langfuse from '../../../packages/dsh-langfuse/src/index.js';
import { startFakeIngestion, capturedToObservations, runVerification } from './lib/langfuse-shared.mjs';
import { A2aBridge } from '../../../packages/dsh-a2a/src/bridge.js';
import { NativeInbox, INBOX_EXTENSION } from '../../../packages/dsh-a2a/src/inbox.js';
import { DshAgentExecutor } from '../../../packages/dsh-a2a/src/executor.js';
import { MemoryTaskStore, SanitizedTaskStore } from '../../../packages/dsh-a2a/src/task-store.js';
import { startA2aServer } from '../../../packages/dsh-a2a/src/server.js';

const require = createRequire(new URL('../../../packages/dsh-a2a/package.json', import.meta.url));
const { Message } = await import(pathToFileURL(require.resolve('@a2a-js/sdk')).href);
const { ServerCallContext } = await import(pathToFileURL(require.resolve('@a2a-js/sdk/server')).href);
const { MockAdapter, textResponse } = await import(`${process.env.DSH_SOURCE_ROOT}/packages/core/agent-loop/tests/mock-adapter.ts`);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });

async function boot(options: { root?: string; store?: SanitizedTaskStore; backend?: MemoryTaskStore; script?: unknown[]; langfuseUrl?: string; langfuse?: Langfuse.LangfusePluginConfig; contextId?: string } = {}) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin);
  if (options.root) await ctx.plugin(JsonlSessionPersistence, { root: options.root, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  if (options.langfuse || options.langfuseUrl) await ctx.plugin(Langfuse, options.langfuse ?? { enabled: true, publicKey: 'public-inbox-test', secretKey: 'secret-inbox-test', baseUrl: options.langfuseUrl, captureContent: false });
  const adapter = new MockAdapter(options.script ?? Array.from({ length: 8 }, () => textResponse('ok')));
  ctx.llm.registerAdapter(['mock'], adapter);
  const bridge = new A2aBridge(ctx, { cwd: '/tmp', agentOptions: { provider: 'mock', model: 'mock' } });
  const backend = options.backend ?? new MemoryTaskStore();
  const store = options.store ?? new SanitizedTaskStore(backend);
  const inbox = new NativeInbox(ctx, bridge, store);
  const server = await startA2aServer({
    extensions: [{ uri: INBOX_EXTENSION, description: '', required: false, params: undefined }],
    host: '127.0.0.1', port: 0, basePath: '/a2a', card: { name: 'test', description: '', version: '1' }, taskStore: store,
    executor: new DshAgentExecutor(bridge), beforeMessage: (message, context) => inbox.beforeMessage(message, context),
    beforeTask: (taskId, context) => inbox.beforeTask(taskId, context),
    approvalGuard: (message) => bridge.reserveApprovalMessage(message),
  });
  inbox.server = server;
  cleanups.push(() => server.close());
  cleanups.push(() => bridge.dispose());
  const contextId = options.contextId ?? 'native-test';
  const rpc = async (method: string, params: unknown, extensions = true) => (await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...(extensions ? { 'A2A-Extensions': INBOX_EXTENSION } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json();
  const send = async (id: string, controls: Record<string, unknown> = {}, taskId?: string, text = id) => {
    const response = await rpc('SendMessage', { message: { messageId: id, role: 'ROLE_USER', contextId, taskId, parts: [{ text }], metadata: { [INBOX_EXTENSION]: controls } }, configuration: { returnImmediately: true } });
    expect(response.error).toBeUndefined();
    return response.result.task;
  };
  const completed = async (id: string) => { await expect.poll(async () => (await rpc('GetTask', { id })).result.status.state).toBe('TASK_STATE_COMPLETED'); };
  return { ctx, adapter, bridge, inbox, store, backend, server, rpc, send, completed };
}

it('durably queues separate tasks and wakes them in order without duplicate user messages', async () => {
  const f = await boot();
  const tasks = [];
  for (const id of ['one', 'two']) {
    const task = await f.send(id, { wakeup: false });
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    tasks.push(task);
  }
  expect(f.adapter.requests).toHaveLength(0);
  await f.inbox.wake('native-test');
  const agent = await f.inbox.resolve('native-test');
  await agent.whenIdle();
  for (const task of tasks) await f.completed(task.id);
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.content)).toEqual([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]]);
});

it('cold-restores paused A2A inputs from JSONL and resumes the original tasks with no credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-durable-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root });
  const tasks = [await first.send('one', { wakeup: false }), await first.send('two', { wakeup: false })];
  const original = await first.inbox.resolve('native-test');
  const ids = original.inbox.nextTurn.map(m => m.id);
  await first.inbox.pause('native-test');
  await first.bridge.dispose();
  const second = await boot({ root, backend: first.backend });
  const restored = await second.inbox.resolve('native-test');
  expect(restored.inbox.nextTurn.map(m => m.id)).toEqual(ids);
  expect(await second.inbox.wake('native-test')).toEqual([]);
  expect(second.adapter.requests).toHaveLength(0);
  const prepared: unknown[] = [];
  second.ctx.on('a2a/before-assembly', detail => { prepared.push(detail.requestHeaders); });
  await second.inbox.wake('native-test', { resume: true });
  await restored.whenIdle();
  for (const task of tasks) await second.completed(task.id);
  expect(prepared).toEqual([undefined, undefined]);
  expect(restored.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id)).toEqual(ids);
});

it('steers the active task at its next step while an ordinary message waits for another turn', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1 && detail.step === 1) await gate; return next(); });
  const first = await f.send('first');
  const agent = await f.inbox.resolve('native-test');
  await expect.poll(() => agent.status).toBe('running');
  const ordinary = await f.send('later');
  await f.send('steer', { target: 'next-step' }, first.id);
  release();
  await agent.whenIdle();
  await f.completed(first.id);
  await f.completed(ordinary.id);
  const seen: Array<[number, number, string]> = [];
  let turn = 0, step = 0;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'step/start') { turn = event.data.turn; step = event.data.step; }
    if (event.type === 'user/message') seen.push([turn, step, event.data.content[0].text]);
  }
  expect(seen).toEqual([[1, 1, 'first'], [1, 2, 'steer'], [2, 1, 'later']]);
});

it('requires extension negotiation and rejects inactive steering without losing queued inputs', async () => {
  const f = await boot();
  const first = await f.send('first', { wakeup: false });
  const malformed = await f.rpc('SendMessage', { message: { messageId: 'bad', contextId: 'native-test', taskId: first.id, role: 'ROLE_USER', parts: [{ text: 'bad' }], metadata: { [INBOX_EXTENSION]: { target: 'next-step' } } }, configuration: { returnImmediately: true } });
  expect(malformed.error).toBeDefined();
  const unnegotiated = await f.rpc('SendMessage', { message: { messageId: 'bad-header', role: 'ROLE_USER', parts: [{ text: 'bad' }], metadata: { [INBOX_EXTENSION]: { wakeup: false } } } }, false);
  expect(unnegotiated.error).toBeDefined();
  await f.inbox.wake('native-test');
  await (await f.inbox.resolve('native-test')).whenIdle();
  await f.completed(first.id);
});

it('keeps resubscriptions observing later turns on the same task after send clients detach', async () => {
  const f = await boot({ script: [textResponse('answer-one'), textResponse('answer-two')] });
  const first = await f.send('one', { wakeup: false });
  await f.send('two', { wakeup: false }, first.id);
  const subscription = await fetch(`http://127.0.0.1:${f.server.port}/a2a/`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: first.id } }),
  });
  expect(subscription.ok).toBe(true);
  const body = subscription.text();
  await f.inbox.wake('native-test');
  await (await f.inbox.resolve('native-test')).whenIdle();
  const text = await body;
  const events = text.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)).result);
  expect(events[0].task.id).toBe(first.id);
  const answers = new Map<string, string>();
  for (const event of events) {
    const update = event.statusUpdate;
    if (update?.metadata?.dshAgent?.kind !== 'text-content') continue;
    const message = update.status.message;
    answers.set(message.messageId, (answers.get(message.messageId) ?? '') + message.parts[0].text);
  }
  expect([...answers.values()]).toEqual(['answer-one', 'answer-two']);
  expect(events.at(-1).statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
});

it('keeps canceled task terminal while retained input resumes under a fresh task', async () => {
  const f = await boot();
  const task = await f.send('one', { wakeup: false });
  await f.inbox.cancel(task.id, { retainInbox: true });
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  expect(await f.inbox.wake('native-test')).toEqual([]);
  const ids = await f.inbox.wake('native-test', { resume: true });
  expect(ids).toHaveLength(1);
  expect(ids[0]).not.toBe(task.id);
  await (await f.inbox.resolve('native-test')).whenIdle();
  await f.completed(ids[0]);
  expect((await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  expect((await f.rpc('GetTask', { id: ids[0] })).result.history[0].referenceTaskIds).toContain(task.id);
});

it('rejects a failing admission observer only as telemetry and keeps successful input runnable', async () => {
  const f = await boot();
  f.ctx.on('a2a/message-admitted', () => { throw new Error('observer failed'); });
  f.ctx.on('a2a/inbox', () => { throw new Error('inbox observer failed'); });
  const task = await f.send('one', { wakeup: false });
  await f.inbox.wake('native-test');
  await (await f.inbox.resolve('native-test')).whenIdle();
  await f.completed(task.id);
  expect(f.adapter.requests).toHaveLength(1);
});

it('parks pending work on active pause and never restarts the canceled task', async () => {
  const f = await boot({ script: ['hang', textResponse('next')] });
  const active = await f.send('active');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const queued = await f.send('queued');
  await f.inbox.pause('native-test');
  await expect.poll(async () => (await f.rpc('GetTask', { id: active.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  expect(await f.inbox.wake('native-test')).toEqual([]);
  await f.inbox.wake('native-test', { resume: true });
  await (await f.inbox.resolve('native-test')).whenIdle();
  await f.completed(queued.id);
  expect(f.adapter.requests).toHaveLength(2);
  expect((await f.rpc('GetTask', { id: active.id })).result.status.state).toBe('TASK_STATE_CANCELED');
});

it('reports interrupted committed input after restart without replaying its model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-committed-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root, script: ['hang'] });
  const task = await first.send('committed');
  await expect.poll(() => first.adapter.requests.length).toBe(1);
  await first.bridge.dispose();
  const second = await boot({ root, backend: first.backend });
  await second.inbox.beforeTask(task.id, new ServerCallContext());
  await second.inbox.wake('native-test');
  await expect.poll(async () => (await second.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  expect(second.adapter.requests).toHaveLength(0);
});

it('rejects missing message IDs before admitting follow-ups', async () => {
  const f = await boot();
  const task = await f.send('one', { wakeup: false });
  const malformed = await f.rpc('SendMessage', { message: { taskId: task.id, role: 'ROLE_USER', parts: [{ text: 'phantom' }] } });
  expect(malformed.error).toBeDefined();
  const agent = await f.inbox.resolve('native-test');
  expect(agent.inbox.nextTurn).toHaveLength(1);
  await f.inbox.wake('native-test');
  await agent.whenIdle();
  await f.completed(task.id);
  expect(f.adapter.requests).toHaveLength(1);
});

it('cancels cold queued input before any wake or local task restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-cancel-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root });
  const task = await first.send('discard', { wakeup: false });
  await first.bridge.dispose();
  const second = await boot({ root, backend: first.backend });
  const canceled = await second.rpc('CancelTask', { id: task.id });
  expect(canceled.error).toBeUndefined();
  expect(canceled.result.status.state).toBe('TASK_STATE_CANCELED');
  expect(await second.inbox.wake('native-test', { resume: true })).toEqual([]);
  expect((await second.inbox.resolve('native-test')).inbox.nextTurn).toHaveLength(0);
  expect(second.adapter.requests).toHaveLength(0);
});

it('resumes retained steering separately from another queued task', async () => {
  const f = await boot({ script: ['hang', textResponse('steered'), textResponse('ordinary')] });
  const active = await f.send('active');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const ordinary = await f.send('ordinary');
  await f.send('steering', { target: 'next-step' }, active.id);
  await f.inbox.cancel(active.id, { retainInbox: true });
  const agent = await f.inbox.resolve('native-test');
  await agent.whenIdle();
  const resumed = await f.inbox.wake('native-test', { resume: true });
  await agent.whenIdle();
  for (const id of resumed) await f.completed(id);
  await f.completed(ordinary.id);
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.content[0].text)).toEqual(['active', 'steering', 'ordinary']);
  expect((await f.rpc('GetTask', { id: active.id })).result.status.state).toBe('TASK_STATE_CANCELED');
});

it('retains pending task identity when the core disposes before the bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-dispose-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root });
  const task = await first.send('retained', { wakeup: false });
  await first.ctx.fiber.dispose();
  const second = await boot({ root, backend: first.backend });
  await second.inbox.wake('native-test');
  await (await second.inbox.resolve('native-test')).whenIdle();
  await second.completed(task.id);
  expect(second.adapter.requests).toHaveLength(1);
});


it('inserts queued tasks during an active turn without consuming or duplicating them', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstRequest = false;
  f.ctx.on('agent/request', async (detail, next) => {
    if (detail.turn === 1 && detail.step === 1) { firstRequest = true; await gate; }
    return next();
  });
  const order: string[] = [];
  f.ctx.on('a2a/before-assembly', detail => { order.push(detail.a2aMessage.messageId); });
  try {
    const active = await f.send('active');
    await expect.poll(() => firstRequest).toBe(true);
    const queued = [await f.send('queued-one'), await f.send('queued-two')];
    const agent = await f.inbox.resolve('native-test');
    expect(new Set([active.id, ...queued.map(task => task.id)]).size).toBe(3);
    for (const task of queued) {
      expect((await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_SUBMITTED');
    }
    const nativeIds = agent.inbox.nextTurn.map(message => message.id);
    expect(nativeIds).toHaveLength(2);
    expect(order).toEqual(['active']);
    expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.content[0].text.startsWith('queued-'))).toEqual([]);
    release();
    await agent.whenIdle();
    for (const task of [active, ...queued]) await f.completed(task.id);
    expect(order).toEqual(['active', 'queued-one', 'queued-two']);
    const committed = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
    expect(committed.map(e => e.data.content[0].text)).toEqual(['active', 'queued-one', 'queued-two']);
    expect(committed.slice(1).map(e => e.data.id)).toEqual(nativeIds);
    expect(new Set(committed.map(e => e.data.id)).size).toBe(3);
    expect(agent.inbox.nextTurn).toHaveLength(0);
    expect(f.adapter.requests).toHaveLength(3);
  } finally {
    release();
  }
});

it('does not mint duplicate replacement tasks for concurrent resumes', async () => {
  const f = await boot();
  const canceled = await f.send('one', { wakeup: false });
  await f.inbox.cancel(canceled.id, { retainInbox: true });
  const resumed = await Promise.all([
    f.inbox.wake('native-test', { resume: true }),
    f.inbox.wake('native-test', { resume: true }),
  ]);
  await (await f.inbox.resolve('native-test')).whenIdle();
  const ids = [...new Set(resumed.flat())];
  expect(ids).toHaveLength(1);
  await f.completed(ids[0]);
  const tasks = await f.rpc('ListTasks', { contextId: 'native-test' });
  expect(tasks.result.tasks).toHaveLength(2);
  expect(f.adapter.requests).toHaveLength(1);
});

it('clears a cold durable inbox before resolving or waking its context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-clear-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root });
  await first.send('discard', { wakeup: false });
  await first.inbox.pause('native-test');
  await first.bridge.dispose();
  const second = await boot({ root, backend: first.backend });
  await second.bridge.clearContext('native-test');
  const restored = await second.inbox.resolve('native-test');
  expect(restored.inbox.nextTurn).toHaveLength(0);
  expect(await second.inbox.wake('native-test', { resume: true })).toEqual([]);
  expect(second.adapter.requests).toHaveLength(0);
});

it('continues independent queued tasks after a preparation failure', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let preparing = false;
  f.ctx.on('a2a/before-assembly', async detail => {
    if (detail.a2aMessage.messageId !== 'bad') return;
    preparing = true;
    await gate;
    throw new Error('preparation failed');
  });
  try {
    const bad = await f.send('bad');
    await expect.poll(() => preparing).toBe(true);
    const good = await f.send('good');
    release();
    await f.completed(good.id);
    expect((await f.rpc('GetTask', { id: bad.id })).result.status.state).toBe('TASK_STATE_FAILED');
    expect(f.adapter.requests).toHaveLength(1);
  } finally { release(); }
});

it('subscribes to a cold pending task before wake without executing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-subscribe-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root });
  const task = await first.send('one', { wakeup: false });
  await first.bridge.dispose();
  const second = await boot({ root, backend: first.backend });
  const subscription = await fetch(`http://127.0.0.1:${second.server.port}/a2a/`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: task.id } }),
  });
  const output = subscription.text();
  expect(second.adapter.requests).toHaveLength(0);
  await second.inbox.wake('native-test');
  await second.completed(task.id);
  const frames = (await output).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)).result);
  expect(frames.at(-1).statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
});

it('aborts active work promptly and awaits durable terminal cancellation before returning', async () => {
  const f = await boot({ script: ['hang'] });
  const task = await f.send('retained');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const agent = await f.inbox.resolve('native-test');
  const save = f.backend.save.bind(f.backend);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writing = false;
  f.backend.save = async (snapshot, context) => {
    if (snapshot.status?.state === 5) { writing = true; await gate; }
    return save(snapshot, context);
  };
  let returned = false;
  const canceled = f.inbox.cancel(task.id, { retainInbox: true }).then(() => { returned = true; });
  try {
    await expect.poll(() => writing).toBe(true);
    await expect.poll(() => agent.status).toBe('idle');
    expect(returned).toBe(false);
  } finally { release(); await canceled; }
});

it('persists completion when a legacy streaming send disconnects', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('a2a/before-assembly', () => gate);
  const abort = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${f.server.port}/a2a/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'message/stream', params: { message: { kind: 'message', messageId: 'legacy-disconnect', contextId: 'native-test', role: 'user', parts: [{ kind: 'text', text: 'one' }] } } }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const anchor = new TextDecoder().decode(first.value).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)).result).find(event => event.kind === 'task');
    expect(anchor).toBeDefined();
    abort.abort();
    await reader.cancel().catch(() => {});
    await f.rpc('GetTask', { id: anchor.id });
    release();
    await (await f.inbox.resolve('native-test')).whenIdle();
    await f.completed(anchor.id);
  } finally { abort.abort(); release(); }
});

it.each([false, true])('shares cancellation acknowledgment and retries failed persistence (failure=%s)', async fail => {
  const f = await boot();
  const task = await f.send('retained', { wakeup: false });
  const checkpoint = f.store.checkpoint.bind(f.store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  f.store.checkpoint = async (snapshot, context) => {
    if (snapshot.status?.state === 5) {
      entered = true;
      await gate;
      if (fail) throw new Error('checkpoint unavailable');
    }
    await checkpoint(snapshot, context);
  };
  const first = f.inbox.cancel(task.id, { retainInbox: true });
  await expect.poll(() => entered).toBe(true);
  let returned = false;
  const second = f.inbox.cancel(task.id, { retainInbox: true }).then(() => { returned = true; });
  const results = Promise.allSettled([first, second]);
  try {
    await f.rpc('GetTask', { id: task.id });
    expect(returned).toBe(false);
  } finally { release(); }
  expect((await results).map(result => result.status)).toEqual(fail ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled']);
  fail = false;
  await f.inbox.cancel(task.id, { retainInbox: true });
  expect((await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_CANCELED');
});

it('fails a committed task whose terminal checkpoint was lost without replaying its completed turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-terminal-gap-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await boot({ root });
  const task = await first.send('completed');
  await first.completed(task.id);
  await first.bridge.dispose();
  const context = new ServerCallContext();
  const snapshot = await first.backend.load(task.id, context);
  await first.backend.save({ ...snapshot!, status: { ...snapshot!.status!, state: 2 } }, context);
  const second = await boot({ root, backend: first.backend });
  await second.inbox.wake('native-test');
  await expect.poll(async () => (await second.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  expect(second.adapter.requests).toHaveLength(0);
});

it('joins a cancellation flush before shutdown can close its task backend', async () => {
  const f = await boot();
  const task = await f.send('retained', { wakeup: false });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let flushing = false;
  f.ctx.on('session/flush', async () => {
    if (flushing) return;
    flushing = true;
    await gate;
  });
  const canceled = f.inbox.cancel(task.id, { retainInbox: true });
  await expect.poll(() => flushing).toBe(true);
  let closed = false;
  const shutdown = f.inbox.shutdown().then(() => f.store.close()).then(() => { closed = true; });
  try {
    await f.rpc('GetTask', { id: task.id });
    expect(closed).toBe(false);
  } finally { release(); await Promise.all([canceled, shutdown]); }
});

it('keeps host follow-ups owned by their task while two settlement hooks wait', async () => {
  const f = await boot({ script: [textResponse('answer-A'), textResponse('answer-B'), textResponse('followup-A')] });
  let releaseA!: () => void;
  let releaseB!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; });
  const gateB = new Promise<void>(resolve => { releaseB = resolve; });
  const a = await f.send('A', { wakeup: false });
  const b = await f.send('B', { wakeup: false });
  const hooks: string[] = [];
  f.ctx.on('a2a/task-settlement', async detail => {
    hooks.push(detail.taskId);
    if (detail.taskId === a.id) {
      await gateA;
      await f.inbox.enqueue(a.id, Message.fromJSON({ messageId: 'host-A', role: 'ROLE_USER', parts: [{ text: 'followup' }] }));
    } else await gateB;
  });
  try {
    await f.inbox.wake('native-test');
    await expect.poll(() => hooks).toEqual([a.id, b.id]);
    releaseA();
    await f.completed(a.id);
    const task = (await f.rpc('GetTask', { id: a.id })).result;
    expect(task.status.message.parts[0].text).toBe('followup-A');
    expect((await f.rpc('GetTask', { id: b.id })).result.status.state).toBe('TASK_STATE_WORKING');
  } finally { releaseA(); releaseB(); }
});

it('does not expose rejected admission history and accepts a retry after a checkpoint failure', async () => {
  const f = await boot();
  const task = await f.send('one', { wakeup: false });
  const save = f.backend.save.bind(f.backend);
  let failed = false;
  f.backend.save = async (snapshot, context) => {
    if (!failed && snapshot.history.some(message => message.messageId === 'retry')) {
      failed = true;
      throw new Error('admission checkpoint failed');
    }
    await save(snapshot, context);
  };
  const rejected = await f.rpc('SendMessage', { message: { messageId: 'retry', taskId: task.id, role: 'ROLE_USER', parts: [{ text: 'retry' }], metadata: { [INBOX_EXTENSION]: { wakeup: false } } }, configuration: { returnImmediately: true } });
  expect(rejected.error).toBeDefined();
  const accepted = (await f.rpc('GetTask', { id: task.id })).result;
  expect(accepted.history.map(message => message.messageId)).toEqual(['one']);
  await f.send('retry', { wakeup: false }, task.id);
  await f.inbox.wake('native-test');
  const agent = await f.inbox.resolve('native-test');
  await agent.whenIdle();
  await f.completed(task.id);
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.content[0].text)).toEqual(['one', 'retry']);
});


it.each([true, false])('exports readable inbox lifecycle through the real SDK with captureContent=%s', async captureContent => {
  const captured: unknown[] = [];
  const collector = await startFakeIngestion(captured);
  cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
  const f = await boot({ langfuse: { enabled: true, publicKey: 'public-inbox-test', secretKey: 'secret-inbox-test', baseUrl: `http://127.0.0.1:${collector.address().port}`, captureContent } });
  const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
  f.ctx.on('a2a/before-assembly', async detail => {
    f.ctx.emit('langfuse/context', detail.contextId, { traceparent, userId: 'inbox-user' });
    const turn = detail.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').at(-1).data.turn;
    const hook = { turn, point: 'BeforeAgent', handlerId: 'prepare', invocationId: detail.dshMessageId };
    Langfuse.appendHookEvent(detail.agent.session, 'hook/invoked', { ...hook, dialect: 'test' });
    await new Promise(resolve => setTimeout(resolve, 20));
    Langfuse.appendHookEvent(detail.agent.session, 'hook/result', { ...hook, decision: 'pass', outcome: 'success', durationMs: 20 });
    if (detail.a2aMessage.messageId === 'failed') throw new Error('preparation failed');
  });
  const first = await f.send('first', { wakeup: false }, undefined, 'private-first');
  const failed = await f.send('failed', { wakeup: false }, undefined, 'private-failed');
  const second = await f.send('second', { wakeup: false }, undefined, 'private-second');
  const canceled = await f.send('canceled', { wakeup: false }, undefined, 'private-canceled');
  await f.inbox.pause('native-test');
  await f.inbox.cancel(canceled.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.inbox.wake('native-test', { resume: true });
  const agent = await f.inbox.resolve('native-test');
  await agent.whenIdle();
  await f.completed(first.id);
  await f.completed(second.id);
  expect((await f.rpc('GetTask', { id: failed.id })).result.status.state).toBe('TASK_STATE_FAILED');
  await f.ctx.parallel('session/flush', agent.session);
  const observations = capturedToObservations(captured);
  for (const phase of ['admitted', 'paused', 'canceled', 'resume', 'wait', 'prepare']) {
    expect(observations.some(observation => observation.name === `inbox:${phase}`)).toBe(true);
  }
  const roots = observations.filter(observation => observation.name === 'dsh-turn');
  expect(roots.map(root => root.metadata.taskId)).toEqual([first.id, failed.id, second.id]);
  expect(roots.every(root => root.parentObservationId === '2222222222222222')).toBe(true);
  expect(observations.filter(observation => observation.type === 'GENERATION')).toHaveLength(2);
  const waits = observations.filter(observation => observation.name === 'inbox:wait');
  expect(waits).toHaveLength(3);
  expect(waits.every(wait => Number(wait.metadata.waitMs) >= 20)).toBe(true);
  for (const wait of [...waits, ...observations.filter(observation => observation.name === 'inbox:prepare')]) {
    const raw = captured.find(span => span.spanId === wait.id);
    if (wait.name === 'inbox:prepare') {
      const parent = captured.find(span => span.spanId === wait.parentObservationId);
      expect(BigInt(parent.startTimeUnixNano)).toBeLessThanOrEqual(BigInt(raw.startTimeUnixNano));
    }
    expect(Number(BigInt(raw.endTimeUnixNano) - BigInt(raw.startTimeUnixNano)) / 1e6).toBeCloseTo(Number(wait.metadata.waitMs ?? wait.metadata.prepareMs), 0);
  }
  const hooks = observations.filter(observation => observation.name === 'hook:BeforeAgent');
  expect(hooks).toHaveLength(3);
  expect(hooks.every(hook => roots.some(root => root.id === hook.parentObservationId))).toBe(true);
  expect(observations.every(observation => observation.sessionId === 'native-test' && observation.endTime)).toBe(true);
  expect(JSON.stringify(captured)).not.toContain('secret-inbox-test');
  if (captureContent) {
    expect(waits.map(wait => wait.input)).toEqual(['private-first', 'private-failed', 'private-second']);
    expect(observations.find(observation => observation.name === 'inbox:admitted')?.output).toMatchObject({ state: 'admitted', pending: 1, target: 'next-turn', position: 1 });
    expect(waits.every(wait => wait.output?.state === 'selected')).toBe(true);
  } else {
    expect(JSON.stringify(captured)).not.toMatch(/private-first|private-second|private-canceled|private-failed/);
  }
});


it('exports recovered inbox identity and queue waiting across a durable restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-inbox-observability-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const captured: unknown[] = [];
  const collector = await startFakeIngestion(captured);
  cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
  const langfuseUrl = `http://127.0.0.1:${collector.address().port}`;
  const first = await boot({ root, langfuseUrl });
  const task = await first.send('restored-input', { wakeup: false });
  await first.inbox.pause('native-test');
  await first.bridge.dispose();
  await first.ctx.fiber.dispose();
  const second = await boot({ root, langfuseUrl, backend: first.backend });
  second.ctx.on('a2a/before-assembly', async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const agent = await second.inbox.resolve('native-test');
  await second.inbox.wake('native-test', { resume: true });
  await agent.whenIdle();
  await second.completed(task.id);
  await second.ctx.parallel('session/flush', agent.session);
  const observations = capturedToObservations(captured);
  expect(observations.find(observation => observation.name === 'inbox:restored')?.metadata).toMatchObject({ taskId: task.id, messageId: 'restored-input' });
  expect(observations.find(observation => observation.name === 'inbox:wait')?.metadata).toMatchObject({ taskId: task.id, messageId: 'restored-input' });
  const turn = observations.find(observation => observation.name === 'dsh-turn');
  expect(turn.metadata.taskId).toBe(task.id);
  const preparation = captured.find(span => span.name === 'inbox:prepare');
  const parent = captured.find(span => span.spanId === turn.id);
  expect(BigInt(parent.startTimeUnixNano)).toBeLessThanOrEqual(BigInt(preparation.startTimeUnixNano));
  expect(BigInt(parent.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(preparation.endTimeUnixNano));
  expect(Number(BigInt(preparation.endTimeUnixNano) - BigInt(preparation.startTimeUnixNano)) / 1e6).toBeGreaterThanOrEqual(20);
});


it('discovers inbox waits and scripted generations through the Langfuse read-back API', async () => {
  const queries: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const query = new URL(request.url!, 'http://localhost').searchParams;
    queries.push(query);
    const name = query.get('name') ?? 'llm-call';
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: [{ id: 'observation', traceId: 'trace', name, metadata: { messageId: 'inbox-api-marker' } }],
      meta: { totalPages: 1 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const observationName of [undefined, 'inbox:wait']) {
    const result = await runVerification({ baseUrl, publicKey: 'test-public', secretKey: 'test-secret',
      fromStartTime: new Date(0).toISOString(), toStartTime: new Date().toISOString(),
      codeword: 'inbox-api-marker', model: 'mock', observationName,
      evaluate: observations => observations.length === 1 ? [] : ['missing observation'],
    });
    expect(result.ok, result.state).toBe(true);
  }
  expect(queries[0].get('model')).toBe('mock');
  expect(queries[0].get('type')).toBe('GENERATION');
  expect(queries[2].get('name')).toBe('inbox:wait');
  expect(queries[2].has('model')).toBe(false);
});

it.skipIf(process.env.DSH_INBOX_LANGFUSE_LIVE !== 'true')('persists searchable inbox traces in the real Langfuse project', async () => {
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
  expect(publicKey && secretKey && baseUrl, 'Live inbox verification requires LANGFUSE_* credentials and URL').toBeTruthy();
  const runId = process.env.GITHUB_RUN_ID ?? Date.now().toString();
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const contextId = `ci-inbox-${runId}-${attempt}-${randomUUID()}`;
  const fromStartTime = new Date(Date.now() - 60_000).toISOString();
  const replies = ['发布前检查待办：\n1. 构建项目\n2. 运行测试\n3. 检查发布说明', '按补充要求调整：\n1. 运行测试\n2. 构建项目'];
  const f = await boot({ contextId, script: replies.map(reply => textResponse(reply)), langfuse: { enabled: true, publicKey, secretKey, baseUrl,
    traceName: 'dsh-inbox', captureContent: true, environment: 'ci',
    release: process.env.GITHUB_SHA ?? 'local',
    tags: ['ci', 'scenario:inbox', `run:${runId}`, `attempt:${attempt}`],
  } });
  const inputs = [`${contextId}-first`, `${contextId}-second`];
  const prompts = [
    `请为发布前检查列出三项待办：构建、测试、检查发布说明。先不要执行命令。\n测试编号：${inputs[0]}`,
    `补充上一条要求：只保留构建和测试，并把测试排在第一位。\n测试编号：${inputs[1]}`,
  ];
  const tasks = [];
  for (const [index, input] of inputs.entries()) tasks.push(await f.send(input, { wakeup: false }, undefined, prompts[index]));
  const canceled = await f.send(`${contextId}-canceled`, { wakeup: false }, undefined, '这条排队输入将在执行前取消，不应进入模型请求。');
  await f.inbox.pause(contextId);
  await f.inbox.cancel(canceled.id);
  await f.inbox.wake(contextId, { resume: true });
  const agent = await f.inbox.resolve(contextId);
  await agent.whenIdle();
  for (const task of tasks) await f.completed(task.id);
  await f.ctx.parallel('session/flush', agent.session);
  const toStartTime = new Date(Date.now() + 60_000).toISOString();
  await Promise.all(inputs.flatMap((codeword, index) => [undefined, 'inbox:wait'].map(async observationName => {
      const result = await runVerification({ baseUrl, publicKey, secretKey, fromStartTime, toStartTime,
        codeword, model: 'mock', observationName,
        evaluate(observations) {
          const root = observations.find(observation => observation.name === (observationName ?? 'dsh-inbox'));
          const problems = [];
          if (!root?.endTime || root.metadata?.taskId !== tasks[index].id) problems.push('missing ended task-attributed root');
          if (observationName) {
            const waitMs = Number(root?.metadata?.waitMs);
            if (root?.input !== prompts[index]) problems.push('missing readable queue input');
            if (root?.output?.state !== 'selected') problems.push('missing queue selection outcome');
            if (root?.metadata?.target !== 'next-turn') problems.push('missing queue target');
            if (root?.metadata?.messageId !== codeword || !Number.isFinite(waitMs) || waitMs < 0) problems.push('missing queue identity/timing');
          } else {
            if (root?.input !== prompts[index] || root?.output !== replies[index]) problems.push('missing readable turn conversation');
            if (!observations.some(observation => observation.name === 'inbox:prepare' && observation.parentObservationId === root?.id)) problems.push('missing preparation child');
            if (!observations.some(observation => observation.type === 'GENERATION' && observation.parentObservationId === root?.id)) problems.push('missing generation child');
          }
          return problems;
        },
      });
      expect(result.ok, result.state).toBe(true);
      console.log(`Langfuse inbox ${contextId}: ${result.state}`);
  })));
}, 6 * 60_000);
