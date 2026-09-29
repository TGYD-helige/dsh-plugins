import { Role, TaskState } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import { AgentEvent, type RequestContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type A2aServer, startA2aServer } from './server.js';
import { MemoryTaskStore, SanitizedTaskStore } from './task-store.js';

// A stub executor with the same event contract the real one uses: a task
// anchor first (A2A 1.0 stream ordering), then working, then input-required.
const stubExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    const now = new Date().toISOString();
    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: now },
        history: [userMessage],
        artifacts: [],
        metadata: undefined,
      }),
    );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now },
        metadata: undefined,
      }),
    );
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: {
            messageId: 'a1',
            contextId,
            taskId,
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: 'text', value: 'done' },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          timestamp: now,
        },
        metadata: undefined,
      }),
    );
    bus.finished();
  },
  cancelTask: async (taskId, bus) => {
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
  },
};

describe('A2A HTTP server (v1 + legacy compat)', () => {
  let server: A2aServer;
  let base: string;

  beforeEach(async () => {
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test-agent', description: 'test', version: '0.0.1' },
      executor: stubExecutor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  const rpc = (method: string, params: unknown, id: number | string = 1) =>
    fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  const json = (res: Response): Promise<any> => res.json();

  const v1Message = (text: string, extra: Record<string, unknown> = {}) => ({
    message: {
      messageId: `m-${Math.random()}`,
      role: 'user',
      parts: [{ text }],
      ...extra,
    },
  });

  it('serves the v1 agent card on the well-known path', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(res.status).toBe(200);
    const card = await json(res);
    expect(card.name).toBe('test-agent');
    const interfaces = card.supportedInterfaces;
    expect(interfaces).toHaveLength(2);
    expect(interfaces[0]).toMatchObject({
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    });
    expect(interfaces[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a2a\/$/);
    // the legacyCompat mirror lets pre-1.0 clients in
    expect(interfaces[1]).toMatchObject({ protocolBinding: 'JSONRPC', protocolVersion: '0.3' });
  });

  it('serves a 0.3-shaped card to clients without an A2A-Version header', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`);
    const card = await json(res);
    expect(card.protocolVersion).toBe('0.3');
    expect(card.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a2a\/$/);
  });

  it('answers a blocking SendMessage with the final task state', async () => {
    const res = await rpc('SendMessage', { tenant: '', ...v1Message('hello') });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.error).toBeUndefined();
    expect(body.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(body.result.task.status.message.parts[0].text).toBe('done');
  });

  it('streams SendStreamingMessage over SSE with oneof-keyed frames', async () => {
    const res = await rpc('SendStreamingMessage', { tenant: '', ...v1Message('hello') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await res.text())
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)));
    expect(frames[0].result.task.status.state).toBe('TASK_STATE_SUBMITTED');
    const last = frames.at(-1);
    expect(last.result.statusUpdate.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('returns live history in the first legacy resubscribe frame', async () => {
    const send = await fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'user-1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello' }],
          },
        },
      }),
    });
    const sent = await json(send);
    const subscribed = await fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/resubscribe',
        params: { id: sent.result.id },
      }),
    });
    const reader = subscribed.body!.getReader();
    let wire = '';
    while (!wire.includes('\n\n')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      wire += new TextDecoder().decode(chunk.value);
    }
    const first = JSON.parse(wire.split('\n\n')[0].slice(6));
    expect(first.result.history).toMatchObject([
      { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
      { role: 'agent', parts: [{ kind: 'text', text: 'done' }] },
    ]);
    await reader.cancel();
  });

  it('replays prior deltas and continues live after resubscribe', async () => {
    await server.close();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const executor: AgentExecutor = {
      async execute({ userMessage, taskId, contextId }, bus) {
        const status = (text: string, state = TaskState.TASK_STATE_WORKING) =>
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state,
              message: {
                messageId: 'answer',
                contextId,
                taskId,
                role: Role.ROLE_AGENT,
                parts: [
                  {
                    content: { $case: 'text', value: text },
                    metadata: undefined,
                    filename: '',
                    mediaType: 'text/plain',
                  },
                ],
                metadata: undefined,
                extensions: [],
                referenceTaskIds: [],
              },
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          });
        bus.publish(
          AgentEvent.task({
            id: taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_SUBMITTED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            history: [userMessage],
            artifacts: [],
            metadata: undefined,
          }),
        );
        bus.publish(status('A'));
        await paused;
        bus.publish(status('B'));
        bus.publish(status('AB', TaskState.TASK_STATE_INPUT_REQUIRED));
        bus.finished();
      },
      cancelTask: async () => {},
    };
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test-agent', description: 'test', version: '0.0.1' },
      executor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    });
    base = `http://127.0.0.1:${server.port}`;
    const send = await fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'user-1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello' }],
          },
        },
      }),
    });
    const sendReader = send.body!.getReader();
    const initial = new TextDecoder().decode((await sendReader.read()).value);
    const taskId = JSON.parse(initial.split('\n\n')[0].slice(6)).result.id;
    const subscribed = await fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/resubscribe',
        params: { id: taskId },
      }),
    });
    const reader = subscribed.body!.getReader();
    let wire = '';
    while (!wire.includes('"text":"A"'))
      wire += new TextDecoder().decode((await reader.read()).value);
    const first = JSON.parse(wire.split('\n\n')[0].slice(6));
    expect(first.result.history).toMatchObject([
      { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
    ]);
    expect(first.result.history).toHaveLength(1);
    expect(first.result.status.message).toBeUndefined();
    resume();
    while (!wire.includes('"text":"B"'))
      wire += new TextDecoder().decode((await reader.read()).value);
    const events = wire
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)).result);
    const texts = events
      .filter((event) => event.kind === 'status-update')
      .map((event) => event.status.message?.parts?.[0]?.text);
    expect(texts.filter((text) => text === 'A')).toHaveLength(1);
    expect(texts.filter((text) => text === 'B')).toHaveLength(1);
    await reader.cancel();
    await sendReader.cancel();
  });

  it('lists tasks via ListTasks with history stripped', async () => {
    await rpc('SendMessage', { tenant: '', ...v1Message('hello') });
    const body = await json(await rpc('ListTasks', { tenant: '' }, 2));
    expect(body.error).toBeUndefined();
    expect(body.result.tasks).toHaveLength(1);
    expect(body.result.tasks[0].status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(body.result.tasks[0].history ?? []).toEqual([]);
    expect(body.result.totalSize).toBe(1);
  });

  it('round-trips GetTask and cancels via CancelTask', async () => {
    const sent = await json(await rpc('SendMessage', { tenant: '', ...v1Message('hello') }));
    const taskId = sent.result.task.id;
    const got = await json(await rpc('GetTask', { tenant: '', id: taskId }, 3));
    expect(got.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const canceled = await json(await rpc('CancelTask', { tenant: '', id: taskId }, 4));
    expect(canceled.result.status.state).toBe('TASK_STATE_CANCELED');
    // terminal tasks reject follow-ups
    const rejected = await json(
      await rpc('SendMessage', { tenant: '', ...v1Message('again', { taskId }) }, 5),
    );
    expect(rejected.error).toBeDefined();
    expect(rejected.error.message).toMatch(/terminal state/);
  });

  it('serves legacy 0.3 method spellings through the compat layer', async () => {
    const res = await fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'legacy-1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello' }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.error).toBeUndefined();
    expect(body.result.kind).toBe('task');
    expect(body.result.status.state).toBe('input-required');
  });

  it('finds the latest legacy task by contextId at the root JSON-RPC path', async () => {
    const first = await json(
      await rpc('SendMessage', { tenant: '', ...v1Message('one', { contextId: 'recover' }) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await json(
      await rpc('SendMessage', { tenant: '', ...v1Message('two', { contextId: 'recover' }) }),
    );
    const lookup = (contextId: string, path = '/') =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tasks/get', params: { contextId } }),
      });
    const found = await json(await lookup('recover'));
    expect(found.error).toBeUndefined();
    expect(found.result.kind).toBe('task');
    expect(found.result.id).toBe(second.result.task.id);
    expect(found.result.id).not.toBe(first.result.task.id);
    expect((await json(await lookup('recover', '/a2a/'))).result.id).toBe(second.result.task.id);
    expect((await json(await lookup('missing'))).result).toBeNull();
  });

  it('rejects unknown methods and unknown tasks with JSON-RPC errors', async () => {
    const bad = await json(await rpc('Foo/Bar', {}, 6));
    expect(bad.error).toBeDefined();
    const missing = await json(await rpc('GetTask', { tenant: '', id: 'nope' }, 7));
    expect(missing.error).toBeDefined();
  });
});
