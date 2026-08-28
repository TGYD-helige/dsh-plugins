import { Role, TaskState } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import { AgentEvent, InMemoryTaskStore, type RequestContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type A2aServer, startA2aServer } from './server.js';
import { SanitizedTaskStore } from './task-store.js';

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
      taskStore: new SanitizedTaskStore(new InMemoryTaskStore()),
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

  it('rejects unknown methods and unknown tasks with JSON-RPC errors', async () => {
    const bad = await json(await rpc('Foo/Bar', {}, 6));
    expect(bad.error).toBeDefined();
    const missing = await json(await rpc('GetTask', { tenant: '', id: 'nope' }, 7));
    expect(missing.error).toBeDefined();
  });
});
