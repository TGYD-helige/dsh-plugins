/** Real loop, A2A HTTP, and JSONL restart; only model responses are scripted. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import * as A2aPlugin from '../../../packages/dsh-a2a/src/index.js';
import { freePort } from './lib/a2a-shared.mjs';
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
  constructor(private script: Array<StreamChunk[] | 'hang' | (() => StreamChunk[])>) { super(); }
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
      for (const chunk of typeof reply === 'function' ? reply() : reply) { options.signal?.throwIfAborted(); yield chunk; }
    }
  }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); });

async function boot(options: { root?: string; store?: SanitizedTaskStore; backend?: MemoryTaskStore; script?: Array<StreamChunk[] | 'hang' | (() => StreamChunk[])>; langfuseUrl?: string; langfuse?: Langfuse.LangfusePluginConfig; contextId?: string } = {}) {
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
  const completed = async (id: string) => { await expect.poll(async () => (await rpc('GetTask', { id })).result.status.state, { timeout: options.langfuse && process.env.DSH_ISSUE75_LANGFUSE_LIVE === 'true' ? 15_000 : 1_000 }).toBe('TASK_STATE_COMPLETED'); };
  return { ctx, adapter, bridge, inbox, store, backend, server, rpc, send, completed };
}

it('removes failed admission input from the official queue after a flush error', async () => {
  const f = await boot();
  const agent = await f.inbox.resolve('native-test');
  let failFlush = true;
  f.ctx.on('session/flush', () => {
    if (failFlush && agent.inbox.nextTurn.length) {
      failFlush = false;
      throw new Error('admission checkpoint failed');
    }
  });
  const task = await f.send('failed-admission', { wakeup: false });
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  expect(agent.inbox.nextTurn).toHaveLength(0);
  const next = await f.send('next');
  await f.completed(next.id);
  expect(f.adapter.requests).toHaveLength(1);
  expect(JSON.stringify(f.adapter.requests[0])).not.toContain('failed-admission');
});

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

it('fails every consumed task owner if a recovered mixed batch fails before pre-step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'official-inbox-mixed-'));
  const restoredRoot = root + '-restored';
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  cleanups.push(() => rm(restoredRoot, { recursive: true, force: true }));
  const first = await boot({ root, script: ['hang'] });
  const active = await first.send('active');
  await expect.poll(() => first.adapter.requests.length).toBe(1);
  await first.send('steering', { target: 'next-step' }, active.id);
  const ordinary = await first.send('ordinary', { wakeup: false });
  const original = await first.inbox.resolve('native-test');
  await first.ctx.parallel('session/flush', original.session);
  await cp(root, restoredRoot, { recursive: true });
  const backend = new MemoryTaskStore();
  for (const task of [active, ordinary]) await backend.save(await first.store.load(task.id, new ServerCallContext()), new ServerCallContext());
  await first.bridge.dispose();
  const second = await boot({ root: restoredRoot, backend });
  second.ctx.systemPrompt.assemble = async () => { throw new Error('assembly failed'); };
  await second.send('trigger');
  for (const task of [active, ordinary]) await expect.poll(async () => (await second.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  expect(second.adapter.requests).toHaveLength(0);
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

describe('issue-75 native ownership', () => {
it('keeps the original task stream open for reserved Goal continuations', async () => {
  const f = await boot({ script: [
    () => {
      const agent = f.ctx.agents.get('native-test')!;
      f.ctx.goals.create(agent, { objective: 'finish the job', maxGoalRounds: 2 });
      return textResponse('working');
    },
    () => {
      const agent = f.ctx.agents.get('native-test')!;
      const goal = f.ctx.goals.get(agent)!;
      f.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
      return textResponse('done');
    },
  ] });
  const { default: Goals } = await import('@deepseek-ai/dsh-goal');
  const driver = await import('@deepseek-ai/dsh-goal-round-driver');
  await f.ctx.plugin(Goals);
  await f.ctx.plugin(driver);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1) await gate; return next(); });
  const task = await f.send('goal-start');
  const subscription = await fetch(`http://127.0.0.1:${f.server.port}/a2a/`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: task.id } }),
  });
  const stream = subscription.text();
  release();
  await f.completed(task.id);
  const frames = (await stream).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)).result);
  expect(frames.at(-1).statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
  expect(JSON.stringify(frames)).toContain('working');
  expect(JSON.stringify(frames)).toContain('done');
  expect(f.adapter.requests).toHaveLength(2);
  const agent = await f.inbox.resolve('native-test');
  const messages = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
  expect(messages.some(e => e.data.source.kind === 'goal' && e.data.source.round === 1)).toBe(true);
  expect(f.ctx.goals.get(agent)?.phase).toBe('complete');
});


it('promotes an independent queued turn once, preserving both message identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-completed-promotion-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const f = await boot({ root: join(root, 'live') });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1 && detail.step === 1) await gate; return next(); });
  const a = await f.send('active');
  const agent = await f.inbox.resolve('native-test');
  const b = await f.send('queued', { wakeup: false });
  const nativeId = agent.inbox.nextTurn[0].id;
  await f.inbox.promote('native-test', nativeId, a.id);
  expect(agent.inbox.nextStep[0].id).toBe(nativeId);
  release();
  await agent.whenIdle();
  await f.completed(a.id);
  expect((await f.rpc('GetTask', { id: b.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  const messages = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
  expect(messages.map(e => e.data.id).filter(id => id === nativeId)).toHaveLength(1);
  expect(messages.at(-1)?.data.source.taskId).toBe(a.id);
  expect(JSON.parse(messages.at(-1)!.data.source.message).messageId).toBe('queued');
  await expect(f.inbox.promote('native-test', nativeId, a.id)).rejects.toThrow();
  await f.ctx.parallel('session/flush', agent.session);
  await cp(join(root, 'live'), join(root, 'restored'), { recursive: true });
  const restored = await boot({ root: join(root, 'restored') });
  expect((await restored.inbox.resolve('native-test')).inbox.nextTurn).toHaveLength(0);
});


it('rejects promotion when consumption wins the recipient checkpoint race', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1) await gate; return next(); });
  const a = await f.send('active');
  const b = await f.send('queued', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  const id = agent.inbox.nextTurn[0].id;
  const checkpoint = f.store.checkpoint.bind(f.store);
  let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  let finishCheckpoint!: () => void;
  const blocked = new Promise<void>(resolve => { finishCheckpoint = resolve; });
  f.store.checkpoint = async (...args) => { reached(); await blocked; return checkpoint(...args); };
  const promotion = f.inbox.promote('native-test', id, a.id);
  const rejected = expect(promotion).rejects.toThrow('Promotion raced');
  await waiting;
  release();
  await agent.whenIdle();
  finishCheckpoint();
  await rejected;
  await f.completed(a.id);
  await f.completed(b.id);
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === id)).toHaveLength(1);
  expect((await f.rpc('GetTask', { id: a.id })).result.history.some(m => m.messageId === 'queued')).toBe(false);
});

it.skipIf(!process.env.A2A_CRASH_ROOT)('crash fixture persists local pending input then dies without cleanup', async () => {
  const { FilesystemTaskStore } = await import('../../../packages/dsh-a2a/src/stores/filesystem.js');
  const root = process.env.A2A_CRASH_ROOT!;
  const stage = process.env.A2A_PROMOTION_STAGE;
  const f = await boot({ root: join(root, 'sessions'), store: new SanitizedTaskStore(new FilesystemTaskStore({ root: join(root, 'tasks') })), ...(stage ? { script: ['hang'] } : {}) });
  let tasks, ids;
  if (!stage) {
    tasks = [await f.send('one', { wakeup: false }), await f.send('two', { wakeup: false })];
    ids = (await f.inbox.resolve('native-test')).inbox.nextTurn.map(m => m.id);
  } else {
    const active = await f.send('active');
    await expect.poll(() => f.adapter.requests.length).toBe(1);
    const queued = await f.send('queued', { wakeup: false });
    const agent = await f.inbox.resolve('native-test');
    ids = [agent.inbox.nextTurn[0].id];
    const append = agent.session.append.bind(agent.session);
    const insert = agent.inbox.append.bind(agent.inbox);
    if (stage === 'replacement') agent.session.append = ((type, data, ...args) => {
      if (type === 'agent/inbox/spliced' && data.target === 'next-turn' && data.removedCount && !data.inserted.length)
        throw new Error('stop after ownership replacement');
      return append(type, data, ...args);
    }) as typeof agent.session.append;
    if (stage === 'removal') agent.inbox.append = (target, message) => {
      if (target === 'next-step') throw new Error('stop after removal');
      insert(target, message);
    };
    const transfer = f.inbox.promote('native-test', ids[0], active.id);
    if (stage === 'placement') await transfer;
    else await expect(transfer).rejects.toThrow('stop after');
    agent.session.append = append;
    agent.inbox.append = insert;
    await f.ctx.parallel('session/flush', agent.session);
    tasks = [active, queued];
  }
  await writeFile(join(root, 'admitted.json'), JSON.stringify({ tasks, ids }));
  process.kill(process.pid, 'SIGKILL');
});

it('recovers local task ownership after SIGKILL with no shared process state', async () => {
  const { FilesystemTaskStore } = await import('../../../packages/dsh-a2a/src/stores/filesystem.js');
  const root = await mkdtemp(join(tmpdir(), 'a2a-local-crash-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('../check-inbox.mjs', import.meta.url)), '-t', 'crash fixture persists'], {
    env: { ...process.env, A2A_CRASH_ROOT: root }, encoding: 'utf8', timeout: 10000,
  });
  expect(crashed.error).toBeUndefined();
  expect(crashed.status).not.toBe(0);
  const admitted = JSON.parse(await readFile(join(root, 'admitted.json'), 'utf8'));
  const restored = await boot({ root: join(root, 'sessions'), store: new SanitizedTaskStore(new FilesystemTaskStore({ root: join(root, 'tasks') })) });
  const agent = await restored.inbox.resolve('native-test');
  expect(agent.inbox.nextTurn.map(m => m.id)).toEqual(admitted.ids);
  // The official runtime wakes on a real input, supplied by the host after discovery.
  const waking = await restored.send('wake');
  for (const task of [...admitted.tasks, waking]) await restored.completed(task.id);
  const committed = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
  expect(committed.map(e => e.data.id).slice(0, 2)).toEqual(admitted.ids);
  expect(restored.adapter.requests).toHaveLength(3);
});

it.each(['flush', 'recipient'])('settles the original owner after a post-transfer %s checkpoint failure', async failure => {
  const f = await boot({ script: ['hang'] });
  const a = await f.send('active');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const b = await f.send('queued', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  const id = agent.inbox.nextTurn[0].id;
  if (failure === 'flush') {
    let once = true;
    f.ctx.on('session/flush', () => {
      if (once && agent.inbox.nextStep.length) { once = false; throw new Error('promotion flush failed'); }
    });
  } else {
    const checkpoint = f.store.checkpoint.bind(f.store);
    f.store.checkpoint = async (task, context) => {
      if (task.id === a.id && task.history.some(m => m.messageId === 'queued')) throw new Error('recipient checkpoint failed');
      return checkpoint(task, context);
    };
  }
  await expect(f.inbox.promote('native-test', id, a.id)).rejects.toThrow();
  const expected = failure === 'flush' ? 'TASK_STATE_SUBMITTED' : 'TASK_STATE_CANCELED';
  await expect.poll(async () => (await f.rpc('GetTask', { id: b.id })).result.status.state).toBe(expected);
  expect((failure === 'flush' ? agent.inbox.nextTurn : agent.inbox.nextStep).map(m => m.id)).toEqual([id]);
});

it.each(['replacement', 'removal', 'placement'])('recovers promotion after SIGKILL following %s', async stage => {
  const { FilesystemTaskStore } = await import('../../../packages/dsh-a2a/src/stores/filesystem.js');
  const root = await mkdtemp(join(tmpdir(), 'a2a-transfer-crash-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('../check-inbox.mjs', import.meta.url)), '-t', 'crash fixture persists'], {
    env: { ...process.env, A2A_CRASH_ROOT: root, A2A_PROMOTION_STAGE: stage }, encoding: 'utf8', timeout: 10000,
  });
  expect(crashed.error).toBeUndefined();
  expect(crashed.status).not.toBe(0);
  const admitted = JSON.parse(await readFile(join(root, 'admitted.json'), 'utf8'));
  const restored = await boot({ root: join(root, 'sessions'), store: new SanitizedTaskStore(new FilesystemTaskStore({ root: join(root, 'tasks') })) });
  const agent = await restored.inbox.resolve('native-test');
  expect(agent.inbox.nextStep.map(m => m.id)).toEqual(admitted.ids);
  const waking = await restored.send('wake');
  await restored.completed(admitted.tasks[0].id);
  await restored.completed(waking.id);
  expect((await restored.rpc('GetTask', { id: admitted.tasks[1].id })).result.status.state).toBe('TASK_STATE_CANCELED');
  const messages = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
  expect(messages.filter(e => e.data.id === admitted.ids[0])).toHaveLength(1);
  expect(messages.filter(e => e.data.content[0]?.text === 'active')).toHaveLength(1);
  expect(restored.adapter.requests).toHaveLength(2);
});

it('keeps an existing Goal attributed to its creator when an independent task edits it', async () => {
  const f = await boot({ script: [
    () => { f.ctx.goals.create(f.ctx.agents.get('native-test')!, { objective: 'original' }); return textResponse('A'); },
    () => {
      const agent = f.ctx.agents.get('native-test')!, goal = f.ctx.goals.get(agent)!;
      f.ctx.goals.edit(agent, { id: goal.id, revision: goal.revision }, { objective: 'updated' });
      return textResponse('B');
    },
    () => {
      const agent = f.ctx.agents.get('native-test')!, goal = f.ctx.goals.get(agent)!;
      f.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision }); return textResponse('done');
    },
  ] });
  const { default: Goals } = await import('@deepseek-ai/dsh-goal');
  await f.ctx.plugin(Goals);
  await f.ctx.plugin(await import('@deepseek-ai/dsh-goal-round-driver'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1) await gate; return next(); });
  const owners: string[] = [];
  f.ctx.on('a2a/before-step', detail => { owners.push(detail.taskId); });
  const a = await f.send('A');
  const b = await f.send('B');
  release();
  await f.completed(a.id);
  await f.completed(b.id);
  expect(owners).toEqual([a.id, b.id, a.id]);
  expect(f.adapter.requests).toHaveLength(3);
});

it('leaves forged Goal rounds subject to the official reservation validation', async () => {
  let forgedId = '';
  const f = await boot({ script: [
    () => {
      const agent = f.ctx.agents.get('native-test')!;
      const goal = f.ctx.goals.create(agent, { objective: 'original' });
      const forged = createUserMessage({ content: [{ type: 'text', text: 'forged round' }],
        source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 } });
      forgedId = forged.id;
      agent.followup(forged);
      return textResponse('A');
    },
    () => {
      const agent = f.ctx.agents.get('native-test')!, goal = f.ctx.goals.get(agent)!;
      f.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision }); return textResponse('done');
    },
  ] });
  const { default: Goals } = await import('@deepseek-ai/dsh-goal');
  await f.ctx.plugin(Goals);
  await f.ctx.plugin(await import('@deepseek-ai/dsh-goal-round-driver'));
  const task = await f.send('A');
  await expect.poll(async () => (await f.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_FAILED');
  const agent = await f.inbox.resolve('native-test');
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message').some(e => e.data.id === forgedId)).toBe(false);
  expect(f.adapter.requests).toHaveLength(1);
});

it('keeps an independent queued task executable after the active task fails', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('a2a/before-step', async detail => {
    if (detail.a2aMessage.messageId === 'A') { await gate; throw new Error('fail A'); }
  });
  const a = await f.send('A');
  const b = await f.send('B', { wakeup: false });
  release();
  await expect.poll(async () => (await f.rpc('GetTask', { id: a.id })).result.status.state).toBe('TASK_STATE_FAILED');
  expect((await f.rpc('GetTask', { id: b.id })).result.status.state).toBe('TASK_STATE_SUBMITTED');
  const waking = await f.send('wake');
  await f.completed(b.id);
  await f.completed(waking.id);
  const agent = await f.inbox.resolve('native-test');
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.content[0].text)).toEqual(['B', 'wake']);
});

it('retains independent ownership across permanent session checkpoint failure and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-failed-transfer-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const f = await boot({ root: join(root, 'live'), script: ['hang'] });
  const a = await f.send('A');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const b = await f.send('B', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  const id = agent.inbox.nextTurn[0].id;
  await f.ctx.parallel('session/flush', agent.session);
  await cp(join(root, 'live'), join(root, 'last-checkpoint'), { recursive: true });
  const remove = f.ctx.on('session/flush', () => { throw new Error('session storage unavailable'); });
  try { await expect(f.inbox.promote('native-test', id, a.id)).rejects.toThrow(); }
  finally { remove(); }
  expect((await f.rpc('GetTask', { id: b.id })).result.status.state).toBe('TASK_STATE_SUBMITTED');
  expect(agent.inbox.nextTurn.map(m => m.id)).toEqual([id]);
  const backend = new MemoryTaskStore(), call = new ServerCallContext();
  for (const task of [a, b]) await backend.save(await f.store.load(task.id, call), call);
  const restored = await boot({ root: join(root, 'last-checkpoint'), backend });
  const waking = await restored.send('wake');
  await restored.completed(b.id);
  await restored.completed(waking.id);
  expect(restored.adapter.requests).toHaveLength(2);
});

it('reports Goal continuation, promotion and local recovery to Langfuse', async () => {
  const live = process.env.DSH_ISSUE75_LANGFUSE_LIVE === 'true';
  const captured: unknown[] = [];
  const collector = live ? undefined : await startFakeIngestion(captured);
  if (collector) cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
  if (live) expect(publicKey && secretKey && baseUrl, 'Issue #75 live E2E requires LANGFUSE_*').toBeTruthy();
  const marker = `ci-issue75-${process.env.GITHUB_RUN_ID ?? Date.now()}-${randomUUID()}`;
  const fromStartTime = new Date(Date.now() - 60_000).toISOString();
  const telemetry = { enabled: true, publicKey: live ? publicKey : 'test', secretKey: live ? secretKey : 'test',
    baseUrl: live ? baseUrl : `http://127.0.0.1:${collector!.address().port}`, captureContent: true,
    traceName: 'dsh-inbox-issue75', environment: 'ci', release: process.env.GITHUB_SHA ?? 'local',
    tags: ['ci', 'scenario:issue-75', marker] };
  const f = await boot({ contextId: marker, langfuse: telemetry, script: [
    () => { f.ctx.goals.create(f.ctx.agents.get(marker)!, { objective: marker }); return textResponse('working'); },
    textResponse('steered'),
    () => {
      const agent = f.ctx.agents.get(marker)!, goal = f.ctx.goals.get(agent)!;
      f.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision }); return textResponse('goal complete');
    },
  ] });
  const { default: Goals } = await import('@deepseek-ai/dsh-goal');
  await f.ctx.plugin(Goals);
  await f.ctx.plugin(await import('@deepseek-ai/dsh-goal-round-driver'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1 && detail.step === 1) await gate; return next(); });
  const a = await f.send(`${marker}-A`);
  const b = await f.send(`${marker}-promote`, { wakeup: false });
  const agent = await f.inbox.resolve(marker);
  const nativeId = agent.inbox.nextTurn[0].id;
  try { await f.inbox.promote(marker, nativeId, a.id); } finally { release(); }
  await f.completed(a.id);
  expect(f.adapter.requests).toHaveLength(3);
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === nativeId)).toHaveLength(1);
  await f.ctx.parallel('session/flush', agent.session);

  const root = await mkdtemp(join(tmpdir(), 'a2a-langfuse-crash-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('../check-inbox.mjs', import.meta.url)), '-t', 'crash fixture persists'], {
    env: { ...process.env, A2A_CRASH_ROOT: root }, encoding: 'utf8', timeout: 10000,
  });
  expect(crashed.error).toBeUndefined();
  expect(crashed.status).not.toBe(0);
  const admitted = JSON.parse(await readFile(join(root, 'admitted.json'), 'utf8'));
  const { FilesystemTaskStore } = await import('../../../packages/dsh-a2a/src/stores/filesystem.js');
  const restored = await boot({ root: join(root, 'sessions'), store: new SanitizedTaskStore(new FilesystemTaskStore({ root: join(root, 'tasks') })), langfuse: telemetry });
  const waking = await restored.send(`${marker}-wake`);
  for (const task of [...admitted.tasks, waking]) await restored.completed(task.id);
  const recovered = await restored.inbox.resolve('native-test');
  await restored.ctx.parallel('session/flush', recovered.session);
  expect(restored.adapter.requests).toHaveLength(3);

  function evaluate(observations, id, state, turns, generations) {
    const root = observations.find(o => o.name === 'dsh-inbox-issue75' && o.metadata?.taskId === id);
    const children = observations.filter(o => o.name === 'agent:turn' && o.parentObservationId === root?.id);
    const calls = observations.filter(o => o.type === 'GENERATION' && children.some(turn => turn.id === o.parentObservationId));
    const problems = [];
    if (!root?.endTime || root.metadata?.taskState !== state) problems.push('missing ended task root or final state');
    if (children.length !== turns || children.some(o => !o.endTime)) problems.push('wrong task turn ownership');
    if (calls.length !== generations || calls.some(o => !o.endTime)) problems.push('wrong model call ownership');
    if (id === a.id && !observations.some(o => o.name === 'inbox:promoted' && o.parentObservationId === root?.id)) problems.push('missing promotion event');
    return problems;
  }
  for (const [id, state, turns, generations] of [[a.id, 'completed', 2, 3], [b.id, 'canceled', 0, 0], [admitted.tasks[0].id, 'completed', 1, 1]] as const) {
    if (!live) expect(evaluate(capturedToObservations(captured), id, state, turns, generations)).toEqual([]);
    else {
      const result = await runVerification({ baseUrl, publicKey, secretKey, fromStartTime,
        toStartTime: new Date(Date.now() + 60_000).toISOString(), codeword: id,
        observationName: `inbox:${state}`, model: 'mock',
        evaluate: observations => evaluate(observations, id, state, turns, generations) });
      expect(result.ok, result.state).toBe(true);
      console.log(`Langfuse issue-75 ${id}: ${result.state}`);
    }
  }
}, 900_000);

it('executes a successful promotion retry once after an earlier checkpoint rollback', async () => {
  const f = await boot();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1 && detail.step === 1) await gate; return next(); });
  const a = await f.send('A');
  const b = await f.send('B', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  const id = agent.inbox.nextTurn[0].id;
  let fail = true;
  const remove = f.ctx.on('session/flush', () => {
    if (fail && agent.inbox.nextStep.length) { fail = false; throw new Error('first transfer checkpoint failed'); }
  });
  try { await expect(f.inbox.promote('native-test', id, a.id)).rejects.toThrow(); }
  finally { remove(); }
  expect(agent.inbox.nextTurn[0].id).toBe(id);
  await f.inbox.promote('native-test', id, a.id);
  release();
  await f.completed(a.id);
  expect((await f.rpc('GetTask', { id: b.id })).result.status.state).toBe('TASK_STATE_CANCELED');
  expect(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === id)).toHaveLength(1);
});

it.each(['cancel', 'clear'])('does not restore input when %s wins a failed promotion checkpoint', async action => {
  const f = await boot({ script: ['hang'] });
  const a = await f.send('A');
  await expect.poll(() => f.adapter.requests.length).toBe(1);
  const b = await f.send('B', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  const id = agent.inbox.nextTurn[0].id;
  let reached!: () => void, fail!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const failed = new Promise<void>(resolve => { fail = resolve; });
  let block = true;
  f.ctx.on('session/flush', async () => {
    if (block && agent.inbox.nextStep.some(m => m.id === id)) {
      block = false; reached(); await failed; throw new Error('promotion checkpoint failed');
    }
  });
  const promotion = f.inbox.promote('native-test', id, a.id).then(() => undefined, error => error);
  await entered;
  if (action === 'cancel') await f.inbox.cancel(b.id);
  else await f.inbox.clear('native-test');
  fail();
  expect(await promotion).toBeInstanceOf(Error);
  expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(m => m.id)).not.toContain(id);
});

it('cancels the active driver while a claimed promotion is waiting for storage', async () => {
  const f = await boot();
  let start!: () => void, finish!: () => void, reached!: () => void;
  const modelGate = new Promise<void>(resolve => { start = resolve; });
  const storageGate = new Promise<void>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  f.ctx.on('agent/request', async (detail, next) => { if (detail.turn === 1 && detail.step === 1) await modelGate; return next(); });
  const a = await f.send('A');
  await f.send('B', { wakeup: false });
  const agent = await f.inbox.resolve('native-test');
  const id = agent.inbox.nextTurn[0].id;
  let once = true;
  f.ctx.on('session/flush', async () => {
    if (once && agent.inbox.nextStep.some(m => m.id === id)) { once = false; reached(); await storageGate; }
  });
  const promotion = f.inbox.promote('native-test', id, a.id).catch(() => {});
  await entered;
  start();
  await expect.poll(() => agent.inbox.nextStep.length).toBe(0);
  try {
    await f.inbox.cancel(a.id);
    await expect.poll(() => agent.status, { timeout: 500 }).toBe('idle');
  } finally { finish(); await promotion; }
});

});


describe('issue-78 graceful retention', () => {
  async function host(root: string, script: Array<StreamChunk[] | 'hang'> = ['hang'], shutdown?: 'cancel', telemetry?: Langfuse.LangfusePluginConfig) {
    const ctx = new Context();
    cleanups.push(() => ctx.fiber.dispose());
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(AgentLoop, { agents: [] });
    if (telemetry) await ctx.plugin(Langfuse, telemetry);
    const adapter = new MockAdapter(script);
    ctx.llm.registerAdapter(['mock'], adapter);
    const port = await freePort();
    await ctx.plugin(A2aPlugin, A2aPlugin.Config({ enabled: true, port, inbox: { enabled: true, shutdown: shutdown ?? 'retain-pending' }, taskStore: 'filesystem', filesystem: { root: join(root, 'tasks') }, agent: { provider: 'mock', model: 'mock' } }));
    const rpc = async (method: string, params: unknown) => (await fetch(`http://127.0.0.1:${port}/a2a/`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'A2A-Extensions': INBOX_EXTENSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json();
    const send = async (id: string, controls: Record<string, unknown> = {}, taskId?: string) => {
      const result = await rpc('SendMessage', { message: { messageId: id, role: 'ROLE_USER', contextId: 'graceful', taskId, parts: [{ text: id }], metadata: { [INBOX_EXTENSION]: controls } }, configuration: { returnImmediately: true } });
      expect(result.error).toBeUndefined();
      return result.result.task;
    };
    return { ctx, adapter, rpc, send, inbox: ctx.a2aInbox };
  }

  it('retains unclaimed steering and independent turns through public plugin disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await host(root);
    const active = await first.send('active');
    await expect.poll(() => first.adapter.requests.length).toBe(1);
    await first.send('steer', { target: 'next-step' }, active.id);
    const future = await first.send('future', { wakeup: false });
    const original = await first.inbox.resolve('graceful');
    await expect.poll(() => original.inbox.nextTurn.length).toBe(1);
    await first.ctx.parallel('session/flush', original.session);
    const ids = [...original.inbox.nextStep, ...original.inbox.nextTurn].map(m => m.id);
    await first.ctx.fiber.dispose();
    const second = await host(root, Array.from({ length: 4 }, () => textResponse('done')));
    const agent = await second.inbox.resolve('graceful');
    expect([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(m => m.id)).toEqual(ids);
    expect((await second.rpc('GetTask', { id: active.id })).result.status.state).not.toBe('TASK_STATE_CANCELED');
    expect((await second.rpc('GetTask', { id: future.id })).result.status.state).not.toBe('TASK_STATE_CANCELED');
    await second.send('wake');
    await expect.poll(() => agent.session.snapshotEvents().filter(e => e.type === 'user/message').length).toBe(4);
    const messages = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
    expect(messages.map(e => e.data.content[0].text)).toEqual(['active', 'steer', 'future', 'wake']);
    expect(messages.slice(1, 3).map(e => e.data.id)).toEqual(ids);
    expect(messages.slice(1, 3).map(e => JSON.parse(e.data.source.message).messageId)).toEqual(['steer', 'future']);
  });


  it.each(['cancel', 'clear'] as const)('does not resurrect input after explicit %s', async action => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-terminal-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await host(root);
    const active = await first.send('active');
    await expect.poll(() => first.adapter.requests.length).toBe(1);
    await first.send('steer', { target: 'next-step' }, active.id);
    const future = await first.send('future', { wakeup: false });
    const agent = await first.inbox.resolve('graceful');
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(1);
    if (action === 'cancel') {
      await first.rpc('CancelTask', { id: active.id });
      await first.rpc('CancelTask', { id: future.id });
    } else await first.ctx.a2aTasks.clearContext('graceful');
    await first.ctx.fiber.dispose();
    const second = await host(root);
    const restored = await second.inbox.resolve('graceful');
    expect([...restored.inbox.nextStep, ...restored.inbox.nextTurn]).toEqual([]);
    if (action === 'cancel') for (const task of [active, future])
      expect((await second.rpc('GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_CANCELED');
    expect(second.adapter.requests).toHaveLength(0);
  });

  it('uses the persistence barrier when event listeners unload before the inbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-barrier-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await host(root);
    await first.send('parked', { wakeup: false });
    const agent = await first.inbox.resolve('graceful');
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(1);
    await first.ctx.parallel('session/flush', agent.session);
    // This listener models a late durability hook whose owner has already unloaded.
    first.ctx.on('session/flush', () => { throw new Error('session event owner already unloaded'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await first.ctx.fiber.dispose();
      expect(errors.mock.calls.filter(args => String(args[0]).includes('[dsh-a2a]'))).toEqual([]);
    } finally { errors.mockRestore(); }
    const second = await host(root);
    const restored = await second.inbox.resolve('graceful');
    expect(restored.inbox.nextTurn.map(m => m.content[0].text)).toEqual(['parked']);
  });

  it('keeps default shutdown terminal and never replays a consumed active call', async () => {
    for (const shutdown of ['cancel', undefined] as const) {
      const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-active-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const first = await host(root, ['hang'], shutdown);
      const active = await first.send('active');
      await expect.poll(() => first.adapter.requests.length).toBe(1);
      const agent = await first.inbox.resolve('graceful');
      await first.ctx.parallel('session/flush', agent.session);
      if (shutdown === 'cancel') {
        await first.send('future', { wakeup: false });
        await expect.poll(() => agent.inbox.nextTurn.length).toBe(1);
      }
      await first.ctx.fiber.dispose();
      const second = await host(root);
      const restored = await second.inbox.resolve('graceful');
      expect([...restored.inbox.nextStep, ...restored.inbox.nextTurn]).toEqual([]);
      expect((await second.rpc('GetTask', { id: active.id })).result.status.state).toBe(shutdown === 'cancel' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED');
      expect(second.adapter.requests).toHaveLength(0);
    }
  });

  it('retains an independent input deferred from a mixed recovered batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-deferred-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await host(root);
    const active = await first.send('active');
    await expect.poll(() => first.adapter.requests.length).toBe(1);
    await first.send('steer', { target: 'next-step' }, active.id);
    const future = await first.send('future', { wakeup: false });
    await expect.poll(async () => (await first.inbox.resolve('graceful')).inbox.nextTurn.length).toBe(1);
    await first.ctx.fiber.dispose();
    const second = await host(root);
    const before = await second.inbox.resolve('graceful');
    expect(before.inbox.nextStep.map(m => m.content[0].text)).toEqual(['steer']);
    expect(before.inbox.nextTurn.map(m => m.content[0].text)).toEqual(['future']);
    await second.send('wake-2');
    await expect.poll(() => second.adapter.requests.length).toBe(1);
    const selected = await second.inbox.resolve('graceful');
    expect(selected.inbox.nextTurn.map(m => m.content[0].text)).toContain('future');
    await second.ctx.fiber.dispose();
    const third = await host(root, Array.from({ length: 4 }, () => textResponse('done')));
    const recovered = await third.inbox.resolve('graceful');
    expect(recovered.inbox.nextTurn.map(m => m.content[0].text)).toContain('future');
    await third.send('wake-3');
    await expect.poll(async () => (await third.rpc('GetTask', { id: future.id })).result.status.state).toBe('TASK_STATE_COMPLETED');
    expect(recovered.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.content[0].text === 'future')).toHaveLength(1);
  });

  it('retains transferred ownership when shutdown interrupts a promotion checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-promotion-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await host(root);
    const active = await first.send('active');
    await expect.poll(() => first.adapter.requests.length).toBe(1);
    const former = await first.send('promote', { wakeup: false });
    const agent = await first.inbox.resolve('graceful');
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    first.ctx.on('session/flush', async session => {
      if (session === agent.session && agent.inbox.nextStep.length && !blocked) { blocked = true; await gate; }
    });
    const promoting = first.inbox.promote('graceful', agent.inbox.nextTurn[0].id, active.id);
    const result = promoting.catch(error => error);
    await expect.poll(() => blocked).toBe(true);
    const stopping = first.ctx.fiber.dispose();
    release();
    await result;
    await stopping;
    const second = await host(root, Array.from({ length: 3 }, () => textResponse('done')));
    const restored = await second.inbox.resolve('graceful');
    expect(restored.inbox.nextStep.map(m => m.source.taskId)).toEqual([active.id]);
    await second.send('wake');
    await expect.poll(async () => (await second.rpc('GetTask', { id: active.id })).result.status.state).toBe('TASK_STATE_COMPLETED');
    expect((await second.rpc('GetTask', { id: former.id })).result.status.state).toMatch(/CANCELED|FAILED/);
    expect(restored.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.content[0].text === 'promote')).toHaveLength(1);
  });

  it('reports gracefully recovered work to Langfuse', async () => {
    const live = process.env.DSH_ISSUE78_LANGFUSE_LIVE === 'true';
    const captured: unknown[] = [];
    const collector = live ? undefined : await startFakeIngestion(captured);
    if (collector) cleanups.push(() => new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve())));
    const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: baseUrl } = process.env;
    if (live) expect(publicKey && secretKey && baseUrl, 'Issue #78 live E2E requires LANGFUSE_*').toBeTruthy();
    const fromStartTime = new Date(Date.now() - 60_000).toISOString();
    const telemetry = { enabled: true, publicKey: live ? publicKey : 'test', secretKey: live ? secretKey : 'test',
      baseUrl: live ? baseUrl : `http://127.0.0.1:${collector!.address().port}`, captureContent: true,
      traceName: 'dsh-inbox-issue78', environment: 'ci', release: process.env.GITHUB_SHA ?? 'local', tags: ['ci', 'scenario:issue-78'] };
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-langfuse-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await host(root);
    const active = await first.send('active');
    await expect.poll(() => first.adapter.requests.length).toBe(1);
    await first.send('steer', { target: 'next-step' }, active.id);
    const future = await first.send('future', { wakeup: false });
    await expect.poll(async () => (await first.inbox.resolve('graceful')).inbox.nextTurn.length).toBe(1);
    await first.ctx.fiber.dispose();
    const second = await host(root, Array.from({ length: 4 }, () => textResponse('done')), undefined, telemetry);
    const agent = await second.inbox.resolve('graceful');
    await second.send('wake');
    for (const task of [active, future]) await expect.poll(async () => (await second.rpc('GetTask', { id: task.id })).result.status.state, { timeout: live ? 15_000 : 1_000 }).toBe('TASK_STATE_COMPLETED');
    await second.ctx.parallel('session/flush', agent.session);
    for (const task of [active, future]) {
      const evaluate = observations => {
        const root = observations.find(o => o.name === 'dsh-inbox-issue78' && o.metadata?.taskId === task.id);
        const turns = observations.filter(o => o.name === 'agent:turn' && o.parentObservationId === root?.id);
        const calls = observations.filter(o => o.type === 'GENERATION' && turns.some(t => t.id === o.parentObservationId));
        return root?.endTime && root.metadata?.taskState === 'completed' && turns.length === 1 && calls.length === 1 && calls[0].endTime ? [] : ['missing ended recovery task/turn/generation'];
      };
      if (!live) expect(evaluate(capturedToObservations(captured))).toEqual([]);
      else {
        const result = await runVerification({ baseUrl, publicKey, secretKey, fromStartTime,
          toStartTime: new Date(Date.now() + 60_000).toISOString(), codeword: task.id,
          observationName: 'inbox:completed', model: 'mock', evaluate });
        expect(result.ok, result.state).toBe(true);
        console.log(`Langfuse issue-78 ${task.id}: ${result.state}`);
      }
    }
  }, 900_000);

  it.skipIf(!process.env.A2A_GRACEFUL_ROOT)('graceful child fixture checkpoints SIGTERM', async () => {
    const root = process.env.A2A_GRACEFUL_ROOT!;
    const first = await host(root);
    const active = await first.send('active');
    await expect.poll(() => first.adapter.requests.length).toBe(1);
    const promoted = await first.send('promoted', { wakeup: false });
    const agent = await first.inbox.resolve('graceful');
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(1);
    await first.inbox.promote('graceful', agent.inbox.nextTurn[0].id, active.id);
    const future = await first.send('future', { wakeup: false });
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(1);
    await first.ctx.parallel('session/flush', agent.session);
    const ids = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(m => m.id);
    await writeFile(join(root, 'graceful-admitted.json'), JSON.stringify({ active, promoted, future, ids }));
    const stopped = new Promise<void>((resolve, reject) => {
      process.once('SIGTERM', () => { void first.ctx.fiber.dispose().then(resolve, reject); });
    });
    process.kill(process.pid, 'SIGTERM');
    await stopped;
  });

  it('recovers promoted and future input after SIGTERM and a second graceful restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2a-graceful-child-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../check-inbox.mjs', import.meta.url)), '-t', 'graceful child fixture'], {
      env: { ...process.env, A2A_GRACEFUL_ROOT: root }, encoding: 'utf8', timeout: 10000,
    });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    const admitted = JSON.parse(await readFile(join(root, 'graceful-admitted.json'), 'utf8'));
    const second = await host(root);
    const restored = await second.inbox.resolve('graceful');
    expect([...restored.inbox.nextStep, ...restored.inbox.nextTurn].map(m => m.id)).toEqual(admitted.ids);
    await second.ctx.fiber.dispose();
    const third = await host(root, Array.from({ length: 4 }, () => textResponse('done')));
    const agent = await third.inbox.resolve('graceful');
    expect([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(m => m.id)).toEqual(admitted.ids);
    await third.send('wake');
    await expect.poll(async () => (await third.rpc('GetTask', { id: admitted.future.id })).result.status.state).toBe('TASK_STATE_COMPLETED');
    expect((await third.rpc('GetTask', { id: admitted.active.id })).result.status.state).toBe('TASK_STATE_COMPLETED');
    expect((await third.rpc('GetTask', { id: admitted.promoted.id })).result.status.state).toBe('TASK_STATE_CANCELED');
    const messages = agent.session.snapshotEvents().filter(e => e.type === 'user/message');
    expect(messages.map(e => e.data.content[0].text)).toEqual(['active', 'promoted', 'future', 'wake']);
    expect(messages.slice(1, 3).map(e => e.data.id)).toEqual(admitted.ids);
    expect(messages.slice(1, 3).map(e => JSON.parse(e.data.source.message).messageId)).toEqual(['promoted', 'future']);
    await third.ctx.fiber.dispose();
    const fourth = await host(root);
    const empty = await fourth.inbox.resolve('graceful');
    expect([...empty.inbox.nextStep, ...empty.inbox.nextTurn]).toEqual([]);
    expect(fourth.adapter.requests).toHaveLength(0);
  });
});
