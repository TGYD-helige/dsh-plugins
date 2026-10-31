import { getEventListeners, once } from 'node:events';
import { createServer, request, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTasksRequest,
  Message,
  Role,
  SendMessageRequest,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
  TaskState,
} from '@a2a-js/sdk';
import { LegacyA2AService } from '@a2a-js/sdk/compat/v0_3/server/grpc';
import type { AgentExecutionEvent, AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import {
  AgentEvent,
  type RequestContext,
  ServerCallContext,
  STATE_HEADERS_KEY,
} from '@a2a-js/sdk/server';
import { A2AService } from '@a2a-js/sdk/server/grpc';
import { credentials, Metadata, makeGenericClientConstructor } from '@grpc/grpc-js';
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

  it('shares task state between the official REST and JSON-RPC bindings', async () => {
    await server.close();
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      rest: true,
      pushNotifications: true,
      card: { name: 'test-agent', description: 'test', version: '0.0.1' },
      executor: stubExecutor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    });
    base = `http://127.0.0.1:${server.port}`;
    const sent = await fetch(`${base}/a2a/rest/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/a2a+json', 'A2A-Version': '1.0' },
      body: JSON.stringify(v1Message('rest')),
    });
    expect(sent.status).toBe(200);
    const { task } = await json(sent);
    expect(task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect((await json(await rpc('GetTask', { id: task.id }))).result.id).toBe(task.id);
    const listed = await json(
      await fetch(`${base}/a2a/rest/tasks?contextId=${task.contextId}`, {
        headers: { 'A2A-Version': '1.0' },
      }),
    );
    expect(listed.tasks.map((item: any) => item.id)).toEqual([task.id]);
    const card = await json(
      await fetch(`${base}/.well-known/agent-card.json`, {
        headers: { 'A2A-Version': '1.0' },
      }),
    );
    expect(card.supportedInterfaces).toContainEqual(
      expect.objectContaining({
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
        url: `${base}/a2a/rest`,
      }),
    );
    const rest = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}/a2a/rest${path}`, {
        method,
        headers: { 'A2A-Version': '1.0', 'content-type': 'application/a2a+json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await json(await rest(`/tasks/${task.id}`))).id).toBe(task.id);
    expect((await rest(`/other/tasks/${task.id}`)).status).toBe(404);
    const config = await json(
      await rest(`/tasks/${task.id}/pushNotificationConfigs`, 'POST', {
        taskId: task.id,
        url: 'http://127.0.0.1:1/callback',
      }),
    );
    expect(config.id).toBeTruthy();
    expect(
      (await json(await rpc('GetTaskPushNotificationConfig', { taskId: task.id, id: config.id })))
        .result.url,
    ).toBe(config.url);
    expect(
      (await json(await rest(`/tasks/${task.id}/pushNotificationConfigs`))).configs,
    ).toHaveLength(1);
    expect(
      (await json(await rest(`/tasks/${task.id}/pushNotificationConfigs/${config.id}`))).id,
    ).toBe(config.id);
    expect(
      (await rest(`/tasks/${task.id}/pushNotificationConfigs/${config.id}`, 'DELETE')).status,
    ).toBe(204);
    const stream = await frames(await rest('/message:stream', 'POST', v1Message('rest-stream')));
    expect(stream[0].task).toBeDefined();
    expect(stream.at(-1).statusUpdate.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const subscription = await rest(`/tasks/${task.id}:subscribe`);
    const canceled = await json(await rest(`/tasks/${task.id}:cancel`, 'POST', {}));
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');
    expect((await frames(subscription)).at(-1).statusUpdate.status.state).toBe(
      'TASK_STATE_CANCELED',
    );
    const oldResponse = await fetch(`${base}/a2a/rest/v1/message:send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '0.3' },
      body: JSON.stringify(v1Message('legacy-rest', { role: 'ROLE_USER' })),
    });
    expect(oldResponse.status).toBe(201);
    const old = await json(oldResponse);
    expect(old.task.id).toBeTruthy();
  });

  it('serves the host-authorized extended card without leaking it in discovery', async () => {
    let publicCard: AgentCard;
    await server.close();
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      rest: true,
      card: { name: 'public-agent', description: 'test', version: '0.0.1' },
      executor: stubExecutor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
      extendedAgentCard: async (context) => {
        const headers = context.state.get(STATE_HEADERS_KEY) as Record<string, string>;
        if (headers.authorization !== 'Bearer card-reader') throw new Error('Unauthorized');
        return { ...publicCard, name: 'private-agent' };
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    publicCard = await json(
      await fetch(`${base}/.well-known/agent-card.json`, {
        headers: { 'A2A-Version': '1.0' },
      }),
    );
    expect(publicCard.capabilities?.extendedAgentCard).toBe(true);
    expect(publicCard.name).toBe('public-agent');
    const denied = await json(await rpc('GetExtendedAgentCard', {}));
    expect(denied.error).toBeDefined();
    expect(denied.result).toBeUndefined();
    for (const transport of ['rpc', 'rest']) {
      const res = await fetch(
        transport === 'rpc' ? `${base}/a2a/` : `${base}/a2a/rest/extendedAgentCard`,
        {
          method: transport === 'rpc' ? 'POST' : 'GET',
          headers: {
            'content-type': 'application/json',
            'A2A-Version': '1.0',
            authorization: 'Bearer card-reader',
          },
          body:
            transport === 'rpc'
              ? JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'GetExtendedAgentCard',
                  params: {},
                })
              : undefined,
        },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect((transport === 'rpc' ? body.result : body).name).toBe('private-agent');
    }
  });

  it('shares tasks with the official gRPC service and closes its listener', async () => {
    let publicCard: AgentCard;
    await server.close();
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      grpc: { enabled: true, port: 0 },
      pushNotifications: true,
      card: { name: 'grpc-agent', description: 'test', version: '0.0.1' },
      extendedAgentCard: async (context) => {
        const headers = context.state.get(STATE_HEADERS_KEY) as Record<string, string>;
        if (headers.authorization !== 'Bearer grpc-reader') throw new Error('Unauthorized');
        return { ...publicCard, name: 'private-grpc-agent' };
      },
      executor: stubExecutor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    });
    base = `http://127.0.0.1:${server.port}`;
    expect(server.grpcPort).toBeGreaterThan(0);
    const Client = makeGenericClientConstructor(A2AService, 'A2AService');
    const client = new Client(`127.0.0.1:${server.grpcPort}`, credentials.createInsecure());
    const metadata = new Metadata();
    metadata.set('a2a-version', '1.0');
    const call = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        client[method](
          params,
          metadata,
          { deadline: Date.now() + 2000 },
          (error: Error | null, value: unknown) => (error ? reject(error) : resolve(value)),
        );
      });
    try {
      const sent = await call('sendMessage', SendMessageRequest.fromJSON(v1Message('grpc')));
      expect(sent.payload.$case).toBe('task');
      const task = sent.payload.value;
      expect(task.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      expect((await json(await rpc('GetTask', { id: task.id }))).result.id).toBe(task.id);
      const listed = await call(
        'listTasks',
        ListTasksRequest.fromJSON({ contextId: task.contextId }),
      );
      expect(listed.tasks.map((item: Task) => item.id)).toEqual([task.id]);
      const card = await json(
        await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } }),
      );
      publicCard = card;
      expect(card.supportedInterfaces).toContainEqual(
        expect.objectContaining({
          protocolBinding: 'GRPC',
          protocolVersion: '1.0',
          url: `127.0.0.1:${server.grpcPort}`,
        }),
      );
      expect((await call('getTask', GetTaskRequest.fromJSON({ id: task.id }))).id).toBe(task.id);
      await expect(
        call('getTask', GetTaskRequest.fromJSON({ tenant: 'other', id: task.id })),
      ).rejects.toThrow();
      const config = await call(
        'createTaskPushNotificationConfig',
        TaskPushNotificationConfig.fromJSON({
          taskId: task.id,
          url: 'http://127.0.0.1:1/callback',
        }),
      );
      expect(
        (
          await call(
            'getTaskPushNotificationConfig',
            GetTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: config.id }),
          )
        ).id,
      ).toBe(config.id);
      expect(
        (
          await call(
            'listTaskPushNotificationConfigs',
            ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }),
          )
        ).configs,
      ).toHaveLength(1);
      await call(
        'deleteTaskPushNotificationConfig',
        DeleteTaskPushNotificationConfigRequest.fromJSON({ taskId: task.id, id: config.id }),
      );
      expect(
        (
          await call(
            'listTaskPushNotificationConfigs',
            ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: task.id }),
          )
        ).configs,
      ).toHaveLength(0);
      await expect(
        call('getExtendedAgentCard', GetExtendedAgentCardRequest.fromJSON({})),
      ).rejects.toThrow();
      metadata.set('authorization', 'Bearer grpc-reader');
      expect(
        (await call('getExtendedAgentCard', GetExtendedAgentCardRequest.fromJSON({}))).name,
      ).toBe('private-grpc-agent');
      const streamed: any[] = [];
      await new Promise<void>((resolve, reject) => {
        client
          .sendStreamingMessage(SendMessageRequest.fromJSON(v1Message('grpc-stream')), metadata)
          .on('data', (event: unknown) => streamed.push(event))
          .on('end', resolve)
          .on('error', reject);
      });
      expect(streamed[0].payload.$case).toBe('task');
      expect(streamed.at(-1).payload.value.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      const subscription = client.subscribeToTask(
        SubscribeToTaskRequest.fromJSON({ id: task.id }),
        metadata,
      );
      const events: any[] = [];
      subscription.on('data', (event: unknown) => events.push(event));
      const ended = once(subscription, 'end');
      await once(subscription, 'data');
      expect(
        (await call('cancelTask', CancelTaskRequest.fromJSON({ id: task.id }))).status.state,
      ).toBe(TaskState.TASK_STATE_CANCELED);
      await ended;
      expect(events.at(-1).payload.value.status.state).toBe(TaskState.TASK_STATE_CANCELED);
      const LegacyClient = makeGenericClientConstructor(LegacyA2AService, 'LegacyA2AService');
      const legacyClient = new LegacyClient(
        `127.0.0.1:${server.grpcPort}`,
        credentials.createInsecure(),
      );
      try {
        const legacyMetadata = new Metadata();
        legacyMetadata.set('a2a-version', '0.3');
        legacyMetadata.set('authorization', 'Bearer grpc-reader');
        const legacyCard = await new Promise<any>((resolve, reject) =>
          legacyClient.getAgentCard({}, legacyMetadata, (error: Error | null, value: unknown) =>
            error ? reject(error) : resolve(value),
          ),
        );
        expect(legacyCard.name).toBe('private-grpc-agent');
      } finally {
        legacyClient.close();
      }
      const live = client.subscribeToTask(
        SubscribeToTaskRequest.fromJSON({ id: streamed[0].payload.value.id }),
        metadata,
      );
      await once(live, 'data');
      const disconnected = once(live, 'error');
      await server.close();
      expect((await disconnected)[0].code).toBeGreaterThan(0);
      await expect(call('getTask', GetTaskRequest.fromJSON({ id: task.id }))).rejects.toThrow();
    } finally {
      client.close();
    }
  });

  it('releases the HTTP listener if the optional gRPC bind fails', async () => {
    const httpPort = server.port;
    await server.close();
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const grpcPort = (occupied.address() as AddressInfo).port;
    const options = {
      host: '127.0.0.1',
      port: httpPort,
      basePath: '/a2a',
      card: { name: 'bind-failure', description: '', version: '0.0.1' },
      executor: stubExecutor,
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    };
    try {
      await expect(
        startA2aServer({ ...options, grpc: { enabled: true, port: grpcPort } }),
      ).rejects.toThrow();
      server = await startA2aServer(options);
      expect(server.port).toBe(httpPort);
      expect(server.grpcPort).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it.each(['rest', 'grpc'])(
    'releases disconnected %s subscribers without canceling the task',
    async (transport) => {
      const buses = new Set<EventTarget>();
      const add = EventTarget.prototype.addEventListener;
      const tracking = vi
        .spyOn(EventTarget.prototype, 'addEventListener')
        .mockImplementation(function (
          this: EventTarget,
          ...args: Parameters<EventTarget['addEventListener']>
        ) {
          if (args[0] === 'event' || args[0] === 'finished') buses.add(this);
          return add.apply(this, args);
        });
      const listeners = () =>
        [...buses].reduce(
          (count, bus) =>
            count +
            getEventListeners(bus, 'event').length +
            getEventListeners(bus, 'finished').length,
          0,
        );
      await server.close();
      const store = new SanitizedTaskStore(new MemoryTaskStore());
      const context = new ServerCallContext({ tenant: '' });
      const task: Task = {
        id: 'idle-subscription',
        contextId: 'idle-context',
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        history: [],
        artifacts: [],
        metadata: undefined,
      };
      await store.save(task, context);
      server = await startA2aServer({
        host: '127.0.0.1',
        port: 0,
        basePath: '/a2a',
        rest: true,
        grpc: { enabled: transport === 'grpc', port: 0 },
        card: { name: 'disconnect', description: '', version: '0.0.1' },
        executor: stubExecutor,
        taskStore: store,
      });
      const bus = server.restoreTask(task, context);
      base = `http://127.0.0.1:${server.port}`;
      const Client = makeGenericClientConstructor(A2AService, 'A2AService');
      const client = new Client(`127.0.0.1:${server.grpcPort || 1}`, credentials.createInsecure());
      const metadata = new Metadata();
      metadata.set('a2a-version', '1.0');
      try {
        const baseline = listeners();
        for (let attempt = 0; attempt < 3; attempt++) {
          if (transport === 'grpc') {
            const subscription = client.subscribeToTask(
              SubscribeToTaskRequest.fromJSON({ id: task.id }),
              metadata,
            );
            const failed = once(subscription, 'error');
            await once(subscription, 'data');
            expect(listeners()).toBeGreaterThan(baseline);
            subscription.cancel();
            await failed;
          } else {
            const response = await fetch(`${base}/a2a/rest/tasks/${task.id}:subscribe`, {
              headers: { 'A2A-Version': '1.0' },
            });
            const reader = response.body!.getReader();
            await reader.read();
            expect(listeners()).toBeGreaterThan(baseline);
            await reader.cancel();
          }
          await vi.waitFor(() => expect(listeners()).toBe(baseline));
        }
        expect((await json(await rpc('GetTask', { id: task.id }))).result.status.state).toBe(
          'TASK_STATE_INPUT_REQUIRED',
        );
      } finally {
        bus.finished();
        client.close();
        tracking.mockRestore();
      }
    },
  );

  it('serves the v1 agent card on the well-known path', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(res.status).toBe(200);
    const card = await json(res);
    expect(card.name).toBe('test-agent');
    expect(card.capabilities).toMatchObject({ streaming: true, pushNotifications: false });
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

  it.each(['', '/v1'])('uses REST SSE frames for idle heartbeats (%s)', async (prefix) => {
    await server.close();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      rest: true,
      heartbeat: { enabled: true, intervalMs: 10 },
      card: { name: 'rest-heartbeat', description: '', version: '0.0.1' },
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
      executor: {
        ...stubExecutor,
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
              history: [],
              artifacts: [],
              metadata: undefined,
            }),
          );
          await paused;
          await stubExecutor.execute(request, bus);
        },
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/a2a/rest${prefix}/message:stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': prefix ? '0.3' : '1.0' },
          body: JSON.stringify(v1Message('heartbeat', prefix ? { role: 'ROLE_USER' } : {})),
          signal: controller.signal,
        },
      );
      if (!response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error(await response.text());
      const reader = response.body!.getReader();
      let wire = '';
      while (!wire.includes('"artifactId":"heartbeat"'))
        wire += new TextDecoder().decode((await reader.read()).value);
      const events = wire
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)));
      expect(events.some((event) => event.artifactUpdate?.artifact?.name === 'heartbeat')).toBe(
        true,
      );
      expect(events.every((event) => event.jsonrpc === undefined)).toBe(true);
      await reader.cancel();
    } finally {
      clearTimeout(timer);
      resume();
    }
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

  it('uses standard task subscriptions for two clients and reads history with GetTask', async () => {
    const sent = await json(await rpc('SendMessage', { tenant: '', ...v1Message('shared') }));
    const id = sent.result.task.id;
    const subscriptions = await Promise.all([
      rpc('SubscribeToTask', { tenant: '', id }, 31),
      rpc('SubscribeToTask', { tenant: '', id }, 32),
    ]);
    for (const response of subscriptions) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    }
    const history = await json(await rpc('GetTask', { tenant: '', id, historyLength: 10 }, 33));
    expect(history.result.history[0].parts[0].text).toBe('shared');
    const updates = subscriptions.map(frames);
    const abandoned = await rpc('SubscribeToTask', { tenant: '', id }, 35);
    await abandoned.body!.cancel();
    await rpc('CancelTask', { tenant: '', id }, 34);
    const [first, second] = await Promise.all(updates);
    expect(first.map((frame) => frame.result)).toEqual(second.map((frame) => frame.result));
    expect(first.at(-1).result.statusUpdate).toMatchObject({
      taskId: id,
      status: { state: 'TASK_STATE_CANCELED' },
    });
  });

  it.each(['v1', 'legacy'])(
    'persists completion independently of a paused %s HTTP reader',
    async (wire) => {
      await server.close();
      let taskId = '';
      let executed!: () => void;
      const finished = new Promise<void>((resolve) => {
        executed = resolve;
      });
      server = await startA2aServer({
        host: '127.0.0.1',
        port: 0,
        basePath: '/a2a',
        card: { name: 'slow-reader', description: '', version: '0.0.1' },
        taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
        executor: {
          async execute(context, bus) {
            taskId = context.taskId;
            bus.publish(
              AgentEvent.task(
                Task.fromJSON({
                  id: taskId,
                  contextId: context.contextId,
                  status: { state: 'TASK_STATE_WORKING' },
                  history: [],
                }),
              ),
            );
            for (let index = 0; index < 30; index++)
              bus.publish(
                AgentEvent.statusUpdate({
                  taskId,
                  contextId: context.contextId,
                  metadata: undefined,
                  status: {
                    state: TaskState.TASK_STATE_WORKING,
                    timestamp: undefined,
                    message: Message.fromJSON({
                      messageId: `chunk-${index}`,
                      role: 'ROLE_AGENT',
                      parts: [{ text: 'x'.repeat(512 * 1024) }],
                    }),
                  },
                }),
              );
            bus.publish(
              AgentEvent.statusUpdate({
                taskId,
                contextId: context.contextId,
                metadata: undefined,
                status: {
                  state: TaskState.TASK_STATE_COMPLETED,
                  message: undefined,
                  timestamp: undefined,
                },
              }),
            );
            bus.finished();
            executed();
          },
          cancelTask: async () => {},
        },
      });
      base = `http://127.0.0.1:${server.port}`;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: wire === 'v1' ? 'SendStreamingMessage' : 'message/stream',
        params: wire === 'v1' ? v1Message('slow') : legacyMessage('slow'),
      });
      const client = request(
        `${base}/a2a/`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'A2A-Version': wire === 'v1' ? '1.0' : '0.3',
          },
        },
        (response) => {
          response.on('error', () => {});
          response.pause();
        },
      );
      client.on('error', () => {});
      client.end(body);
      try {
        await finished;
        await vi.waitFor(
          async () => {
            const result = await json(await rpc('GetTask', { id: taskId, historyLength: 0 }));
            expect(result.result.status.state).toBe('TASK_STATE_COMPLETED');
          },
          { timeout: 5000 },
        );
      } finally {
        client.destroy();
      }
    },
  );

  async function pushFixture() {
    await server.close();
    const received: Array<{
      body: any;
      contentType: string | undefined;
      authorization: string | undefined;
      token: string | string[] | undefined;
    }> = [];
    let status = 204;
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        body: JSON.parse(Buffer.concat(chunks).toString()),
        contentType: request.headers['content-type'],
        authorization: request.headers.authorization,
        token: request.headers['x-a2a-notification-token'],
      });
      response.writeHead(status).end();
    });
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/a2a-notifications`;
    const store = new SanitizedTaskStore(new MemoryTaskStore());
    server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: '', version: '1' },
      executor: stubExecutor,
      taskStore: store,
      pushNotifications: true,
    });
    base = `http://127.0.0.1:${server.port}`;
    return {
      store,
      received,
      url,
      fail: () => {
        status = 503;
      },
      close: async () => {
        receiver.closeAllConnections();
        await new Promise<void>((resolve) => receiver.close(() => resolve()));
      },
    };
  }

  it('delivers official A2A webhook payloads configured through SendMessage', async () => {
    const f = await pushFixture();
    try {
      const card = await json(
        await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } }),
      );
      expect(card.capabilities.pushNotifications).toBe(true);
      const sent = await json(
        await rpc('SendMessage', {
          tenant: '',
          ...v1Message('official-push'),
          configuration: {
            taskPushNotificationConfig: {
              url: f.url,
              authentication: { scheme: 'Bearer', credentials: 'fixture-token' },
            },
          },
        }),
      );
      expect(sent.error).toBeUndefined();
      const id = sent.result.task.id;
      await vi.waitFor(() =>
        expect(
          f.received.some(
            (event) => event.body.statusUpdate?.status?.state === 'TASK_STATE_INPUT_REQUIRED',
          ),
        ).toBe(true),
      );
      expect(
        f.received.every(
          (event) =>
            event.contentType === 'application/a2a+json' &&
            event.authorization === 'Bearer fixture-token',
        ),
      ).toBe(true);
      expect(f.received[0].body.task).toMatchObject({ id, contextId: sent.result.task.contextId });
      expect(f.received.at(-1)!.body.statusUpdate).toMatchObject({
        taskId: id,
        status: { message: { parts: [{ text: 'done' }, expect.anything()] } },
      });
    } finally {
      await f.close();
    }
  });

  it('registers, reads, lists and deletes official webhook configs for an existing task', async () => {
    const f = await pushFixture();
    try {
      const sent = await json(
        await rpc('SendMessage', { tenant: 'owner', ...v1Message('before-registration') }),
      );
      const { id, contextId } = sent.result.task;
      expect(f.received).toEqual([]);
      const created = await json(
        await rpc(
          'CreateTaskPushNotificationConfig',
          {
            tenant: 'owner',
            taskId: id,
            url: f.url,
            authentication: { scheme: 'Bearer', credentials: 'fixture-token' },
          },
          41,
        ),
      );
      expect(created.error).toBeUndefined();
      const configId = created.result.id;
      expect(configId).toEqual(expect.any(String));
      expect(configId.length).toBeGreaterThan(0);
      const configs = await json(
        await rpc('ListTaskPushNotificationConfigs', { tenant: 'owner', taskId: id }, 42),
      );
      expect(configs.result.configs).toHaveLength(1);
      const got = await json(
        await rpc(
          'GetTaskPushNotificationConfig',
          { tenant: 'owner', taskId: id, id: configId },
          43,
        ),
      );
      expect(got.result).toMatchObject({ id: configId, url: f.url });
      expect(
        (
          await json(
            await rpc(
              'GetTaskPushNotificationConfig',
              { tenant: 'other', taskId: id, id: configId },
              44,
            ),
          )
        ).error,
      ).toBeDefined();
      await rpc(
        'SendMessage',
        { tenant: 'owner', ...v1Message('after-registration', { taskId: id, contextId }) },
        45,
      );
      await vi.waitFor(() =>
        expect(
          f.received.some(
            (event) => event.body.statusUpdate?.status?.state === 'TASK_STATE_INPUT_REQUIRED',
          ),
        ).toBe(true),
      );
      await rpc(
        'DeleteTaskPushNotificationConfig',
        { tenant: 'owner', taskId: id, id: configId },
        46,
      );
      expect(
        (
          await json(
            await rpc('ListTaskPushNotificationConfigs', { tenant: 'owner', taskId: id }, 47),
          )
        ).result.configs ?? [],
      ).toEqual([]);
      const count = f.received.length;
      await rpc(
        'SendMessage',
        { tenant: 'owner', ...v1Message('after-deletion', { taskId: id, contextId }) },
        48,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.received).toHaveLength(count);
    } finally {
      await f.close();
    }
  });

  it('pushes native restored task progress and completion through the official sender', async () => {
    const f = await pushFixture();
    try {
      const context = new ServerCallContext({ tenant: '' });
      const task: Task = {
        id: 'restored-push',
        contextId: 'restored-context',
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        history: [],
        artifacts: [],
        metadata: undefined,
      };
      await f.store.save(task, context);
      const bus = server.restoreTask(task, context);
      const created = await json(
        await rpc(
          'CreateTaskPushNotificationConfig',
          {
            taskId: task.id,
            url: f.url,
            authentication: { scheme: 'Bearer', credentials: 'fixture-restored' },
          },
          52,
        ),
      );
      expect(created.error).toBeUndefined();
      bus.publish(AgentEvent.task(task));
      for (const state of [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_COMPLETED])
        bus.publish(
          AgentEvent.statusUpdate({
            taskId: task.id,
            contextId: task.contextId,
            status: { state, message: undefined, timestamp: new Date().toISOString() },
            metadata: undefined,
          }),
        );
      bus.finished();
      await vi.waitFor(() => expect(f.received).toHaveLength(3));
      expect(f.received[0].body.task.id).toBe(task.id);
      expect(f.received.slice(1).map((event) => event.body.statusUpdate.status.state)).toEqual([
        'TASK_STATE_WORKING',
        'TASK_STATE_COMPLETED',
      ]);
      expect(
        f.received.every(
          (event) =>
            event.authorization === 'Bearer fixture-restored' &&
            event.contentType === 'application/a2a+json',
        ),
      ).toBe(true);
      expect((await json(await rpc('GetTask', { id: task.id }, 53))).result.status.state).toBe(
        'TASK_STATE_COMPLETED',
      );
    } finally {
      await f.close();
    }
  });

  it('uses the official v0.3 push serializer for a legacy client', async () => {
    const f = await pushFixture();
    try {
      const sent = await json(
        await legacy('message/send', {
          ...legacyMessage('legacy-push'),
          configuration: { pushNotificationConfig: { url: f.url, token: 'fixture-legacy-token' } },
        }),
      );
      expect(sent.error).toBeUndefined();
      await vi.waitFor(() =>
        expect(
          f.received.some(
            (event) => event.body.kind === 'task' && event.body.status?.state === 'input-required',
          ),
        ).toBe(true),
      );
      expect(
        f.received.every(
          (event) =>
            event.contentType === 'application/json' && event.token === 'fixture-legacy-token',
        ),
      ).toBe(true);
      expect(f.received[0].body).toMatchObject({ kind: 'task', id: sent.result.id });
      await vi.waitFor(() => expect(f.received).toHaveLength(3));
      await rpc(
        'SendMessage',
        {
          tenant: '',
          ...v1Message('v1-follow-up', {
            taskId: sent.result.id,
            contextId: sent.result.contextId,
          }),
        },
        51,
      );
      await vi.waitFor(() => expect(f.received).toHaveLength(6));
      expect(
        f.received.every(
          (event) => event.body.kind === 'task' && event.contentType === 'application/json',
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('rejects official push registration when the capability is disabled', async () => {
    const sent = await json(await rpc('SendMessage', { tenant: '', ...v1Message('no-push') }));
    const config = await json(
      await rpc(
        'CreateTaskPushNotificationConfig',
        { taskId: sent.result.task.id, url: 'https://unused.example.invalid/push' },
        49,
      ),
    );
    expect(config.error?.message).toMatch(/push.*not supported/i);
  });

  it('does not fail the task when the official webhook endpoint fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await pushFixture();
    f.fail();
    try {
      const sent = await json(
        await rpc('SendMessage', {
          tenant: '',
          ...v1Message('endpoint-down'),
          configuration: { taskPushNotificationConfig: { url: f.url } },
        }),
      );
      expect(sent.error).toBeUndefined();
      expect(sent.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      await vi.waitFor(() => expect(f.received).toHaveLength(3));
      expect(
        (await json(await rpc('GetTask', { id: sent.result.task.id }, 50))).result.status.state,
      ).toBe('TASK_STATE_INPUT_REQUIRED');
    } finally {
      await f.close();
      error.mockRestore();
    }
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
