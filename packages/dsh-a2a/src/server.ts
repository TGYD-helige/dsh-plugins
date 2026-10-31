/**
 * HTTP layer: the @a2a-js/sdk Express middlewares on a plain Express app.
 *
 * - `GET /.well-known/agent-card.json` (and the legacy `agent.json` alias) —
 *   agent card, via the SDK's `agentCardHandler`
 * - `POST <basePath>/` — JSON-RPC: A2A 1.0 methods (`SendMessage`,
 *   `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
 *   `SubscribeToTask`, ...) plus the v0.3 spellings (`message/send`, ...)
 *   through the SDK's opt-in legacyCompat layer
 *
 * The SSE framing and error envelopes are the SDK's; this layer only binds
 * the server, builds the card, and optionally adds transport heartbeats.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
  type AgentExtension,
  type AgentInterface,
  type Message,
  type StreamResponse,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import { createLegacyAwarePushNotificationSender } from '@a2a-js/sdk/compat/v0_3/server';
import { RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import {
  type AgentExecutionEvent,
  type AgentExecutor,
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  ExecutionEventQueue,
  type ExtendedAgentCardProvider,
  InMemoryPushNotificationStore,
  ResultManager,
  ServerCallContext,
  STATE_HEADERS_KEY,
  type TaskStore,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import express, { type RequestHandler } from 'express';
import { AdmissionGate } from './admission.js';
import { legacyStreamHandler } from './legacy-stream.js';

export interface A2aServerOptions {
  extensions?: AgentExtension[];
  host: string;
  port: number;
  basePath: string;
  card: {
    name: string;
    description: string;
    version: string;
    /** Public base URL advertised in the card, e.g. https://agent.example.com */
    publicUrl?: string;
  };
  executor: AgentExecutor;
  taskStore: TaskStore;
  heartbeat?: { enabled: boolean; intervalMs: number };
  pushNotifications?: boolean;
  rest?: boolean;
  grpc?: { enabled: boolean; port: number; publicUrl?: string };
  /** Host provider must authorize the request before returning private card data. */
  extendedAgentCard?: ExtendedAgentCardProvider;
  approvalGuard?: (message: Message) => undefined | (() => void);
  beforeWorkingTaskMessage?: (message: Message, requestHeaders: unknown) => Promise<void>;
  beforeMessage?: (
    message: Message,
    context: ServerCallContext,
  ) => Promise<undefined | (() => void)>;
  beforeTask?: (taskId: string, context: ServerCallContext) => Promise<void>;
}

export interface A2aServer {
  /** Reattach persistence and task subscriptions without admitting another message. */
  restoreTask(task: Task, context: ServerCallContext): DefaultExecutionEventBus;
  /** The bound port (differs from options.port when 0). */
  port: number;
  grpcPort?: number;
  close(): Promise<void>;
}

export async function startA2aServer(options: A2aServerOptions): Promise<A2aServer> {
  const intervalMs = options.heartbeat?.intervalMs ?? 15_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
    throw new Error('[dsh-a2a] heartbeat.intervalMs must be an integer from 1 to 2147483647');
  }
  const stopHeartbeats = new Set<() => void>();
  const heartbeatTask = new AsyncLocalStorage<{ taskId?: string; contextId?: string }>();
  async function* observeTask(stream: AsyncGenerator<StreamResponse, void, undefined>) {
    for await (const event of stream) {
      const state = heartbeatTask.getStore();
      const payload = event.payload;
      if (state && payload && payload.$case !== 'message') {
        state.taskId = payload.$case === 'task' ? payload.value.id : payload.value.taskId;
        state.contextId = payload.value.contextId;
      }
      yield event;
    }
  }
  const base = options.basePath.replace(/\/$/, '');
  const publicUrl = (options.card.publicUrl ?? `http://${options.host}:${options.port}`).replace(
    /\/$/,
    '',
  );

  const interfaces: AgentInterface[] = [
    {
      url: `${publicUrl}${base}/`,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ];
  if (options.rest)
    interfaces.push({
      ...interfaces[0],
      url: `${publicUrl}${base}/rest`,
      protocolBinding: 'HTTP+JSON',
    });
  const card: AgentCard = {
    name: options.card.name,
    description: options.card.description,
    version: options.card.version,
    // The v0.3 mirror entries let pre-1.0 clients keep working through the
    // legacyCompat layer (they discover the card without an A2A-Version header).
    supportedInterfaces: duplicateInterfacesForLegacy(interfaces, ['JSONRPC', 'HTTP+JSON']),
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: options.pushNotifications ?? false,
      extensions: options.extensions ?? [],
      extendedAgentCard: !!options.extendedAgentCard,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    signatures: [],
  };

  const guardApproval = (message: Message | undefined) => {
    if (!message) return;
    try {
      return options.approvalGuard?.(message);
    } catch (error) {
      throw new RequestMalformedError(error instanceof Error ? error.message : String(error));
    }
  };
  // SDK's default manager gives concurrent sends one bus. Give each send its
  // own bus while forwarding events to a stable task bus for resubscribe/cancel.
  const approvalReply = new AsyncLocalStorage<boolean>();
  const admissionReply = new AsyncLocalStorage<{
    release: () => void;
    expectedSaves: number;
    saves: number;
  }>();
  const admissions = new AdmissionGate();
  async function acquireAdmission(message: Message | undefined) {
    const key = message?.taskId || message?.contextId || message?.messageId || '';
    const admission = admissions.acquire(key);
    await admission.ready;
    const state = { release: admission.release, expectedSaves: message?.taskId ? 2 : 1, saves: 0 };
    return {
      release: admission.release,
      run: <T>(work: () => T): T => admissionReply.run(state, work),
    };
  }
  const taskBuses = new Map<
    string,
    {
      broadcast: DefaultExecutionEventBus;
      requests: Set<DefaultExecutionEventBus>;
      replay: AgentExecutionEvent[];
    }
  >();
  const ownedTasks = new Set<string>();
  const busManager = {
    createOrGetByTaskId(taskId: string) {
      // restoreTask also creates buses, but only message admission proves ownership.
      if (admissionReply.getStore()) ownedTasks.add(taskId);
      let task = taskBuses.get(taskId);
      if (!task) {
        const broadcast = new DefaultExecutionEventBus();
        const created = {
          broadcast,
          requests: new Set<DefaultExecutionEventBus>(),
          replay: [] as AgentExecutionEvent[],
        };
        task = created;
        taskBuses.set(taskId, created);
        broadcast.on('event', (event) => {
          if (event.kind === 'task') {
            created.replay = [event];
          } else if (event.kind === 'statusUpdate') {
            const previous = created.replay.at(-1);
            const priorMessage = previous?.kind === 'statusUpdate' && previous.data.status?.message;
            const message = event.data.status?.message;
            const before = priorMessage ? priorMessage.parts[0]?.content : undefined;
            const delta = message?.parts[0]?.content;
            if (
              previous?.kind === 'statusUpdate' &&
              previous.data.status?.state === TaskState.TASK_STATE_WORKING &&
              event.data.status?.state === TaskState.TASK_STATE_WORKING &&
              priorMessage &&
              message &&
              priorMessage.messageId === message.messageId &&
              before?.$case === 'text' &&
              delta?.$case === 'text'
            ) {
              // shortcut: replay compaction joins text per delta; use chunks if long streams make this measurable.
              created.replay[created.replay.length - 1] = {
                ...event,
                data: {
                  ...event.data,
                  status: {
                    ...event.data.status,
                    message: {
                      ...message,
                      parts: [
                        {
                          ...message.parts[0],
                          content: { $case: 'text', value: before.value + delta.value },
                        },
                      ],
                    },
                  },
                },
              };
            } else created.replay.push(event);
          } else created.replay.push(event);
          const state = event.kind === 'statusUpdate' ? event.data.status?.state : undefined;
          // Keep the settling event until the persisted snapshot catches up.
          if (
            state !== undefined &&
            state !== TaskState.TASK_STATE_WORKING &&
            state !== TaskState.TASK_STATE_SUBMITTED
          )
            created.replay = [event];
          if (
            state !== undefined &&
            [
              TaskState.TASK_STATE_COMPLETED,
              TaskState.TASK_STATE_FAILED,
              TaskState.TASK_STATE_CANCELED,
              TaskState.TASK_STATE_REJECTED,
            ].includes(state)
          )
            queueMicrotask(() => broadcast.finished());
        });
      }
      if (approvalReply.getStore()) {
        const active = task.requests.values().next().value;
        if (active) return active;
      }
      const requestBus = new DefaultExecutionEventBus();
      task.requests.add(requestBus);
      requestBus.on('event', (event) => task.broadcast.publish(event));
      requestBus.on('finished', () => task.requests.delete(requestBus));
      return requestBus;
    },
    getByTaskId: (taskId: string) => taskBuses.get(taskId)?.broadcast,
    cleanupByTaskId(taskId: string) {
      const task = taskBuses.get(taskId);
      task?.broadcast.finished();
      task?.broadcast.removeAllListeners();
      taskBuses.delete(taskId);
      ownedTasks.delete(taskId);
    },
  };
  const beforeWorkingTaskMessage = async (
    message: Message | undefined,
    context: ServerCallContext,
  ) => {
    if (!message?.taskId) return;
    // Validate through the scoped store before a host hook can affect a live task.
    const task = await options.taskStore.load(message.taskId, context);
    if (
      !task ||
      task.status?.state !== TaskState.TASK_STATE_WORKING ||
      (message.contextId && message.contextId !== task.contextId)
    )
      return;
    try {
      await options.beforeWorkingTaskMessage?.(message, context.state.get(STATE_HEADERS_KEY));
    } catch (error) {
      throw new RequestMalformedError(error instanceof Error ? error.message : String(error));
    }
  };
  const admissionStore: TaskStore = {
    save: async (task, context) => {
      await options.taskStore.save(task, context);
      const admission = admissionReply.getStore();
      if (admission && ++admission.saves >= admission.expectedSaves) admission.release();
    },
    load: (taskId, context) => options.taskStore.load(taskId, context),
    list: (params, context) => options.taskStore.list(params, context),
  };
  const pushStore = options.pushNotifications ? new InMemoryPushNotificationStore() : undefined;
  const pushSender = pushStore ? createLegacyAwarePushNotificationSender(pushStore) : undefined;
  const restoredPushFailed = (error: unknown) =>
    console.error('[dsh-a2a] restored task push failed:', error);
  const requestHandler = new (class extends DefaultRequestHandler {
    private async beforeMessage(message: Message | undefined, context: ServerCallContext) {
      if (!message) return;
      try {
        return await options.beforeMessage?.(message, context);
      } catch (error) {
        throw new RequestMalformedError(error instanceof Error ? error.message : String(error));
      }
    }
    override async sendMessage(...args: Parameters<DefaultRequestHandler['sendMessage']>) {
      const release = guardApproval(args[0].message);
      const admission = await acquireAdmission(args[0].message);
      let releaseAdmission: undefined | (() => void);
      try {
        if (!release) await beforeWorkingTaskMessage(args[0].message, args[1]);
        if (!release) releaseAdmission = await this.beforeMessage(args[0].message, args[1]);
        return await approvalReply.run(Boolean(release), () =>
          admission.run(() => super.sendMessage(...args)),
        );
      } finally {
        admission.release();
        releaseAdmission?.();
        release?.();
      }
    }

    override async *sendMessageStream(
      ...args: Parameters<DefaultRequestHandler['sendMessageStream']>
    ) {
      const release = guardApproval(args[0].message);
      const admission = await acquireAdmission(args[0].message);
      let releaseAdmission: undefined | (() => void);
      try {
        if (!release) await beforeWorkingTaskMessage(args[0].message, args[1]);
        if (!release) releaseAdmission = await this.beforeMessage(args[0].message, args[1]);
        const stream = admission.run(() => observeTask(super.sendMessageStream(...args)));
        try {
          const first = await admission.run(() =>
            approvalReply.run(Boolean(release), () => stream.next()),
          );
          if (!first.done) yield first.value;
          yield* stream;
        } finally {
          if (release) await stream.return(undefined);
        }
      } finally {
        admission.release();
        releaseAdmission?.();
        release?.();
      }
    }

    override async cancelTask(...args: Parameters<DefaultRequestHandler['cancelTask']>) {
      // A cold native task must reattach before ownership is decided: its restored
      // bus proves this worker can cancel it, while an unattached remote task still fails closed.
      await options.beforeTask?.(args[0].id, args[1]);
      const task = await options.taskStore.load(args[0].id, args[1]);
      if (
        task?.status?.state === TaskState.TASK_STATE_WORKING &&
        !ownedTasks.has(task.id) &&
        !taskBuses.has(task.id)
      ) {
        throw new UnsupportedOperationError(
          'Working task is owned by another worker; route cancellation to its owner.',
        );
      }
      return super.cancelTask(...args);
    }

    override async *resubscribe(
      ...args: Parameters<DefaultRequestHandler['resubscribe']>
    ): AsyncGenerator<StreamResponse, void, undefined> {
      await options.beforeTask?.(args[0].id, args[1]);
      const task = taskBuses.get(args[0].id);
      if (!task) {
        yield* observeTask(super.resubscribe(...args));
        return;
      }
      const stream = observeTask(super.resubscribe(...args));
      try {
        const replay = task.replay.slice();
        const last = replay.at(-1);
        const settledAtAttach =
          replay.length === 1 &&
          last?.kind === 'statusUpdate' &&
          last.data.status?.state !== TaskState.TASK_STATE_WORKING &&
          last.data.status?.state !== TaskState.TASK_STATE_SUBMITTED;
        const during: AgentExecutionEvent[] = [];
        const record = (event: AgentExecutionEvent) => during.push(event);
        task.broadcast.on('event', record);
        let first: IteratorResult<StreamResponse>;
        try {
          // The SDK attaches its live queue before awaiting the TaskStore load.
          first = await stream.next();
        } finally {
          task.broadcast.off('event', record);
        }
        if (first.done) return;
        const payload = first.value.payload;
        const queuedAnchor = during.find((event) => event.kind === 'task');
        const anchor = queuedAnchor ?? replay.find((event) => event.kind === 'task');
        const replayNeeded =
          (!settledAtAttach && !during.some((event) => event.kind === 'task')) ||
          (payload?.$case === 'task' &&
            payload.value.status?.state === TaskState.TASK_STATE_WORKING &&
            !during.some((event) => event.kind === 'task'));
        const replayedIds = new Set(
          (replayNeeded ? [...replay, ...during] : during).flatMap((event) =>
            event.kind === 'statusUpdate' && event.data.status?.message
              ? [event.data.status.message.messageId]
              : [],
          ),
        );
        if (payload?.$case === 'task') {
          const initial = payload.value;
          const useAnchor =
            anchor?.kind === 'task' &&
            (initial.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED ||
              (anchor.data.status?.timestamp &&
                initial.status?.timestamp &&
                Date.parse(anchor.data.status.timestamp) > Date.parse(initial.status.timestamp)));
          const history =
            initial.history?.filter((message) => !replayedIds.has(message.messageId)) ?? [];
          if (useAnchor && anchor.kind === 'task') {
            const ids = new Set(history.map((message) => message.messageId));
            for (const message of anchor.data.history ?? [])
              if (!ids.has(message.messageId)) history.push(message);
          }
          yield {
            payload: {
              $case: 'task',
              value: {
                ...initial,
                history,
                status: useAnchor
                  ? anchor.data.status
                  : initial.status?.message && replayedIds.has(initial.status.message.messageId)
                    ? { ...initial.status, message: undefined }
                    : initial.status,
              },
            },
          };
        } else {
          yield first.value;
        }
        for (const event of replayNeeded ? replay : []) {
          if (event.kind === 'task') continue;
          if (event.kind === 'statusUpdate')
            yield { payload: { $case: 'statusUpdate', value: event.data } };
          else if (event.kind === 'artifactUpdate')
            yield { payload: { $case: 'artifactUpdate', value: event.data } };
        }
        let skipQueuedAnchor = Boolean(queuedAnchor);
        for await (const value of stream) {
          if (
            skipQueuedAnchor &&
            queuedAnchor?.kind === 'task' &&
            value.payload?.$case === 'task' &&
            value.payload.value.status?.timestamp === queuedAnchor.data.status?.timestamp
          ) {
            skipQueuedAnchor = false;
            continue;
          }
          yield value;
        }
      } finally {
        await stream.return(undefined);
      }
    }
  })(
    card,
    admissionStore,
    options.executor,
    busManager,
    pushStore,
    pushSender,
    options.extendedAgentCard,
  );

  const app = express();
  // The SDK's jsonRpcHandler parses bodies with express.json()'s 100kb default;
  // raise the ceiling here — body-parser skips re-parsing an already-read body.
  app.use(express.json({ limit: '16mb', type: ['application/json', 'application/a2a+json'] }));
  if (options.heartbeat?.enabled) {
    app.use((req, res, next) => {
      const task: { taskId?: string; contextId?: string } = {};
      const rest = options.rest && req.path.startsWith(`${base}/rest/`);
      const legacy =
        req.body?.method === 'message/stream' || req.body?.method === 'tasks/resubscribe';
      const flushHeaders = res.flushHeaders;
      // Wait for the SDK to commit SSE headers: validation errors stay JSON.
      res.flushHeaders = function () {
        flushHeaders.call(this);
        if (!String(res.getHeader('content-type')).startsWith('text/event-stream') || timer) return;
        timer = setInterval(() => {
          if (res.destroyed || res.writableEnded) return stop();
          // A slow client gets no additional heartbeat backlog; retry next tick.
          if (res.writableNeedDrain) return;
          try {
            if (!task.taskId || !task.contextId) return;
            const update = {
              taskId: task.taskId,
              contextId: task.contextId,
              artifact: { artifactId: 'heartbeat', name: 'heartbeat', parts: [] },
              append: false,
              lastChunk: false,
            };
            const result = legacy
              ? { kind: 'artifact-update', ...update }
              : { artifactUpdate: update };
            res.write(
              `data: ${JSON.stringify(
                rest
                  ? result
                  : {
                      jsonrpc: '2.0',
                      id: req.body.id ?? null,
                      result,
                    },
              )}\n\n`,
            );
          } catch (error) {
            stop();
            console.error('[dsh-a2a] heartbeat write failed:', error);
          }
        }, intervalMs);
        timer.unref();
        stopHeartbeats.add(stop);
        res.once('finish', stop);
        res.once('close', stop);
        res.once('error', stop);
      };
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        clearInterval(timer);
        stopHeartbeats.delete(stop);
        res.off('finish', stop);
        res.off('close', stop);
        res.off('error', stop);
      };
      heartbeatTask.run(task, next);
    });
  }
  const cardHandler = agentCardHandler({
    agentCardProvider: requestHandler,
    legacyCompat: { enabled: true },
  });
  app.use(`/${AGENT_CARD_PATH}`, cardHandler);
  // Pre-1.0 discovery path, kept as a convenience alias.
  app.use('/.well-known/agent.json', cardHandler);
  if (options.rest)
    app.use(
      `${base}/rest`,
      restHandler({
        requestHandler,
        userBuilder: UserBuilder.noAuthentication,
        legacyCompat: { enabled: true },
      }),
    );
  const contextLookup: RequestHandler = async (req, res, next) => {
    const body = req.body as {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const params = body?.params;
    if (
      body?.method !== 'tasks/get' ||
      typeof params?.contextId !== 'string' ||
      !params.contextId ||
      params.id
    ) {
      next();
      return;
    }
    try {
      const contextId = params.contextId;
      const tenant = typeof params.tenant === 'string' ? params.tenant : '';
      const page = await options.taskStore.list(
        {
          tenant,
          contextId,
          pageSize: 1,
          pageToken: '',
          status: TaskState.TASK_STATE_UNSPECIFIED,
          statusTimestampAfter: undefined,
        },
        new ServerCallContext({ tenant }),
      );
      const task = page.tasks[0];
      if (!task) {
        res.json({ jsonrpc: '2.0', id: body.id ?? null, result: null });
        return;
      }
      const { contextId: _contextId, ...rest } = params;
      req.body = { ...body, params: { ...rest, id: task.id } };
      next(); // Let the SDK load and serialize the task on the v0.3 wire.
    } catch (error) {
      console.error('[dsh-a2a] context task lookup failed:', error);
      res.status(500).json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: 'Task lookup failed' },
      });
    }
  };
  const rpcHandler = jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: true },
  });
  // dsh ships no authn/authz — the loopback default binding is the boundary.
  if (base) {
    app.post(
      '/',
      (req, res, next) => {
        const body = req.body as { method?: string; params?: Record<string, unknown> };
        if (body?.method === 'tasks/get' && body.params?.contextId && !body.params.id) next();
        else res.sendStatus(404);
      },
      contextLookup,
      rpcHandler,
    );
  }
  app.use(base, contextLookup, legacyStreamHandler(requestHandler), rpcHandler);

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  if (options.port === 0 && options.card.publicUrl === undefined) {
    const actualBase = `http://${options.host}:${actualPort}`;
    for (const endpoint of card.supportedInterfaces)
      endpoint.url = endpoint.url.replace(publicUrl, actualBase);
  }

  let grpcServer: import('@grpc/grpc-js').Server | undefined;
  let grpcPort: number | undefined;
  if (options.grpc?.enabled) {
    try {
      const [grpc, sdk, legacy] = await Promise.all([
        import('@grpc/grpc-js'),
        import('@a2a-js/sdk/server/grpc'),
        import('@a2a-js/sdk/compat/v0_3/server/grpc'),
      ]);
      grpcServer = new grpc.Server();
      const handlers = { requestHandler, userBuilder: sdk.UserBuilder.noAuthentication };
      grpcServer.addService(sdk.A2AService, sdk.grpcService(handlers));
      grpcServer.addService(legacy.LegacyA2AService, legacy.legacyGrpcService(handlers));
      const listener = grpcServer;
      grpcPort = await new Promise<number>((resolve, reject) => {
        listener.bindAsync(
          `${options.host}:${options.grpc!.port}`,
          grpc.ServerCredentials.createInsecure(),
          (error, port) => (error ? reject(error) : resolve(port)),
        );
      });
      card.supportedInterfaces.push(
        ...duplicateInterfacesForLegacy(
          [
            {
              url: options.grpc.publicUrl || `${options.host}:${grpcPort}`,
              protocolBinding: 'GRPC',
              protocolVersion: A2A_PROTOCOL_VERSION,
              tenant: '',
            },
          ],
          ['GRPC'],
        ),
      );
    } catch (error) {
      grpcServer?.forceShutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  return {
    restoreTask(task: Task, context: ServerCallContext) {
      const bus = busManager.createOrGetByTaskId(task.id);
      const queue = new ExecutionEventQueue(bus);
      const result = new ResultManager(options.taskStore, context);
      void (async () => {
        try {
          for await (const event of queue.events()) {
            await result.processEvent(event);
            if (pushSender) {
              try {
                const snapshot = structuredClone(result.getCurrentTask());
                // SDK execution-event kinds match the StreamResponse oneof cases.
                const response = {
                  payload: {
                    $case: event.kind,
                    value: event.kind === 'task' ? (snapshot ?? event.data) : event.data,
                  },
                } as StreamResponse;
                void pushSender.send(response, context, snapshot).catch(restoredPushFailed);
              } catch (error) {
                restoredPushFailed(error);
              }
            }
          }
        } catch (error) {
          console.error('[dsh-a2a] restored task persistence failed:', error);
        } finally {
          queue.stop();
        }
      })();
      return bus;
    },
    port: actualPort,
    grpcPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const stop of stopHeartbeats) stop();
        grpcServer?.forceShutdown();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
