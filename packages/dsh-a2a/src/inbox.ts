/** Native DSH input ownership with standard A2A task delivery. */
import { randomUUID } from 'node:crypto';
import { Message, type Task, TaskState } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutionEvent,
  type ExecutionEventBus,
  type RequestContext,
  ServerCallContext,
  STATE_HEADERS_KEY,
} from '@a2a-js/sdk/server';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AssistantStreamFrame, InboxTarget } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm/types';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { A2aBridge, TaskEntry } from './bridge.js';
import type { A2aTurnContext } from './index.js';
import type { A2aServer } from './server.js';
import type { ManagedTaskStore } from './task-store.js';
import { agentTextMessage, SessionTranslator, terminalStatusUpdate } from './translator.js';

export const INBOX_EXTENSION =
  'https://github.com/TGYD-helige/dsh-plugins/blob/main/docs/protocol/inbox-v1.md';

interface InboxSource {
  kind: 'a2a';
  taskId: string;
  /** JSON encoding removes protobuf optional undefined fields before durable admission. */
  message: string;
  target: InboxTarget;
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    a2a: InboxSource;
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent/inbox/paused': { paused: boolean };
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    // TODO(verify): upstream packages/core/agent/src/runtime-types.ts, native inbox capability.
    'agent/before-assembly'(detail: {
      agent: Agent;
      messages: UserMessage[];
      turn: number;
      step: number;
      signal: AbortSignal;
    }): void | Promise<void>;
    /** Selected input, before system-prompt assembly; restored input has no original headers. */
    'a2a/before-assembly'(detail: A2aTurnContext): void | Promise<void>;
  }
}

/** Same-process queue control; wire messages and task subscriptions remain standard A2A. */
export interface A2aInbox {
  resolve(contextId: string): Promise<Agent>;
  content(message: Message, contextId: string): Promise<ContentBlock[]>;
  /** Admit a same-process host follow-up under an existing task's durable identity. */
  enqueue(
    taskId: string,
    message: Message,
    options?: { target?: InboxTarget; wakeup?: boolean },
  ): Promise<void>;
  pause(contextId: string): Promise<void>;
  /** Cancellation is terminal; retained pending input stays paused until explicit resume. */
  cancel(taskId: string, options?: { retainInbox?: boolean }): Promise<string | undefined>;
  /** Recovery does not override a persisted pause unless resume is explicitly true. */
  wake(
    contextId: string,
    options?: { resume?: boolean; context?: ServerCallContext },
  ): Promise<string[]>;
}

type DurableInbox = Agent['inbox'] & { setPaused(paused: boolean): void };

interface TaskRun {
  task: Task;
  translator: SessionTranslator;
  bus: ExecutionEventBus;
  done: Promise<void>;
  finish(): void;
  settled: boolean;
  headers: Map<string, unknown>;
  final?: AgentExecutionEvent;
  controller: AbortController;
  settlementStarted?: boolean;
  settlementReady?: boolean;
  pendingRequests: number;
  context: ServerCallContext;
  cancellation?: Promise<void>;
}
interface ContextRun {
  entry: TaskEntry;
  paused: boolean;
  // shortcut: settled handles live until context clear/unload; reclaim once task delivery exposes a drain acknowledgment.
  tasks: Map<string, TaskRun>;
  active?: TaskRun;
  turnStart?: SessionEvent;
  admissions: Set<AbortController>;
  admissionTail: Promise<void>;
}

/** Fold native input mutations; a claimed input is recoverable only before user/message. */
export function recoverInbox(events: readonly SessionEvent[]) {
  const pending = new Map<string, UserMessage>();
  const lists: Record<InboxTarget, UserMessage[]> = { 'next-step': [], 'next-turn': [] };
  let paused = false;
  let claimed = new Set<string>();
  const committed = new Set<string>();
  for (const event of events) {
    if (event.type === 'agent/inbox/paused') paused = event.data.paused;
    else if (event.type === 'turn/start') {
      claimed = new Set();
    } else if (event.type === 'turn/end') {
      if (
        !paused &&
        (event.data.reason.kind === 'error' ||
          event.data.reason.kind === 'blocked' ||
          (event.data.reason.kind === 'aborted' && event.data.reason.reason.kind !== 'disposed'))
      )
        for (const id of claimed) pending.delete(id);
    } else if (event.type === 'agent/inbox/spliced') {
      const { target, start, removedCount = 0, inserted, outcome } = event.data;
      const removed = lists[target].splice(start, removedCount, ...inserted);
      for (const message of removed) {
        if (outcome === 'canceled') pending.delete(message.id);
        else claimed.add(message.id);
      }
      for (const message of inserted)
        if (message.source.kind === 'a2a') pending.set(message.id, message);
    } else if (event.type === 'user/message') {
      pending.delete(event.data.id);
      if (event.data.source.kind === 'a2a') committed.add(event.data.source.taskId);
    }
  }
  return { paused, pending: [...pending.values()], committed };
}

export class NativeInbox implements A2aInbox {
  private readonly contexts = new Map<string, ContextRun>();
  private readonly resolving = new Map<string, Promise<ContextRun>>();
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private readonly waking = new Map<string, Promise<string[]>>();
  private readonly preadmitted = new WeakMap<ServerCallContext, Set<string>>();
  server?: A2aServer;

  constructor(
    private readonly ctx: Context,
    private readonly bridge: A2aBridge,
    private readonly store: ManagedTaskStore,
  ) {
    if (
      (ctx.agents as typeof ctx.agents & { nativeInboxVersion?: number }).nativeInboxVersion !== 1
    )
      throw new Error(
        'Native inbox requires a DSH factory with nativeInboxVersion 1. Upgrade DSH before enabling inbox.enabled.',
      );
    bridge.inbox = this;
    ctx.on('agent/before-assembly', (detail) => this.prepare(detail));
  }

  content(message: Message, contextId: string) {
    return this.bridge.buildContent(message, contextId);
  }
  async resolve(contextId: string): Promise<Agent> {
    return (await this.context(contextId)).entry.handle.agent;
  }

  async enqueue(
    taskId: string,
    message: Message,
    options: { target?: InboxTarget; wakeup?: boolean } = {},
  ): Promise<void> {
    if (this.stopping) throw new Error('Native inbox is unloading.');
    if (!message.messageId) throw new Error('message.messageId is required.');
    for (const run of this.contexts.values()) {
      const task = run.tasks.get(taskId);
      if (!task || task.settled) continue;
      const admitted = { ...message, taskId, contextId: run.entry.sessionId };
      task.pendingRequests++;
      try {
        await this.admit(run, task, admitted, task.context, options.target ?? 'next-turn');
        if (options.wakeup !== false && !run.paused)
          await this.wake(run.entry.sessionId, { context: task.context });
      } finally {
        task.pendingRequests--;
        this.settle(run, task);
      }
      return;
    }
    throw new Error('Host input must address a live A2A task.');
  }

  private context(contextId: string): Promise<ContextRun> {
    if (this.stopping) return Promise.reject(new Error('Native inbox is unloading.'));
    const existing = this.contexts.get(contextId);
    if (existing) return Promise.resolve(existing);
    let creating = this.resolving.get(contextId);
    if (!creating) {
      creating = (async () => {
        const { entry } = await this.bridge.ensureTask(randomUUID(), contextId);
        const agent = entry.handle.agent as Agent & { wake?: () => void };
        if (
          typeof agent.wake !== 'function' ||
          typeof (agent.inbox as DurableInbox).setPaused !== 'function'
        )
          throw new Error(
            'Native inbox requires DSH Agent.wake(), agent/before-assembly, and inbox-preserving disposal. See the native inbox compatibility notes.',
          );
        const recovered = recoverInbox(agent.session.snapshotEvents());
        const run: ContextRun = {
          entry,
          paused: recovered.paused,
          tasks: new Map(),
          admissions: new Set(),
          admissionTail: Promise.resolve(),
        };
        this.contexts.set(contextId, run);
        const queued = new Set(
          [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map((message) => message.id),
        );
        for (const message of recovered.pending.slice().reverse()) {
          if (!queued.has(message.id) && message.source.kind === 'a2a')
            agent.inbox.prepend(message.source.target, message);
        }
        await this.flush(agent.session);
        return run;
      })().finally(() => this.resolving.delete(contextId));
      this.resolving.set(contextId, creating);
    }
    return creating;
  }

  private flush(session: Session): Promise<void> {
    return this.ctx.parallel('session/flush', session);
  }
  private checkpoint(task: Task, context: ServerCallContext): Promise<void> {
    return this.store.checkpoint
      ? this.store.checkpoint(task, context)
      : this.store.save(task, context);
  }
  private pending(run: ContextRun) {
    return [...run.entry.handle.agent.inbox.nextStep, ...run.entry.handle.agent.inbox.nextTurn];
  }

  private task(task: Task, bus: ExecutionEventBus, context: ServerCallContext): TaskRun {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      task,
      translator: new SessionTranslator(task.id, task.contextId),
      bus,
      done,
      finish,
      settled: false,
      headers: new Map(),
      controller: new AbortController(),
      pendingRequests: 0,
      context: new ServerCallContext({ tenant: context.tenant, user: context.user }),
    };
  }

  private controls(
    message: Message,
    context: ServerCallContext,
  ): { target: InboxTarget; wakeup: boolean } {
    const value = message.metadata?.[INBOX_EXTENSION];
    if (value === undefined) return { target: 'next-turn', wakeup: true };
    if (!context.requestedExtensions?.includes(INBOX_EXTENSION))
      throw new Error('Inbox controls require A2A-Extensions negotiation.');
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'target' && key !== 'wakeup')
    )
      throw new Error('Invalid inbox controls.');
    if (value.target !== undefined && value.target !== 'next-step' && value.target !== 'next-turn')
      throw new Error('Invalid inbox target.');
    if (value.wakeup !== undefined && typeof value.wakeup !== 'boolean')
      throw new Error('Invalid inbox wakeup.');
    context.addActivatedExtension(INBOX_EXTENSION);
    return {
      target: value.target === 'next-step' ? 'next-step' : 'next-turn',
      wakeup: value.wakeup !== false,
    };
  }

  /** Reject follow-up admission at the request boundary, without terminating accepted work. */
  async beforeMessage(
    message: Message,
    context: ServerCallContext,
  ): Promise<undefined | (() => void)> {
    if (!message.messageId) throw new Error('message.messageId is required.');
    const controls = this.controls(message, context);
    if (!message.taskId) {
      if (controls.target === 'next-step') throw new Error('Steering must address an active task.');
      return;
    }
    const snapshot = await this.store.load(message.taskId, context);
    if (
      !snapshot ||
      (message.contextId && snapshot.contextId !== message.contextId) ||
      this.terminal(snapshot)
    )
      return;
    const run = await this.context(snapshot.contextId);
    let task = run.tasks.get(snapshot.id);
    if (!task) task = this.restoreTask(run, snapshot, context);
    task.pendingRequests++;
    try {
      await this.admit(run, task, message, context, controls.target);
    } catch (error) {
      task.pendingRequests--;
      this.settle(run, task);
      throw error;
    }
    let admitted = this.preadmitted.get(context);
    if (!admitted) {
      admitted = new Set();
      this.preadmitted.set(context, admitted);
    }
    admitted.add(message.messageId);
    return () => {
      if (!admitted.delete(message.messageId)) return;
      task.pendingRequests--;
      this.settle(run, task);
    };
  }

  /** Reattach a cold task before the SDK decides whether cancellation has a live executor. */
  async beforeTask(taskId: string, context: ServerCallContext): Promise<void> {
    const snapshot = await this.store.load(taskId, context);
    if (!snapshot || this.terminal(snapshot)) return;
    const run = await this.context(snapshot.contextId);
    if (!run.tasks.has(taskId)) this.restoreTask(run, snapshot, context);
  }

  private terminal(task: Task): boolean {
    return (
      !!task.status &&
      [
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_REJECTED,
      ].includes(task.status.state)
    );
  }

  private async admit(
    run: ContextRun,
    task: TaskRun,
    a2aMessage: Message,
    context: ServerCallContext,
    target: InboxTarget,
  ) {
    if (target === 'next-step' && run.active !== task)
      throw new Error('Steering must address an active task.');
    const duplicate = () =>
      [...run.tasks.values()].some((owned) =>
        owned.task.history.some((message) => message.messageId === a2aMessage.messageId),
      );
    if (duplicate()) throw new Error('This message is already queued.');
    const abort = new AbortController();
    run.admissions.add(abort);
    const onTaskAbort = () => abort.abort();
    task.controller.signal.addEventListener('abort', onTaskAbort, { once: true });
    if (task.controller.signal.aborted) abort.abort();
    const headers = context.state.get(STATE_HEADERS_KEY);
    const work = run.admissionTail.then(async () => {
      abort.signal.throwIfAborted();
      const content = await this.content(a2aMessage, run.entry.sessionId);
      abort.signal.throwIfAborted();
      const message = createUserMessage({
        content,
        source: {
          kind: 'a2a',
          taskId: task.task.id,
          message: JSON.stringify(Message.toJSON(a2aMessage)),
          target,
        },
      });
      await this.ctx.serial('a2a/before-followup', {
        agent: run.entry.handle.agent,
        contextId: run.entry.sessionId,
        taskId: task.task.id,
        a2aMessage,
        dshMessageId: message.id,
        requestHeaders: headers,
        signal: abort.signal,
      });
      abort.signal.throwIfAborted();
      if (this.stopping || this.bridge.isClearing(run.entry.sessionId) || task.settled)
        throw new Error('Context or task is unavailable.');
      if (duplicate()) throw new Error('This message is already queued.');
      const saved = await this.store.load(task.task.id, context);
      abort.signal.throwIfAborted();
      const history = saved?.history ?? task.task.history;
      const acceptedHistory = history.some((item) => item.messageId === a2aMessage.messageId)
        ? history
        : [...history, a2aMessage];
      await this.checkpoint({ ...task.task, history: acceptedHistory }, context);
      abort.signal.throwIfAborted();
      task.task.history = acceptedHistory;
      task.headers.set(message.id, headers);
      run.entry.handle.agent.send(message, target, false);
      await this.flush(run.entry.handle.agent.session);
      void this.ctx
        .parallel('a2a/message-admitted', {
          contextId: run.entry.sessionId,
          taskId: task.task.id,
          a2aMessageId: a2aMessage.messageId,
          dshMessageId: message.id,
          requestHeaders: headers,
        })
        .catch((error: unknown) =>
          console.error('[dsh-a2a] message-admitted listener failed:', error),
        );
    });
    let onAbort!: () => void;
    const admitted = Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Inbox admission interrupted.'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        if (abort.signal.aborted) onAbort();
      }),
    ]);
    run.admissionTail = admitted.catch(() => {});
    try {
      await admitted;
    } finally {
      abort.signal.removeEventListener('abort', onAbort);
      run.admissions.delete(abort);
      task.controller.signal.removeEventListener('abort', onTaskAbort);
    }
  }

  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId, context } = request;
    let task: TaskRun | undefined;
    let ownsTask = false;
    try {
      const controls = this.controls(userMessage, context);
      const run = await this.context(contextId);
      task = run.tasks.get(taskId);
      if (!task) {
        task = this.task(
          {
            id: taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_SUBMITTED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
            history: [],
            artifacts: [],
            metadata: undefined,
          },
          bus,
          context,
        );
        run.tasks.set(taskId, task);
        ownsTask = true;
      }
      const preadmitted = this.preadmitted.get(context)?.delete(userMessage.messageId);
      if (!preadmitted) await this.admit(run, task, userMessage, context, controls.target);
      else task.pendingRequests--;
      bus.publish(AgentEvent.task(structuredClone(task.task)));
      this.settle(run, task);
      if (controls.wakeup && !run.paused && !task.settled) await this.wake(contextId, { context });
      await task.done;
      if (task.bus !== bus && task.final) bus.publish(task.final);
    } catch (error) {
      if (task?.settled) return;
      if (task && !ownsTask) {
        bus.publish(AgentEvent.task(structuredClone(task.task)));
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      const snapshot: Task = {
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          message: agentTextMessage(taskId, contextId, text),
          timestamp: new Date().toISOString(),
        },
        history: task?.task.history ?? [],
        artifacts: [],
        metadata: undefined,
      };
      bus.publish(AgentEvent.task(snapshot));
      bus.publish(terminalStatusUpdate(taskId, contextId, 'failed', text));
      if (task) {
        task.settled = true;
        task.controller.abort();
        task.finish();
      }
    } finally {
      bus.finished();
    }
  }

  private restoreTask(run: ContextRun, snapshot: Task, context: ServerCallContext): TaskRun {
    if (!this.server) throw new Error('A2A task recovery requires the running server.');
    const bus = this.server.restoreTask(snapshot, context);
    const restored = this.task(snapshot, bus, context);
    run.tasks.set(snapshot.id, restored);
    void restored.done.finally(() => bus.finished());
    bus.publish(AgentEvent.task(snapshot));
    return restored;
  }

  private drive(run: ContextRun) {
    (run.entry.handle.agent as Agent & { wake(): void }).wake();
  }

  private async prepare(detail: { agent: Agent; messages: UserMessage[]; signal: AbortSignal }) {
    const run = this.contexts.get(detail.agent.session.id);
    if (!run) return;
    if (this.stopping || run.paused) throw new Error('Inbox is paused.');
    if (detail.messages.some((message) => message.source.kind !== 'a2a'))
      throw new Error('Native host input requires task-attributed a2aInbox.enqueue().');
    // Restarted steering and an ordinary queued turn may be claimed together by the core.
    // Requeue other owners before committing any user message, keeping task lifecycles separate.
    const owner = detail.messages.find((message) => message.source.kind === 'a2a');
    if (owner?.source.kind === 'a2a') {
      const taskId = owner.source.taskId;
      const deferred = detail.messages.filter(
        (message) => message.source.kind === 'a2a' && message.source.taskId !== taskId,
      );
      for (const message of deferred.slice().reverse())
        detail.agent.inbox.prepend('next-turn', message);
      for (let index = detail.messages.length - 1; index >= 0; index--)
        if (deferred.includes(detail.messages[index]!)) detail.messages.splice(index, 1);
    }
    for (const message of detail.messages) {
      if (message.source.kind !== 'a2a') continue;
      const task = run.tasks.get(message.source.taskId);
      if (!task || task.settled)
        throw new Error('Queued input has no live A2A task; restore it before waking.');
      if (run.active && run.active !== task)
        throw new Error('A model step cannot consume inputs from different A2A tasks.');
      run.active = task;
      this.bridge.bindInboxTask(
        run.entry,
        task.task.id,
        task.translator,
        task.bus,
        task.done,
        task.controller,
      );
      if (run.turnStart) {
        this.publish(task, run.turnStart);
        run.turnStart = undefined;
      }
      await this.flush(detail.agent.session);
      await this.ctx.serial('a2a/before-assembly', {
        agent: detail.agent,
        contextId: detail.agent.session.id,
        taskId: task.task.id,
        a2aMessage: Message.fromJSON(JSON.parse(message.source.message)),
        dshMessageId: message.id,
        requestHeaders: task.headers.get(message.id),
        signal: detail.signal,
      });
      detail.signal.throwIfAborted();
    }
  }

  private publish(task: TaskRun, event: SessionEvent) {
    for (const output of task.translator.handle(event)) {
      if (output.kind === 'statusUpdate' && output.data.status)
        task.task.status = output.data.status;
      task.bus.publish(output);
    }
  }

  onSessionEvent(session: Session, event: SessionEvent): boolean {
    const run = this.contexts.get(session.id);
    if (!run) return false;
    if (event.type === 'agent/inbox/paused') {
      run.paused = event.data.paused;
      return true;
    }
    if (event.type === 'turn/start') {
      run.turnStart = event;
      return true;
    }
    const task = run.active;
    if (!task) return true;
    if (task.settled) {
      if (event.type === 'turn/end') run.active = undefined;
      return true;
    }
    try {
      if (event.type !== 'turn/end') {
        this.publish(task, event);
        return true;
      }
      run.active = undefined;
      if (this.stopping) return true;
      const outputs = task.translator.handle(event);
      if (run.paused) {
        void this.cancel(task.task.id, { retainInbox: true }).catch((error: unknown) =>
          console.error('[dsh-a2a] pause cancellation failed:', error),
        );
        return true;
      }
      task.final = outputs.at(-1);
      if (event.data.reason.kind === 'error' || event.data.reason.kind === 'blocked') {
        void run.entry.handle.agent
          .whenIdle()
          .then(() => {
            if (!this.stopping && !run.paused && !this.bridge.isClearing(session.id))
              this.drive(run);
          })
          .catch((error: unknown) => console.error('[dsh-a2a] queue continuation failed:', error));
      }
      if (!task.settlementStarted) {
        task.settlementStarted = true;
        void Promise.resolve(
          this.ctx.waterfall(
            'a2a/task-settlement',
            {
              agent: run.entry.handle.agent,
              contextId: session.id,
              taskId: task.task.id,
              reason: event.data.reason,
              signal: task.controller.signal,
            },
            () => {},
          ),
        )
          .then(() => {
            task.settlementReady = true;
            this.settle(run, task);
          })
          .catch((error: unknown) => this.fail(task, session.id, error));
      } else this.settle(run, task);
    } catch (error) {
      this.fail(task, session.id, error);
    }
    return true;
  }

  private settle(run: ContextRun, task: TaskRun) {
    if (
      task.settled ||
      this.stopping ||
      run.paused ||
      !task.settlementReady ||
      task.pendingRequests ||
      run.active === task ||
      this.pending(run).some(
        (message) => message.source.kind === 'a2a' && message.source.taskId === task.task.id,
      )
    )
      return;
    const output = task.final;
    if (
      output?.kind === 'statusUpdate' &&
      output.data.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED
    )
      output.data.status.state = TaskState.TASK_STATE_COMPLETED;
    if (output?.kind === 'statusUpdate') task.task.status = output.data.status;
    if (output) task.bus.publish(output);
    task.settled = true;
    task.controller.abort();
    task.headers.clear();
    task.finish();
  }

  onAssistantStream(agent: Agent, frame: AssistantStreamFrame): boolean {
    const run = this.contexts.get(agent.session.id);
    if (!run) return false;
    const task = run.active;
    if (task && !task.settled) {
      try {
        for (const output of task.translator.handleStreamFrame(frame)) task.bus.publish(output);
      } catch (error) {
        console.error('[dsh-a2a] failed to translate inbox stream:', error);
      }
    }
    return true;
  }

  private fail(task: TaskRun, contextId: string, error: unknown) {
    console.error('[dsh-a2a] native inbox failed:', error);
    if (!task.settled) {
      task.final = terminalStatusUpdate(
        task.task.id,
        contextId,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      if (task.final.kind === 'statusUpdate') task.task.status = task.final.data.status;
      task.bus.publish(task.final);
    }
    task.settled = true;
    task.controller.abort();
    task.headers.clear();
    task.finish();
  }

  async pause(contextId: string): Promise<void> {
    await this.waking.get(contextId);
    const run = await this.context(contextId);
    run.paused = true;
    for (const admission of run.admissions) admission.abort();
    (run.entry.handle.agent.inbox as DurableInbox).setPaused(true);
    for (const task of run.tasks.values())
      if (!task.settled && task.task.status?.state === TaskState.TASK_STATE_WORKING)
        await this.cancel(task.task.id, { retainInbox: true });
    run.entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await run.entry.handle.agent.whenIdle();
    await this.flush(run.entry.handle.agent.session);
  }

  async wake(
    contextId: string,
    options: { resume?: boolean; context?: ServerCallContext } = {},
  ): Promise<string[]> {
    const operation = (this.waking.get(contextId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.wakeInner(contextId, options));
    this.waking.set(contextId, operation);
    const release = () => {
      if (this.waking.get(contextId) === operation) this.waking.delete(contextId);
    };
    void operation.then(release, release);
    return operation;
  }

  private async wakeInner(
    contextId: string,
    options: { resume?: boolean; context?: ServerCallContext },
  ): Promise<string[]> {
    const run = await this.context(contextId);
    if (run.paused && !options.resume) return [];
    if (options.resume && run.entry.handle.agent.status === 'idle') {
      const recovered = recoverInbox(run.entry.handle.agent.session.snapshotEvents());
      const queued = new Set(this.pending(run).map((message) => message.id));
      for (const message of recovered.pending.slice().reverse())
        if (!queued.has(message.id) && message.source.kind === 'a2a')
          run.entry.handle.agent.inbox.prepend(message.source.target, message);
    }
    const context = options.context ?? new ServerCallContext();
    const tasks = new Set<string>();
    const reassigned = new Map<string, Task>();
    for (const message of this.pending(run)) {
      if (message.source.kind !== 'a2a')
        throw new Error('Cannot wake input without A2A task attribution.');
      const oldId = message.source.taskId;
      let id = oldId;
      if (run.tasks.has(id) && !run.tasks.get(id)!.settled) {
        tasks.add(id);
        continue;
      }
      if (!this.server) throw new Error('A2A task recovery requires the running server.');
      let task = run.tasks.get(id)?.task ?? (await this.store.load(id, context));
      if (!task || task.contextId !== contextId)
        throw new Error('Queued A2A task is not accessible.');
      if (this.terminal(task)) {
        if (!options.resume)
          throw new Error('Retained input needs explicit resume under a new task.');
        let replacement = reassigned.get(oldId);
        const original = Message.fromJSON(JSON.parse(message.source.message));
        if (!replacement) {
          replacement = {
            ...task,
            id: randomUUID(),
            history: [],
            artifacts: [],
            status: {
              state: TaskState.TASK_STATE_SUBMITTED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
          };
          reassigned.set(oldId, replacement);
        }
        id = replacement.id;
        original.taskId = id;
        original.referenceTaskIds = [...new Set([...original.referenceTaskIds, oldId])];
        replacement.history.push(original);
        await this.checkpoint(replacement, context);
        run.entry.handle.agent.inbox.replace(message.id, {
          ...message,
          source: {
            ...message.source,
            taskId: id,
            message: JSON.stringify(Message.toJSON(original)),
          },
        });
        task = replacement;
      }
      tasks.add(id);
      if (run.tasks.has(id)) continue;
      this.restoreTask(run, task, context);
    }
    const recovered = recoverInbox(run.entry.handle.agent.session.snapshotEvents());
    for (const id of recovered.committed) {
      const owned = run.tasks.get(id);
      if (
        tasks.has(id) ||
        (owned && (owned.settled || owned.settlementStarted || run.active === owned))
      )
        continue;
      const interrupted = owned?.task ?? (await this.store.load(id, context));
      if (!interrupted || interrupted.contextId !== contextId || this.terminal(interrupted))
        continue;
      const failed = owned ?? this.restoreTask(run, interrupted, context);
      this.fail(
        failed,
        contextId,
        new Error(
          'Committed input has no durable terminal task checkpoint; automatic replay is disabled.',
        ),
      );
      await this.checkpoint(structuredClone(failed.task), failed.context);
    }
    if (this.stopping || this.bridge.isClearing(contextId)) return [];
    if (options.resume) {
      run.paused = false;
      (run.entry.handle.agent.inbox as DurableInbox).setPaused(false);
    }
    await this.flush(run.entry.handle.agent.session);
    if (tasks.size) this.drive(run);
    return [...tasks];
  }

  async cancel(
    taskId: string,
    options: { retainInbox?: boolean } = {},
  ): Promise<string | undefined> {
    if (this.stopping) throw new Error('Native inbox is unloading.');
    for (const [contextId, run] of this.contexts) {
      if (!run.tasks.has(taskId)) continue;
      await this.waking.get(contextId);
      const task = run.tasks.get(taskId);
      if (!task) continue;
      if (this.stopping && !task.cancellation) throw new Error('Native inbox is unloading.');
      if (task.settled && task.task.status?.state !== TaskState.TASK_STATE_CANCELED)
        return contextId;
      let operation = task.cancellation;
      if (!operation) {
        operation = this.cancelTask(run, task, options);
        task.cancellation = operation;
        void operation.catch(() => {
          if (task.cancellation === operation) task.cancellation = undefined;
        });
      }
      await operation;
      return contextId;
    }
    return undefined;
  }

  private async cancelTask(
    run: ContextRun,
    task: TaskRun,
    options: { retainInbox?: boolean },
  ): Promise<void> {
    const contextId = run.entry.sessionId;
    const taskId = task.task.id;
    if (options.retainInbox) {
      run.paused = true;
      (run.entry.handle.agent.inbox as DurableInbox).setPaused(true);
    } else {
      for (const message of this.pending(run))
        if (message.source.kind === 'a2a' && message.source.taskId === taskId)
          run.entry.handle.agent.inbox.remove(message.id);
    }
    task.controller.abort();
    task.settled = true;
    task.final = terminalStatusUpdate(taskId, contextId, 'canceled', 'Task canceled by request.');
    if (task.final.kind === 'statusUpdate') task.task.status = task.final.data.status;
    if (run.active === task) {
      run.entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
      void run.entry.handle.agent
        .whenIdle()
        .then(() => {
          if (!run.paused && !this.stopping) this.drive(run);
        })
        .catch((error: unknown) => console.error('[dsh-a2a] cancellation failed:', error));
    }
    try {
      try {
        await this.flush(run.entry.handle.agent.session);
      } finally {
        await this.checkpoint(structuredClone(task.task), task.context);
      }
    } finally {
      task.bus.publish(task.final);
      task.finish();
    }
  }

  async clear(contextId: string) {
    await this.waking.get(contextId);
    await this.resolving.get(contextId);
    const run = this.contexts.get(contextId);
    if (!run) return;
    run.paused = true;
    for (const admission of run.admissions) admission.abort();
    run.entry.handle.agent.inbox.clear();
    run.entry.handle.agent.cancel({ kind: 'user' });
    await run.entry.handle.agent.whenIdle();
    for (const task of run.tasks.values()) {
      if (!task.settled)
        task.bus.publish(
          terminalStatusUpdate(task.task.id, contextId, 'canceled', 'Context cleared.'),
        );
      task.settled = true;
      task.controller.abort();
      task.finish();
    }
    await this.flush(run.entry.handle.agent.session);
    this.contexts.delete(contextId);
  }

  onDisposed(session: Session): void {
    const run = this.contexts.get(session.id);
    if (!run) return;
    for (const admission of run.admissions) admission.abort();
    for (const task of run.tasks.values()) {
      // Disposal interrupts transport ownership; retained durable input keeps its task state.
      task.settled = true;
      task.controller.abort();
      task.finish();
    }
    this.contexts.delete(session.id);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = (async () => {
      const failures: unknown[] = [];
      await Promise.allSettled([...this.waking.values(), ...this.resolving.values()]);
      const cancellations = [...this.contexts.values()].flatMap((run) =>
        [...run.tasks.values()].flatMap((task) => (task.cancellation ? [task.cancellation] : [])),
      );
      for (const outcome of await Promise.allSettled(cancellations))
        if (outcome.status === 'rejected') failures.push(outcome.reason);
      for (const run of this.contexts.values()) {
        for (const admission of run.admissions) admission.abort();
        try {
          run.entry.handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true });
        } catch (error) {
          failures.push(error);
        }
        try {
          await run.entry.handle.agent.whenIdle();
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.flush(run.entry.handle.agent.session);
        } catch (error) {
          failures.push(error);
        } finally {
          for (const task of run.tasks.values()) {
            task.controller.abort();
            task.finish();
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Native inbox shutdown failed.');
    })();
    return this.shutdownPromise;
  }
}
