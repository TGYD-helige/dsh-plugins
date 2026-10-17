/** Real loop, A2A HTTP, and JSONL restart; only model responses are scripted. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
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
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
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
const { Message, TaskState } = await import(pathToFileURL(require.resolve('@a2a-js/sdk')).href);
const { ServerCallContext } = await import(pathToFileURL(require.resolve('@a2a-js/sdk/server')).href);
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
function textResponse(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }, { type: 'finish', reason: { kind: 'stop' } }];
}
class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private script: Array<StreamChunk[] | 'hang'>) { super(); }
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const reply = this.script.shift();
    if (reply === 'hang') {
      await new Promise<void>((_, reject) => {
        const abort = () => reject(new Error('aborted'));
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    } else {
      if (!reply) throw new Error('Script exhausted');
      for (const chunk of reply) { options.signal?.throwIfAborted(); yield chunk; }
    }
  }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });

async function boot(options: { root?: string; store?: SanitizedTaskStore; backend?: MemoryTaskStore; script?: Array<StreamChunk[] | 'hang'>; langfuseUrl?: string; langfuse?: Langfuse.LangfusePluginConfig; contextId?: string } = {}) {
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

it('uses the official published DSH queue without a capability patch', async () => {
  const f = await boot();
  const first = await f.send('first');
  await f.completed(first.id);
  expect(f.adapter.requests).toHaveLength(1);
});

it.each([true, false])('records steering in the active turn while ordinary input waits with captureContent=%s', async captureContent => {
  const captured: unknown[] = [];
  const collector = await startFakeIngestion(captured);
  cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
  const f = await boot({ langfuse: { enabled: true, publicKey: 'public-inbox-test', secretKey: 'secret-inbox-test', baseUrl: `http://127.0.0.1:${collector.address().port}`, captureContent } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1 && detail.step === 1) await gate; return next(); });
  const first = await f.send('first');
  const agent = await f.inbox.resolve('native-test');
  await expect.poll(() => agent.status).toBe('running');
  const ordinary = await f.send('later');
  const steeringText = 'Do not publish; only build and test';
  try {
    await f.send('steer', { target: 'next-step' }, first.id, steeringText);
  } finally { release(); }
  await agent.whenIdle();
  await f.completed(first.id);
  await f.completed(ordinary.id);
  const seen: Array<[number, number, string]> = [];
  let turn = 0, step = 0;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'step/start') { turn = event.data.turn; step = event.data.step; }
    if (event.type === 'user/message') seen.push([turn, step, event.data.content[0].text]);
  }
  expect(seen).toEqual([[1, 1, 'first'], [1, 2, steeringText], [2, 1, 'later']]);
  await f.ctx.parallel('session/flush', agent.session);
  const observations = capturedToObservations(captured);
  const roots = observations.filter(observation => observation.name === 'a2a-task');
  expect(roots).toHaveLength(2);
  expect(observations.some(observation => observation.name === 'inbox:wait')).toBe(false);
  const steering = observations.find(observation => observation.name === 'inbox:steering');
  expect(steering.metadata).toMatchObject({ taskId: first.id, messageId: 'steer', target: 'next-step', turn: '1', step: '2' });
  const turnSpan = observations.find(observation => observation.name === 'agent:turn' && observation.metadata.taskId === first.id);
  expect(turnSpan.parentObservationId).toBe(roots.find(root => root.metadata.taskId === first.id).id);
  expect(steering.parentObservationId).toBe(turnSpan.id);
  expect(steering.input).toBe(captureContent ? steeringText : undefined);
  expect(Number(steering.metadata.waitMs)).toBeGreaterThanOrEqual(0);
  if (!captureContent) expect(JSON.stringify(captured)).not.toContain(steeringText);

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
  f.ctx.on('a2a/before-step', detail => { order.push(detail.a2aMessage.messageId); });
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

it('persists completion when a legacy streaming send disconnects', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('a2a/before-step', () => gate);
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

it('rediscovers late inbox traces and filters admissions through the Langfuse read-back API', async () => {
  const queries: URLSearchParams[] = [];
  let discovered = false;
  const server = createServer((request, response) => {
    const query = new URL(request.url!, 'http://localhost').searchParams;
    queries.push(query);
    const name = query.get('name') ?? 'llm-call';
    const traceId = query.get('traceId') ?? (discovered ? 'trace' : 'later-turn');
    if (!query.has('traceId')) discovered = true;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      data: [{ id: 'observation', traceId, name, metadata: { messageId: 'inbox-api-marker' } }],
      meta: { totalPages: 1 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const observationName of [undefined, 'inbox:admitted']) {
    const result = await runVerification({ baseUrl, publicKey: 'test-public', secretKey: 'test-secret',
      fromStartTime: new Date(0).toISOString(), toStartTime: new Date().toISOString(),
      codeword: 'inbox-api-marker', model: 'mock', observationName,
      evaluate: observations => observations.length === 1 && observations[0].traceId === 'trace' ? [] : ['waiting for the original turn'],
    });
    expect(result.ok, result.state).toBe(true);
  }
  expect(queries[0].get('model')).toBe('mock');
  expect(queries[0].get('type')).toBe('GENERATION');
  expect(queries.filter(query => query.get('model') === 'mock')).toHaveLength(2);
  expect(queries.find(query => query.get('name') === 'inbox:admitted')?.has('model')).toBe(false);
}, 25_000);

it('drains parked official inbox input on a real waking send in FIFO order', async () => {
  const f = await boot();
  const first = await f.send('one', { wakeup: false });
  const second = await f.send('two', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  expect(f.adapter.requests).toHaveLength(0);
  const ids = agent.inbox.nextTurn.map(message => message.id);
  const third = await f.send('three');
  for (const task of [first, second, third]) await f.completed(task.id);
  const messages = agent.session.snapshotEvents().filter(event => event.type === 'user/message');
  expect(messages.map(event => event.data.content[0].text)).toEqual(['one', 'two', 'three']);
  expect(messages.slice(0, 2).map(event => event.data.id)).toEqual(ids);
});

it('requires negotiated extension controls and rejects steering without an active task', async () => {
  const f = await boot();
  const task = await f.send('parked', { wakeup: false });
  const inactive = await f.rpc('SendMessage', { message: { messageId: 'steer', taskId: task.id, role: 'ROLE_USER', parts: [{ text: 'steer' }], metadata: { [INBOX_EXTENSION]: { target: 'next-step' } } }, configuration: { returnImmediately: true } });
  expect(inactive.error).toBeDefined();
  const unnegotiated = await f.rpc('SendMessage', { message: { messageId: 'unnegotiated', role: 'ROLE_USER', parts: [{ text: 'bad' }], metadata: { [INBOX_EXTENSION]: { wakeup: false } } } }, false);
  expect(unnegotiated.error).toBeDefined();
  const trigger = await f.send('trigger');
  await f.completed(task.id); await f.completed(trigger.id);
});

it('keeps CancelTask terminal and removes only its queued input', async () => {
  const f = await boot();
  const canceled = await f.send('cancel-me', { wakeup: false });
  const other = await f.send('keep-me', { wakeup: false });
  const result = await f.rpc('CancelTask', { id: canceled.id });
  expect(result.error).toBeUndefined();
  expect(result.result.status.state).toBe('TASK_STATE_CANCELED');
  const retry = await f.rpc('SendMessage', { message: { messageId: 'retry', taskId: canceled.id, role: 'ROLE_USER', parts: [{ text: 'retry' }] } });
  expect(retry.error).toBeDefined();
  const trigger = await f.send('new-task');
  await f.completed(other.id); await f.completed(trigger.id);
  const agent = await f.inbox.resolve('native-test');
  expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.content[0].text)).toEqual(['keep-me', 'new-task']);
});

it('preserves other queued tasks when canceling an active task using the official API', async () => {
  const f = await boot({ script: ['hang', textResponse('other'), textResponse('new')] });
  const active = await f.send('active');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const other = await f.send('other');
  expect((await f.rpc('CancelTask', { id: active.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  const agent = await f.inbox.resolve('native-test');
  await agent.whenIdle();
  expect(agent.inbox.nextTurn).toHaveLength(1);
  expect((await f.rpc('GetTask', { id: other.id })).result.status.state).toBe('TASK_STATE_SUBMITTED');
  const next = await f.send('next');
  await f.completed(other.id); await f.completed(next.id);
  expect((await f.rpc('GetTask', { id: active.id })).result.status.state).toBe('TASK_STATE_CANCELED');
});

it('keeps multiple turns and resubscription inside one standard A2A task', async () => {
  const f = await boot({ script: [textResponse('answer-one'), textResponse('answer-two')] });
  const task = await f.send('one', { wakeup: false });
  const subscription = await fetch(`http://127.0.0.1:${f.server.port}/a2a/`, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: task.id } }) });
  const output = subscription.text();
  await f.send('two', {}, task.id);
  await f.completed(task.id);
  const events = (await output).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)).result);
  expect(events.at(-1).statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
  expect((await f.rpc('GetTask', { id: task.id })).result.status.message.parts[0].text).toBe('answer-two');
  expect(f.adapter.requests).toHaveLength(2);
});

it('runs preparation at the official pre-step boundary after system-prompt assembly', async () => {
  const f = await boot();
  const order: string[] = [];
  const assemble = f.ctx.systemPrompt.assemble.bind(f.ctx.systemPrompt);
  f.ctx.systemPrompt.assemble = async (...args) => { order.push('assemble'); return assemble(...args); };
  f.ctx.on('a2a/before-step', () => { order.push('prepare'); });
  const task = await f.send('one');
  await f.completed(task.id);
  expect(order.slice(0, 2)).toEqual(['assemble', 'prepare']);
});

it('fails a claimed task if official prompt assembly fails before pre-step', async () => {
  const f = await boot();
  const assemble = f.ctx.systemPrompt.assemble.bind(f.ctx.systemPrompt);
  f.ctx.systemPrompt.assemble = async () => { throw new Error('assembly failed'); };
  const task = await f.send('bad');
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  f.ctx.systemPrompt.assemble = assemble;
  const next = await f.send('next');
  await f.completed(next.id);
  expect(f.adapter.requests).toHaveLength(1);
});

it('nests assembly-time hooks under the claimed task even if assembly fails', async () => {
  const captured: unknown[] = [];
  const collector = await startFakeIngestion(captured);
  cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
  const f = await boot({ langfuseUrl: `http://127.0.0.1:${collector.address().port}` });
  f.ctx.systemPrompt.assemble = async () => {
    const agent = await f.inbox.resolve('native-test');
    const hook = { turn: 1, point: 'BeforeAgent', handlerId: 'assembly', invocationId: 'assembly-1' };
    Langfuse.appendHookEvent(agent.session, 'hook/invoked', { ...hook, dialect: 'test' });
    Langfuse.appendHookEvent(agent.session, 'hook/result', { ...hook, decision: 'pass', outcome: 'success', durationMs: 0 });
    throw new Error('assembly failed');
  };
  const task = await f.send('one');
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  const agent = await f.inbox.resolve('native-test');
  await f.ctx.parallel('session/flush', agent.session);
  const observations = capturedToObservations(captured);
  const root = observations.find(observation => observation.name === 'a2a-task');
  const turn = observations.find(observation => observation.name === 'agent:turn');
  const hook = observations.find(observation => observation.name === 'hook:BeforeAgent');
  expect(root.metadata.taskState).toBe('failed');
  expect(turn.parentObservationId).toBe(root.id);
  expect(hook.parentObservationId).toBe(turn.id);
  expect(observations.every(observation => observation.endTime)).toBe(true);
});

it('restores official pending ownership before concurrent waking sends after a crash snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'official-inbox-snapshot-'));
  const restoredRoot = root + '-restored';
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => rm(restoredRoot, { recursive: true, force: true }));
  const first = await boot({ root });
  const tasks = [await first.send('one', { wakeup: false }), await first.send('two', { wakeup: false })];
  const original = await first.inbox.resolve('native-test');
  const ids = original.inbox.nextTurn.map(message => message.id);
  const canceled = await first.send('canceled-before-crash', { wakeup: false });
  await first.ctx.parallel('session/flush', original.session);
  await cp(root, restoredRoot, { recursive: true });
  const backend = new MemoryTaskStore();
  for (const task of tasks) await backend.save(await first.store.load(task.id, new ServerCallContext()), new ServerCallContext());
  const terminal = await first.store.load(canceled.id, new ServerCallContext());
  terminal.status.state = TaskState.TASK_STATE_CANCELED;
  await backend.save(terminal, new ServerCallContext());
  await first.bridge.dispose();
  const second = await boot({ root: restoredRoot, backend });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const load = backend.load.bind(backend);
  let loading = false;
  backend.load = async (...args) => {
    if (args[0] === tasks[0].id && !loading) { loading = true; await gate; }
    return load(...args);
  };
  let restoredIds: string[] = [];
  let claimed = 0;
  second.ctx.on('agent/created', ({ agent }) => { restoredIds = agent.inbox.nextTurn.map(message => message.id); });
  second.ctx.on('agent/inbox/claimed', () => { claimed++; });
  const restoring = second.inbox.resolve('native-test');
  await expect.poll(() => loading).toBe(true);
  const sending = second.send('trigger');
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(claimed).toBe(0);
  } finally { release(); }
  const agent = await restoring;
  const trigger = await sending;
  expect(restoredIds.slice(0, 2)).toEqual(ids);
  expect(restoredIds).toHaveLength(3);
  expect((await second.rpc('GetTask', { id: canceled.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  for (const task of [...tasks, trigger]) await second.completed(task.id);
  const messages = agent.session.snapshotEvents().filter(event => event.type === 'user/message');
  expect(messages.map(event => event.data.content[0].text)).toEqual(['one', 'two', 'trigger']);
  expect(messages.slice(0, 2).map(event => event.data.id)).toEqual(ids);
});

it('reports a cold interrupted task as failed without replaying consumed input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'official-inbox-interrupted-'));
  const restoredRoot = root + '-restored';
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => rm(restoredRoot, { recursive: true, force: true }));
  const first = await boot({ root, script: ['hang'] });
  const task = await first.send('committed');
  await expect.poll(() => first.adapter.requests.length).toBe(1);
  const agent = await first.inbox.resolve('native-test');
  await first.ctx.parallel('session/flush', agent.session);
  await cp(root, restoredRoot, { recursive: true });
  const backend = new MemoryTaskStore();
  await backend.save(await first.store.load(task.id, new ServerCallContext()), new ServerCallContext());
  await first.bridge.dispose();
  const second = await boot({ root: restoredRoot, backend });
  const subscription = await fetch(`http://127.0.0.1:${second.server.port}/a2a/`, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: task.id } }) });
  await subscription.body?.cancel();
  await expect.poll(async () => (await second.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  expect(second.adapter.requests).toHaveLength(0);
});

it('fails the whole task when its first accepted turn fails with more owned input queued', async () => {
  const f = await boot();
  const task = await f.send('bad', { wakeup: false });
  await f.send('same-task-pending', { wakeup: false }, task.id);
  f.ctx.on('a2a/before-step', detail => { if (detail.a2aMessage.messageId === 'bad') throw new Error('prepare failed'); });
  const trigger = await f.send('different-task-trigger');
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  const agent = await f.inbox.resolve('native-test');
  expect(agent.inbox.nextTurn.map(message => message.source.taskId)).not.toContain(task.id);
  expect((await f.rpc('GetTask', { id: trigger.id })).result.status.state).toBe('TASK_STATE_SUBMITTED');
  expect(f.adapter.requests).toHaveLength(0);
});

it('preserves official tool additionalContexts in the active task', async () => {
  const call: StreamChunk[] = [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'context-call', name: 'context', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } }];
  const f = await boot({ script: [call, textResponse('done')] });
  f.ctx.tools.register(defineTool({ name: 'context', description: 'Provide context', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'tool result' }));
  f.ctx.on('tools/execute', async (_exec, next) => ({ ...await next(), additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'official tool context' }], source: { kind: 'user' } })] }));
  const task = await f.send('use context');
  await f.completed(task.id);
  expect(f.adapter.requests).toHaveLength(2);
  expect(JSON.stringify(f.adapter.requests[1])).toContain('official tool context');
});

it('cancels active continuation and discards owned queued input after settlement failure', async () => {
  const f = await boot({ script: [textResponse('one'), 'hang', textResponse('must not run')] });
  let reject!: () => void;
  const gate = new Promise<void>(resolve => { reject = resolve; });
  f.ctx.on('a2a/task-settlement', async () => { await gate; throw new Error('settlement failed'); });
  const task = await f.send('one', { wakeup: false });
  await f.send('active-continuation', {}, task.id);
  await expect.poll(() => f.adapter.requests.length).toBe(2);
  await f.send('future-continuation', { wakeup: false }, task.id);
  reject();
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  const agent = await f.inbox.resolve('native-test');
  await expect.poll(() => agent.status).toBe('idle');
  expect(agent.inbox.nextTurn).toHaveLength(0);
  expect(f.adapter.requests).toHaveLength(2);
});

it('clears pending input and terminates its protocol task while idle', async () => {
  const f = await boot();
  const task = await f.send('clear-me', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  await f.inbox.clear('native-test');
  expect(agent.inbox.nextTurn).toHaveLength(0);
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  expect(f.adapter.requests).toHaveLength(0);
});

it.each([true, false])('exports one full task lifecycle with official DSH and captureContent=%s', async captureContent => {
  const captured: unknown[] = [];
  const collector = await startFakeIngestion(captured);
  cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
  const f = await boot({ langfuse: { enabled: true, publicKey: 'public-inbox-test', secretKey: 'secret-inbox-test', baseUrl: `http://127.0.0.1:${collector.address().port}`, captureContent } });
  const assemble = f.ctx.systemPrompt.assemble.bind(f.ctx.systemPrompt);
  f.ctx.systemPrompt.assemble = async (...args) => { await new Promise(resolve => setTimeout(resolve, 20)); return assemble(...args); };
  const first = await f.send('first', { wakeup: false }, undefined, 'private-first');
  const canceled = await f.send('canceled', { wakeup: false }, undefined, 'private-canceled');
  await f.rpc('CancelTask', { id: canceled.id });
  await f.send('second', {}, first.id, 'private-second');
  await f.completed(first.id);
  const agent = await f.inbox.resolve('native-test');
  await f.ctx.parallel('session/flush', agent.session);
  const observations = capturedToObservations(captured);
  const roots = observations.filter(observation => observation.name === 'a2a-task');
  expect(roots).toHaveLength(2);
  const complete = roots.find(root => root.metadata.taskId === first.id);
  expect(complete.metadata.taskState).toBe('completed');
  const preparation = observations.find(observation => observation.name === 'inbox:prepare');
  expect(preparation.metadata.waitMs).toBe(complete.metadata.waitMs);
  expect(Number(preparation.metadata.prepareMs)).toBeGreaterThanOrEqual(20);
  const turns = observations.filter(observation => observation.name === 'agent:turn');
  expect(turns).toHaveLength(2);
  expect(turns.every(turn => turn.parentObservationId === complete.id && turn.traceId === complete.traceId)).toBe(true);
  expect(observations.filter(observation => observation.type === 'GENERATION').every(generation => turns.some(turn => turn.id === generation.parentObservationId))).toBe(true);
  const canceledRoot = roots.find(root => root.metadata.taskId === canceled.id);
  expect(canceledRoot.metadata.taskState).toBe('canceled');
  expect(observations.filter(observation => observation.parentObservationId === canceledRoot.id).map(observation => observation.name)).toEqual(['inbox:admitted', 'inbox:canceled']);
  expect(observations.every(observation => observation.endTime)).toBe(true);
  expect(observations.some(observation => observation.name === 'inbox:wait')).toBe(false);
  if (captureContent) expect(complete.input).toBe('private-first');
  else expect(JSON.stringify(captured)).not.toMatch(/private-first|private-second|private-canceled/);
});

it.skipIf(process.env.DSH_INBOX_LANGFUSE_LIVE !== 'true')('persists searchable inbox traces in the real Langfuse project', async () => {
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
  expect(publicKey && secretKey && baseUrl, 'Live inbox verification requires LANGFUSE_* credentials and URL').toBeTruthy();
  const runId = process.env.GITHUB_RUN_ID ?? Date.now().toString();
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const contextId = `ci-inbox-${runId}-${attempt}-${randomUUID()}`;
  const fromStartTime = new Date(Date.now() - 60_000).toISOString();
  const replies = ['发布前检查待办：\n1. 构建项目\n2. 运行测试\n3. 检查发布说明', '已遵循运行中的引导：只列构建和测试，不执行发布。\n1. 构建项目\n2. 运行测试', '按补充要求调整：\n1. 运行测试\n2. 构建项目'];
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
  const tasks = [await f.send(inputs[0], { wakeup: false }, undefined, prompts[0])];
  const canceled = await f.send(`${contextId}-canceled`, { wakeup: false }, undefined, '这条排队输入将在执行前取消，不应进入模型请求。');
  await f.inbox.cancel(canceled.id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  f.ctx.on('agent/request', async (detail, next) => {
    if (detail.turn === 1 && detail.step === 1) { requested = true; await gate; }
    return next();
  });
  const steeringId = `${contextId}-steering`;
  const steeringText = `运行中引导：不要发布，只保留构建和测试；当前任务继续，不另起一轮。\n测试编号：${steeringId}`;
  const agent = await f.inbox.resolve(contextId);
  try {
    tasks.push(await f.send(inputs[1], {}, undefined, prompts[1]));
    await expect.poll(() => requested).toBe(true);
    await f.send(steeringId, { target: 'next-step' }, tasks[0].id, steeringText);
  } finally { release(); }
  await agent.whenIdle();
  for (const task of tasks) await f.completed(task.id);
  await f.ctx.parallel('session/flush', agent.session);
  const toStartTime = new Date(Date.now() + 60_000).toISOString();
  await Promise.all(inputs.map(async (codeword, index) => {
    const result = await runVerification({ baseUrl, publicKey, secretKey, fromStartTime, toStartTime,
      codeword, model: 'mock',
      evaluate(observations) {
        const root = observations.find(observation => observation.name === 'dsh-inbox');
        const problems = [];
        if (!root?.endTime || root.metadata?.taskId !== tasks[index].id) problems.push('missing ended task-attributed root');
        const waitMs = Number(root?.metadata?.waitMs);
        if (!Number.isFinite(waitMs) || waitMs < 0) problems.push('missing queue wait on execution root');
        if (root?.input !== prompts[index] || root?.output !== replies[index + 1]) problems.push('missing readable turn conversation');
        const turn = observations.find(observation => observation.name === 'agent:turn' && observation.parentObservationId === root?.id);
        if (!turn?.endTime || root?.metadata?.taskState !== 'completed') problems.push('missing completed lifecycle and ended turn');
        for (const phase of ['admitted', 'completed']) {
          if (!observations.some(observation => observation.name === `inbox:${phase}` && observation.parentObservationId === root?.id)) problems.push(`missing task child ${phase}`);
        }
        if (!observations.some(observation => observation.name === 'inbox:prepare' && observation.parentObservationId === turn?.id)) problems.push('missing preparation child');
        const generations = observations.filter(observation => observation.type === 'GENERATION' && observation.parentObservationId === turn?.id);
        if (generations.length !== (index === 0 ? 2 : 1)) problems.push('wrong number of model steps');
        const steering = observations.find(observation => observation.name === 'inbox:steering');
        if (index === 0) {
          if (!steering?.endTime || steering.parentObservationId !== turn?.id || steering.input !== steeringText ||
            steering.metadata?.taskId !== tasks[0].id || steering.metadata?.messageId !== steeringId ||
            steering.metadata?.target !== 'next-step' || Number(steering.metadata?.turn) !== 1 || Number(steering.metadata?.step) !== 2) problems.push('missing steering content/ownership/application step');
          if (!generations.some(generation => JSON.stringify(generation.input ?? '').includes(steeringId))) problems.push('steering never reached the model request');
        } else if (steering) problems.push('steering leaked into the next turn');
        return problems;
      },
    });
    expect(result.ok, result.state).toBe(true);
    console.log(`Langfuse inbox ${contextId}: ${result.state}`);
  }));
  const cancellation = await runVerification({ baseUrl, publicKey, secretKey, fromStartTime, toStartTime, codeword: canceled.id, observationName: 'inbox:canceled',
    evaluate(observations) {
      const root = observations.find(observation => observation.name === 'dsh-inbox' && observation.metadata?.taskId === canceled.id);
      const phases = observations.filter(observation => observation.parentObservationId === root?.id).map(observation => observation.name);
      return root?.endTime && root.metadata?.taskState === 'canceled' && ['inbox:admitted', 'inbox:canceled'].every(phase => phases.includes(phase)) && !observations.some(observation => observation.type === 'GENERATION' || observation.name === 'agent:turn') ? [] : ['missing complete queued cancellation lifecycle'];
    },
  });
  expect(cancellation.ok, cancellation.state).toBe(true);
  console.log(`Langfuse canceled inbox ${contextId}: ${cancellation.state}`);
}, 6 * 60_000);
