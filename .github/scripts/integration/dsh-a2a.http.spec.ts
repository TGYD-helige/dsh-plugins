import { ServerResponse } from 'node:http';
import { Role, type Task, TaskState } from '@a2a-js/sdk';
import type { AgentExecutionEvent, AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import { AgentEvent, type RequestContext, ServerCallContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type A2aServer, startA2aServer } from '../../../packages/dsh-a2a/src/server.js';
import {
  type ManagedTaskStore,
  MemoryTaskStore,
  SanitizedTaskStore,
} from '../../../packages/dsh-a2a/src/task-store.js';

// A stub executor with the same event contract the real one uses: a task
// anchor first (A2A 1.0 stream ordering), then working, then input-required.
const stubExecutor: AgentExecutor = {
  async execute(requestContext: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    const dataPart = userMessage.parts.find((part) => part.content?.$case === 'data');
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
              {
                content: {
                  $case: 'data',
                  value: {
                    callId: 'call-1',
                    result: 'ok',
                    received: dataPart?.content?.$case === 'data' ? dataPart.content.value : null,
                  },
                },
                metadata: undefined,
                filename: '',
                mediaType: '',
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

  const legacy = (method: string, params: unknown, id = 1) =>
    fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

  const frames = async (res: Response): Promise<any[]> =>
    (await res.text())
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)));

  const legacyMessage = (text: string) => ({
    message: {
      kind: 'message',
      messageId: `legacy-${text}`,
      role: 'user',
      parts: [
        { kind: 'text', text },
        { kind: 'data', data: { input: 1 } },
      ],
    },
  });

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
    expect(interfaces[0].url).toBe(`${base}/a2a/`);
    // the legacyCompat mirror lets pre-1.0 clients in
    expect(interfaces[1]).toMatchObject({ protocolBinding: 'JSONRPC', protocolVersion: '0.3' });
  });

  it('serves a 0.3-shaped card to clients without an A2A-Version header', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`);
    const card = await json(res);
    expect(card.protocolVersion).toBe('0.3');
    expect(card.url).toBe(`${base}/a2a/`);
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.capabilities.streaming).toBe(true);
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

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
    'rejects invalid heartbeat intervals: %s',
    async (intervalMs) => {
      await expect(
        startA2aServer({
          host: '127.0.0.1',
          port: 0,
          basePath: '/a2a',
          card: { name: 'test-agent', description: 'test', version: '0.0.1' },
          executor: stubExecutor,
          taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
          heartbeat: { enabled: false, intervalMs },
        }),
      ).rejects.toThrow('heartbeat.intervalMs');
    },
  );

  it.each([
    'legacy send',
    'v1 send',
    'legacy subscribe',
    'v1 subscribe',
    'disabled',
    'default',
    'disconnect',
    'disposal',
    'stream error',
    'response error',
    'write failure',
    'backpressure',
  ])('configurable idle SSE heartbeat: %s', async (mode) => {
    await server.close();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let blocked = mode === 'backpressure';
    let response!: ServerResponse;
    const flush = ServerResponse.prototype.flushHeaders;
    const flushing = vi
      .spyOn(ServerResponse.prototype, 'flushHeaders')
      .mockImplementation(function (this: ServerResponse) {
        response = this;
        if (mode === 'write failure') {
          const write = this.write;
          Object.defineProperty(this, 'write', {
            value: (chunk: unknown, ...args: unknown[]) => {
              if (String(chunk).includes('"artifactId":"heartbeat"'))
                throw new Error('heartbeat failed');
              return Reflect.apply(write, this, [chunk, ...args]);
            },
          });
        }
        if (mode === 'backpressure')
          Object.defineProperty(this, 'writableNeedDrain', { get: () => blocked });
        flush.call(this);
      });
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test-agent', description: 'test', version: '0.0.1' },
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
      heartbeat: mode === 'default' ? undefined : { enabled: mode !== 'disabled', intervalMs: 15 },
      executor: {
        async execute(request, bus) {
          bus.publish(
            AgentEvent.task({
              id: request.taskId,
              contextId: request.contextId,
              status: {
                state: TaskState.TASK_STATE_WORKING,
                message: undefined,
                timestamp: new Date().toISOString(),
              },
              history: [request.userMessage],
              artifacts: [],
              metadata: undefined,
            }),
          );
          await paused;
          if (mode === 'stream error') throw new Error('executor failed');
          await stubExecutor.execute(request, {
            ...bus,
            publish: (event) => {
              if (event.kind !== 'task') bus.publish(event);
            },
            finished: () => bus.finished(),
          });
        },
        cancelTask: async () => {},
      },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const legacy = mode.startsWith('legacy');
      const heartbeat = '"artifactId":"heartbeat"';
      const call = (method: string, params: unknown) =>
        fetch(`http://127.0.0.1:${server.port}/a2a/`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(!legacy ? { 'A2A-Version': '1.0' } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id:
              method.includes('subscribe') || method === 'SubscribeToTask'
                ? 'subscription'
                : 'send',
            method,
            params,
          }),
          signal: controller.signal,
        });
      const invalid = await call('UnknownMethod', {});
      expect(invalid.headers.get('content-type')).toContain('application/json');
      expect(await invalid.json()).toHaveProperty('error');
      expect(intervals.mock.calls.filter(([, ms]) => ms === 15)).toHaveLength(0);
      const sent = await call(legacy ? 'message/stream' : 'SendStreamingMessage', {
        message: {
          messageId: 'heartbeat-user',
          role: 'user',
          parts: legacy ? [{ kind: 'text', text: 'hello' }] : [{ text: 'hello' }],
          ...(legacy ? { kind: 'message' } : {}),
        },
      });
      let res = sent;
      if (mode.endsWith('subscribe')) {
        const sendReader = sent.body!.getReader();
        const initial = JSON.parse(
          new TextDecoder()
            .decode((await sendReader.read()).value)
            .split('\n\n')[0]
            .slice(6),
        ).result;
        res = await call(legacy ? 'tasks/resubscribe' : 'SubscribeToTask', {
          id: legacy ? initial.id : initial.task.id,
        });
        await sendReader.cancel();
      }
      const reader = res.body!.getReader();
      let wire = '';
      if (mode === 'disabled' || mode === 'default' || blocked) {
        // Keep the executor paused beyond several ticks, then collect the complete wire.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(intervals.mock.calls.filter(([, ms]) => ms === 15)).toHaveLength(blocked ? 1 : 0);
        if (!blocked) resume();
        else {
          const first = await reader.read();
          wire += new TextDecoder().decode(first.value);
          expect(wire).not.toContain(heartbeat);
          blocked = false;
        }
      }
      // Legacy clients refresh their idle timeout only for parsed JSON messages.
      const parsedClient = legacy;
      let lastMessage = Date.now();
      let parsedThrough = 0;
      while (
        mode !== 'disabled' &&
        mode !== 'default' &&
        mode !== 'write failure' &&
        wire.split(heartbeat).length < (parsedClient ? 10 : 3)
      ) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              idleTimer = setTimeout(
                () => reject(new Error('parsed-message idle timeout')),
                parsedClient ? Math.max(1, 75 - (Date.now() - lastMessage)) : 2000,
              );
            }),
          ]);
          expect(chunk.done).toBe(false);
          wire += new TextDecoder().decode(chunk.value);
          const complete = wire.split('\n\n').slice(0, -1);
          for (const frame of complete.slice(parsedThrough)) {
            if (frame.startsWith('data: ')) {
              JSON.parse(frame.slice(6));
              lastMessage = Date.now();
            }
          }
          parsedThrough = complete.length;
        } finally {
          clearTimeout(idleTimer);
        }
      }
      if (mode === 'write failure') {
        await vi.waitFor(() =>
          expect(errors).toHaveBeenCalledWith(
            '[dsh-a2a] heartbeat write failed:',
            expect.objectContaining({ message: 'heartbeat failed' }),
          ),
        );
      }
      const timers = intervals.mock.results
        .filter((_, i) => intervals.mock.calls[i][1] === 15)
        .map((result) => result.value);
      if (mode === 'disconnect' || mode === 'disposal' || mode === 'response error') {
        if (mode === 'disconnect') await reader.cancel();
        else if (mode === 'response error') response.emit('error', new Error('response failed'));
        else await server.close();
        await vi.waitFor(() => {
          for (const timer of timers) expect(cleared).toHaveBeenCalledWith(timer);
        });
        return;
      }
      if (mode === 'write failure') {
        for (const timer of timers) expect(cleared).toHaveBeenCalledWith(timer);
      }
      resume();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        wire += new TextDecoder().decode(chunk.value);
      }
      const events = wire
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)));
      expect(wire).not.toContain(': heartbeat');
      if (mode !== 'disabled' && mode !== 'default' && mode !== 'write failure') {
        const anchor = legacy ? events[0].result : events[0].result.task;
        const beats = events.filter(
          (event) =>
            (legacy ? event.result.artifact : event.result.artifactUpdate?.artifact)?.name ===
            'heartbeat',
        );
        expect(beats.length).toBeGreaterThanOrEqual(2);
        for (const beat of beats) {
          expect(beat).toEqual({
            jsonrpc: '2.0',
            id: mode.endsWith('subscribe') ? 'subscription' : 'send',
            result: legacy
              ? {
                  kind: 'artifact-update',
                  taskId: anchor.id,
                  contextId: anchor.contextId,
                  artifact: { artifactId: 'heartbeat', name: 'heartbeat', parts: [] },
                  append: false,
                  lastChunk: false,
                }
              : {
                  artifactUpdate: {
                    taskId: anchor.id,
                    contextId: anchor.contextId,
                    artifact: { artifactId: 'heartbeat', name: 'heartbeat', parts: [] },
                    append: false,
                    lastChunk: false,
                  },
                },
          });
        }
        const stored = (await (
          await call(legacy ? 'tasks/get' : 'GetTask', { id: anchor.id })
        ).json()) as any;
        expect(stored.result.artifacts ?? []).toEqual([]);
      }
      if (mode === 'stream error') {
        expect(events.at(-1).result.statusUpdate.status.state).toBe('TASK_STATE_FAILED');
        expect(errors).toHaveBeenCalled();
      } else {
        const last = events.at(-1).result;
        const status = legacy ? last.status : last.statusUpdate.status;
        expect(status.state).toBe(legacy ? 'input-required' : 'TASK_STATE_INPUT_REQUIRED');
        expect(status.message.parts[0].text).toBe('done');
      }
      if (mode === 'disabled' || mode === 'default') expect(wire).not.toContain(heartbeat);
      else
        await vi.waitFor(() => {
          for (const timer of timers) expect(cleared).toHaveBeenCalledWith(timer);
        });
    } finally {
      clearTimeout(timeout);
      resume();
      controller.abort();
      await server.close();
      intervals.mockRestore();
      cleared.mockRestore();
      errors.mockRestore();
      flushing.mockRestore();
    }
  });

  it('ends a legacy interaction explicitly and accepts a same-task follow-up', async () => {
    const first = (await frames(await legacy('message/stream', legacyMessage('hello')))).at(
      -1,
    ).result;
    expect(first).toMatchObject({
      kind: 'status-update',
      status: { state: 'input-required' },
      final: true,
    });
    const next = legacyMessage('again');
    Object.assign(next.message, { taskId: first.taskId, contextId: first.contextId });
    const last = (await frames(await legacy('message/stream', next))).at(-1).result;
    expect(last).toMatchObject({
      taskId: first.taskId,
      status: { state: 'input-required' },
      final: true,
    });
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
      { role: 'agent', parts: expect.arrayContaining([{ kind: 'text', text: 'done' }]) },
    ]);
    await fetch(`${base}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/cancel',
        params: { id: sent.result.id },
      }),
    });
    while (!wire.includes('"final":true')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      wire += new TextDecoder().decode(chunk.value);
    }
    const updates = wire
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)).result)
      .filter((result) => result.kind === 'status-update');
    expect(updates.filter((result) => result.status.message?.parts?.[0]?.text === 'done')).toEqual(
      [],
    );
    await reader.cancel();
  });

  it.each(['live', 'delayedSnapshot', 'delayedSave', 'compacted'] as const)(
    'resubscribes without losing or duplicating a reply (%s)',
    async (mode) => {
      const delayedSnapshot = mode === 'delayedSnapshot';
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
          if (mode === 'compacted') for (let i = 1; i < 64; i++) bus.publish(status('A'));
          await paused;
          bus.publish(status('B'));
          bus.publish(
            status(
              `${mode === 'compacted' ? 'A'.repeat(64) : 'A'}B`,
              TaskState.TASK_STATE_INPUT_REQUIRED,
            ),
          );
          bus.finished();
        },
        cancelTask: async () => {},
      };
      const inner = new MemoryTaskStore();
      const originalSave = inner.save.bind(inner);
      let saveStarted!: () => void;
      let releaseSave!: () => void;
      const saving = new Promise<void>((resolve) => {
        saveStarted = resolve;
      });
      const saved = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      inner.save = async (task, context) => {
        if (mode === 'delayedSave' && task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
          saveStarted();
          await saved;
        }
        return originalSave(task, context);
      };
      const store = new SanitizedTaskStore(inner);
      const originalLoad = store.load.bind(store);
      let gateSnapshot = false;
      let snapshotStarted!: () => void;
      let releaseSnapshot!: () => void;
      const started = new Promise<void>((resolve) => {
        snapshotStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      store.load = async (taskId, context) => {
        if (gateSnapshot) {
          gateSnapshot = false;
          snapshotStarted();
          await released;
        }
        return originalLoad(taskId, context);
      };
      server = await startA2aServer({
        host: '127.0.0.1',
        port: 0,
        basePath: '/a2a',
        card: { name: 'test-agent', description: 'test', version: '0.0.1' },
        executor,
        taskStore: store,
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
      if (mode === 'delayedSave') {
        resume();
        await saving;
      }
      gateSnapshot = delayedSnapshot;
      const subscribedPromise = fetch(`${base}/a2a/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tasks/resubscribe',
          params: { id: taskId },
        }),
      });
      if (delayedSnapshot) {
        await started;
        resume();
        await vi.waitFor(async () => {
          const current = await json(await rpc('GetTask', { tenant: '', id: taskId }));
          expect(current.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
        });
        releaseSnapshot();
      }
      const subscribed = await subscribedPromise;
      const reader = subscribed.body!.getReader();
      let wire = '';
      const finalText = `${mode === 'compacted' ? 'A'.repeat(64) : 'A'}B`;
      const firstText = mode === 'compacted' ? 'A'.repeat(64) : mode === 'live' ? 'A' : 'AB';
      while (!wire.includes(`"text":"${firstText}"`))
        wire += new TextDecoder().decode((await reader.read()).value);
      const first = JSON.parse(wire.split('\n\n')[0].slice(6));
      expect(first.result.history).toMatchObject([
        { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
      ]);
      expect(first.result.history).toHaveLength(1);
      expect(first.result.status.message).toBeUndefined();
      if (mode === 'live' || mode === 'compacted') resume();
      while (!wire.includes(`"text":"${finalText}"`))
        wire += new TextDecoder().decode((await reader.read()).value);
      const events = wire
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)).result);
      const texts = events
        .filter((event) => event.kind === 'status-update')
        .map((event) => event.status.message?.parts?.[0]?.text);
      expect(texts.filter((text) => text === 'A')).toHaveLength(
        mode === 'delayedSave' || mode === 'compacted' ? 0 : 1,
      );
      expect(texts.filter((text) => text === 'B')).toHaveLength(mode === 'delayedSave' ? 0 : 1);
      if (mode === 'compacted')
        expect(texts.filter((text) => text === 'A'.repeat(64))).toHaveLength(1);
      expect(texts.filter((text) => text === finalText)).toHaveLength(1);
      if (mode === 'delayedSave') releaseSave();
      await reader.cancel();
      await sendReader.cancel();
    },
  );

  it.each(['before', 'during'] as const)(
    'uses a follow-up task anchor when the resubscribe snapshot is stale (%s)',
    async (timing) => {
      await server.close();
      const inner = new MemoryTaskStore();
      const originalSave = inner.save.bind(inner);
      let stale: Task | undefined;
      inner.save = async (task, context) => {
        if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED)
          stale = structuredClone(task);
        await originalSave(task, context);
      };
      const store = new SanitizedTaskStore(inner);
      const originalLoad = store.load.bind(store);
      let staleOnce = false;
      let snapshotStarted!: () => void;
      let releaseSnapshot!: () => void;
      const snapshotting = new Promise<void>((resolve) => {
        snapshotStarted = resolve;
      });
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      store.load = async (id, context) => {
        if (staleOnce) {
          staleOnce = false;
          snapshotStarted();
          if (timing === 'during') await snapshotGate;
          return structuredClone(stale);
        }
        return originalLoad(id, context);
      };
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let turns = 0;
      const executor: AgentExecutor = {
        async execute(request, bus) {
          if (++turns === 1) return stubExecutor.execute(request, bus);
          bus.publish(
            AgentEvent.task({
              id: request.taskId,
              contextId: request.contextId,
              status: {
                state: TaskState.TASK_STATE_SUBMITTED,
                message: undefined,
                timestamp: '2100-01-01T00:00:00.000Z',
              },
              history: [request.userMessage],
              artifacts: [],
              metadata: undefined,
            }),
          );
          bus.publish(
            AgentEvent.statusUpdate({
              taskId: request.taskId,
              contextId: request.contextId,
              status: {
                state: TaskState.TASK_STATE_SUBMITTED,
                message: undefined,
                timestamp: '2100-01-01T00:00:00.000Z',
              },
              metadata: undefined,
            }),
          );
          await paused;
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
        taskStore: store,
      });
      base = `http://127.0.0.1:${server.port}`;
      const sent = await json(await rpc('SendMessage', { tenant: '', ...v1Message('first') }));
      const task = sent.result.task;
      staleOnce = timing === 'during';
      const subscribedPromise =
        timing === 'during' ? rpc('SubscribeToTask', { tenant: '', id: task.id }) : undefined;
      if (timing === 'during') await snapshotting;
      const followup = await rpc('SendStreamingMessage', {
        tenant: '',
        ...v1Message('second', { taskId: task.id, contextId: task.contextId }),
      });
      const sendReader = followup.body!.getReader();
      await sendReader.read();
      if (timing === 'during') releaseSnapshot();
      else staleOnce = true;
      const subscribed = await (subscribedPromise ??
        rpc('SubscribeToTask', { tenant: '', id: task.id }));
      const reader = subscribed.body!.getReader();
      const first = JSON.parse(
        new TextDecoder()
          .decode((await reader.read()).value)
          .split('\n\n')[0]
          .slice(6),
      );
      expect(first.result.task.status.state).toBe('TASK_STATE_SUBMITTED');
      expect(first.result.task.history).toMatchObject([
        { parts: [{ text: 'first' }] },
        { parts: expect.arrayContaining([expect.objectContaining({ text: 'done' })]) },
        { parts: [{ text: 'second' }] },
      ]);
      await reader.cancel();
      release();
      await sendReader.cancel();
    },
  );

  it('serializes same-task admission without losing history or reordering execution', async () => {
    await server.close();
    const inner = new MemoryTaskStore();
    let armDelay = false;
    const delayed: ManagedTaskStore = {
      load: async (id, context) => {
        const task = await inner.load(id, context);
        if (armDelay && task) await new Promise((resolve) => setTimeout(resolve, 20));
        return task;
      },
      save: (task, context) => inner.save(task, context),
      list: (params, context) => inner.list(params, context),
      delete: (id, context) => inner.delete(id, context),
    };
    const executor: AgentExecutor = {
      execute: async (request, bus) => {
        const text = request.userMessage.parts[0]?.content;
        if (text?.$case === 'text' && text.value === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const scopedBus = {
          publish: (event: AgentExecutionEvent) => {
            if (event.kind === 'task' && text?.$case === 'text' && text.value !== 'initial') {
              event = {
                ...event,
                data: {
                  ...event.data,
                  status: {
                    ...event.data.status,
                    state: TaskState.TASK_STATE_WORKING,
                    message: undefined,
                    timestamp: event.data.status?.timestamp ?? new Date().toISOString(),
                  },
                  history: [],
                },
              };
            }
            bus.publish(event);
          },
          finished: () => bus.finished(),
        } as unknown as ExecutionEventBus;
        return stubExecutor.execute(request, scopedBus);
      },
      cancelTask: stubExecutor.cancelTask,
    };
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.0.1' },
      executor,
      taskStore: new SanitizedTaskStore(delayed),
    });
    base = `http://127.0.0.1:${server.port}`;
    const initial = await json(await rpc('SendMessage', { tenant: '', ...v1Message('initial') }));
    const taskId = initial.result.task.id;
    const contextId = initial.result.task.contextId;
    armDelay = true;
    await Promise.all([
      rpc('SendMessage', { tenant: '', ...v1Message('slow', { taskId, contextId }) }, 10),
      rpc('SendMessage', { tenant: '', ...v1Message('fast', { taskId, contextId }) }, 11),
    ]);
    const got = await json(await rpc('GetTask', { tenant: '', id: taskId }, 12));
    expect(got.result.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parts: expect.arrayContaining([{ text: 'slow' }]) }),
        expect.objectContaining({ parts: expect.arrayContaining([{ text: 'fast' }]) }),
      ]),
    );
  });

  it('does not serialize unrelated new contexts behind a stalled admission', async () => {
    await server.close();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const executor: AgentExecutor = {
      execute: async (request, bus) => {
        if (request.contextId === 'ctx-a') {
          started();
          await gate;
        }
        return stubExecutor.execute(request, bus);
      },
      cancelTask: stubExecutor.cancelTask,
    };
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.0.1' },
      executor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    });
    base = `http://127.0.0.1:${server.port}`;
    const first = rpc('SendMessage', { tenant: '', ...v1Message('slow', { contextId: 'ctx-a' }) });
    await firstStarted;
    const second = await Promise.race([
      rpc('SendMessage', { tenant: '', ...v1Message('fast', { contextId: 'ctx-b' }) }).then(json),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ctx-b blocked')), 500)),
    ]);
    expect(second.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    release();
    await first;
  });

  it('lists tasks via ListTasks with settled history', async () => {
    await rpc('SendMessage', { tenant: '', ...v1Message('hello') });
    const body = await json(await rpc('ListTasks', { tenant: '' }, 2));
    expect(body.error).toBeUndefined();
    expect(body.result.tasks).toHaveLength(1);
    expect(body.result.tasks[0].status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(body.result.tasks[0].history).toHaveLength(2);
    expect(body.result.tasks[0].history[1].parts[0].text).toBe('done');
    expect(body.result.totalSize).toBe(1);
  });

  it('restores a cold working task before checking cancellation ownership', async () => {
    await server.close();
    const store = new SanitizedTaskStore(new MemoryTaskStore());
    const context = new ServerCallContext({ tenant: '' });
    const snapshot: Task = {
      id: 'cold-working',
      contextId: 'cold-context',
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      history: [],
      artifacts: [],
      metadata: undefined,
    };
    await store.save(snapshot, context);
    const beforeTask = vi.fn(async (taskId: string, call: ServerCallContext) => {
      expect(taskId).toBe(snapshot.id);
      server.restoreTask(snapshot, call);
    });
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.0.1' },
      executor: stubExecutor,
      taskStore: store,
      beforeTask,
    });
    base = `http://127.0.0.1:${server.port}`;

    const canceled = await json(await rpc('CancelTask', { tenant: '', id: snapshot.id }, 20));
    expect(beforeTask).toHaveBeenCalledOnce();
    expect(canceled.error).toBeUndefined();
    expect(canceled.result.status.state).toBe('TASK_STATE_CANCELED');
  });

  it('fails closed when a non-owner receives a working-task cancellation', async () => {
    await server.close();
    const store = new SanitizedTaskStore(new MemoryTaskStore());
    const context = new ServerCallContext({ tenant: '' });
    await store.save(
      {
        id: 'remote-working',
        contextId: 'remote-context',
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        history: [],
        artifacts: [],
        metadata: undefined,
      },
      context,
    );
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.0.1' },
      executor: stubExecutor,
      taskStore: store,
    });
    base = `http://127.0.0.1:${server.port}`;

    const canceled = await json(await rpc('CancelTask', { tenant: '', id: 'remote-working' }, 20));
    expect(canceled.error?.message).toContain('another worker');
    const got = await json(await rpc('GetTask', { tenant: '', id: 'remote-working' }, 21));
    expect(got.result.status.state).toBe('TASK_STATE_WORKING');
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

  it('round-trips 0.3 send, get, and cancel with text and data parts', async () => {
    const res = await legacy('message/send', legacyMessage('hello'), 9);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.error).toBeUndefined();
    expect(body.result.kind).toBe('task');
    expect(body.result.id).toEqual(expect.any(String));
    expect(body.result.contextId).toEqual(expect.any(String));
    expect(body.result.status.state).toBe('input-required');
    expect(body.result.status.message.parts).toEqual([
      { kind: 'text', text: 'done' },
      { kind: 'data', data: { callId: 'call-1', result: 'ok', received: { input: 1 } } },
    ]);
    const id = body.result.id;
    const got = await json(await legacy('tasks/get', { id }, 10));
    expect(got.result).toMatchObject({ kind: 'task', id, status: { state: 'input-required' } });
    const canceled = await json(await legacy('tasks/cancel', { id }, 11));
    expect(canceled.result).toMatchObject({ kind: 'task', id, status: { state: 'canceled' } });
    const rejected = await json(
      await legacy('message/send', {
        message: {
          ...legacyMessage('again').message,
          taskId: id,
          contextId: body.result.contextId,
        },
      }),
    );
    expect(rejected.error).toBeDefined();
  });

  it('streams 0.3 envelopes and resubscribes until cancellation', async () => {
    const streamed = await legacy('message/stream', legacyMessage('stream'));
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    const events = await frames(streamed);
    expect(events[0].result).toMatchObject({ kind: 'task', status: { state: 'submitted' } });
    const { id, contextId } = events[0].result;
    expect(events.at(-1).result).toMatchObject({
      kind: 'status-update',
      taskId: id,
      contextId,
      status: {
        state: 'input-required',
        message: {
          parts: [
            { kind: 'text', text: 'done' },
            { kind: 'data', data: { received: { input: 1 } } },
          ],
        },
      },
      final: true,
    });

    const subscription = await legacy('tasks/resubscribe', { id }, 2);
    expect(subscription.headers.get('content-type')).toContain('text/event-stream');
    const reader = subscription.body!.getReader();
    let received = '';
    while (!received.includes('\n\n')) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      received += new TextDecoder().decode(next.value);
    }
    const first = JSON.parse(received.split('\n\n')[0].slice(6));
    expect(first).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { kind: 'task', id, status: { state: 'input-required' } },
    });
    const canceled = await json(await legacy('tasks/cancel', { id }, 3));
    expect(canceled.result.status.state).toBe('canceled');
    while (
      !received
        .split('\n\n')
        .slice(0, -1)
        .some((frame) => frame.includes('"final":true'))
    ) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      received += new TextDecoder().decode(next.value);
    }
    const last = JSON.parse(received.split('\n\n').filter(Boolean).at(-1)!.slice(6));
    expect(last).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { kind: 'status-update', taskId: id, status: { state: 'canceled' }, final: true },
    });
    expect((await reader.read()).done).toBe(true);
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
