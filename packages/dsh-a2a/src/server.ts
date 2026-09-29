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
 * the server and builds the card.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
  type AgentInterface,
  type Message,
  type StreamResponse,
  TaskState,
} from '@a2a-js/sdk';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  type AgentExecutionEvent,
  type AgentExecutor,
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  ServerCallContext,
  STATE_HEADERS_KEY,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express, { type RequestHandler } from 'express';

export interface A2aServerOptions {
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
  approvalGuard?: (message: Message) => undefined | (() => void);
  beforeWorkingTaskMessage?: (message: Message, requestHeaders: unknown) => Promise<void>;
}

export interface A2aServer {
  /** The bound port (differs from options.port when 0). */
  port: number;
  close(): Promise<void>;
}

export async function startA2aServer(options: A2aServerOptions): Promise<A2aServer> {
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
  const card: AgentCard = {
    name: options.card.name,
    description: options.card.description,
    version: options.card.version,
    // The v0.3 mirror entries let pre-1.0 clients keep working through the
    // legacyCompat layer (they discover the card without an A2A-Version header).
    supportedInterfaces: duplicateInterfacesForLegacy(interfaces, ['JSONRPC']),
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
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
  const taskBuses = new Map<
    string,
    {
      broadcast: DefaultExecutionEventBus;
      requests: Set<DefaultExecutionEventBus>;
      replay: AgentExecutionEvent[];
    }
  >();
  const busManager = {
    createOrGetByTaskId(taskId: string) {
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
  const requestHandler = new (class extends DefaultRequestHandler {
    override async sendMessage(...args: Parameters<DefaultRequestHandler['sendMessage']>) {
      const release = guardApproval(args[0].message);
      try {
        if (!release) await beforeWorkingTaskMessage(args[0].message, args[1]);
        return await approvalReply.run(Boolean(release), () => super.sendMessage(...args));
      } finally {
        release?.();
      }
    }

    override async *sendMessageStream(
      ...args: Parameters<DefaultRequestHandler['sendMessageStream']>
    ) {
      const release = guardApproval(args[0].message);
      try {
        if (!release) await beforeWorkingTaskMessage(args[0].message, args[1]);
        const stream = super.sendMessageStream(...args);
        try {
          if (release) {
            const first = await approvalReply.run(true, () => stream.next());
            if (!first.done) yield first.value;
          }
          yield* stream;
        } finally {
          if (release) await stream.return(undefined);
        }
      } finally {
        release?.();
      }
    }

    override async *resubscribe(
      ...args: Parameters<DefaultRequestHandler['resubscribe']>
    ): AsyncGenerator<StreamResponse, void, undefined> {
      const task = taskBuses.get(args[0].id);
      if (!task) {
        yield* super.resubscribe(...args);
        return;
      }
      const stream = super.resubscribe(...args);
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
  })(card, options.taskStore, options.executor, busManager);

  const app = express();
  // The SDK's jsonRpcHandler parses bodies with express.json()'s 100kb default;
  // raise the ceiling here — body-parser skips re-parsing an already-read body.
  app.use(express.json({ limit: '16mb' }));
  const cardHandler = agentCardHandler({
    agentCardProvider: requestHandler,
    legacyCompat: { enabled: true },
  });
  app.use(`/${AGENT_CARD_PATH}`, cardHandler);
  // Pre-1.0 discovery path, kept as a convenience alias.
  app.use('/.well-known/agent.json', cardHandler);
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
  app.use(base, contextLookup, rpcHandler);

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
