import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import { InMemoryTaskStore, type RequestContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type A2aServer, startA2aServer } from './server.js';
import { SanitizedTaskStore } from './task-store.js';

// A stub executor with the same event contract the real one uses.
const stubExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    const now = new Date().toISOString();
    bus.publish({
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'submitted', timestamp: now },
      history: [userMessage],
    });
    bus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: now },
      final: false,
    });
    bus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'input-required',
        message: {
          kind: 'message',
          role: 'agent',
          messageId: 'a1',
          parts: [{ kind: 'text', text: 'done' }],
          taskId,
          contextId,
        },
        timestamp: now,
      },
      final: true,
    });
    bus.finished();
  },
  cancelTask: async (taskId, bus) => {
    bus.publish({
      kind: 'status-update',
      taskId,
      contextId: '',
      status: { state: 'canceled', timestamp: new Date().toISOString() },
      final: true,
    });
  },
};

describe('A2A HTTP server', () => {
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  const json = (res: Response): Promise<any> => res.json();

  const sendParams = (text: string, extra: Record<string, unknown> = {}) => ({
    message: {
      kind: 'message',
      messageId: `m-${Math.random()}`,
      role: 'user',
      parts: [{ kind: 'text', text }],
      ...extra,
    },
  });

  it('serves the agent card on the well-known path and the legacy alias', async () => {
    for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const card = await json(res);
      expect(card.name).toBe('test-agent');
      expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
      expect(card.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a2a\/$/);
    }
  });

  it('answers a blocking message/send with the final task state', async () => {
    const res = await rpc('message/send', sendParams('hello'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.error).toBeUndefined();
    expect(body.result.kind).toBe('task');
    expect(body.result.status.state).toBe('input-required');
    expect(body.result.status.message.parts).toEqual([{ kind: 'text', text: 'done' }]);
    expect(body.result.history[0].parts).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('streams message/stream over SSE and terminates on the final event', async () => {
    const res = await rpc('message/stream', sendParams('hello'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const frames = text
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)));
    expect(frames.every((f) => f.jsonrpc === '2.0')).toBe(true);
    const results = frames.map((f) => f.result);
    expect(results[0].kind).toBe('task');
    const final = results.at(-1);
    expect(final.kind).toBe('status-update');
    expect(final.status.state).toBe('input-required');
    expect(final.final).toBe(true);
  });

  it('round-trips tasks/get with history stripped (task state only)', async () => {
    const sent = await json(await rpc('message/send', sendParams('hello')));
    const taskId = sent.result.id;
    const res = await rpc('tasks/get', { id: taskId }, 2);
    const body = await json(res);
    expect(body.result.id).toBe(taskId);
    expect(body.result.status.state).toBe('input-required');
    expect(body.result.history).toEqual([]);
  });

  it('cancels a non-terminal task', async () => {
    const sent = await json(await rpc('message/send', sendParams('hello')));
    const res = await rpc('tasks/cancel', { id: sent.result.id }, 3);
    const body = await json(res);
    expect(body.result.status.state).toBe('canceled');
  });

  it('rejects unknown methods and unknown tasks with JSON-RPC errors', async () => {
    const bad = await json(await rpc('foo/bar', {}, 4));
    expect(bad.error).toBeDefined();
    expect(bad.error.code).toBe(-32601);

    const missing = await json(await rpc('tasks/get', { id: 'nope' }, 5));
    expect(missing.error.code).toBe(-32001); // A2A taskNotFound
  });

  it('rejects follow-ups to terminal tasks (SDK terminal-state guard)', async () => {
    const sent = await json(await rpc('message/send', sendParams('hello')));
    await rpc('tasks/cancel', { id: sent.result.id }, 6);
    const res = await json(
      await rpc('message/send', sendParams('again', { taskId: sent.result.id }), 7),
    );
    expect(res.error).toBeDefined();
  });
});
