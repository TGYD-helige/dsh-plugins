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

export interface A2aInboxEvent {
  phase: string;
  contextId: string;
  at: number;
  pending: number;
  target?: 'next-turn' | 'next-step';
  input?: string;
  position?: number;
  agentStatus?: string;
  taskId?: string;
  taskIds?: string[];
  messageId?: string;
  referenceTaskIds?: string[];
  nativeMessageId?: string;
  queuedAt?: number;
  selectedAt?: number;
  turn?: number;
  step?: number;
}

interface InboxSource {
  kind: 'a2a';
  taskId: string;
  /** JSON encoding removes protobuf optional undefined fields before durable admission. */
  message: string;
  target: InboxTarget;
  queuedAt?: number;
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    a2a: InboxSource;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Native inbox lifecycle; content consumers must honor their capture settings. */
    'a2a/inbox'(detail: A2aInboxEvent): void;

    /** Selected input at the official pre-step boundary, after system-prompt assembly. */
    'a2a/before-step'(detail: A2aTurnContext): void | Promise<void>;
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
  /** Standard cancellation is terminal and removes only this task's pending input. */
  cancel(taskId: string): Promise<string | undefined>;
}

interface TaskRun {
  task: Task;
  translator: SessionTranslator;
  bus: ExecutionEventBus;
  done: Promise<void>;
  finish(): void;
  settled: boolean;
  headers: Map<string, unknown>;
  selectedAt: Map<string, number>;
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
  // shortcut: settled handles live until context clear/unload; reclaim once task delivery exposes a drain acknowledgment.
  tasks: Map<string, TaskRun>;
  active?: TaskRun;
  turnStart?: SessionEvent;
  admissions: Set<AbortController>;
  admissionTail: Promise<void>;
}

export class NativeInbox implements A2aInbox {
  private readonly contexts = new Map<string, ContextRun>();
  private readonly resolving = new Map<string, Promise<ContextRun>>();
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private readonly preadmitted = new WeakMap<ServerCallContext, Set<string>>();
  server?: A2aServer;

  constructor(
    private readonly ctx: Context,
    private readonly bridge: A2aBridge,
    private readonly store: ManagedTaskStore,
  ) {
    bridge.inbox = this;
    ctx.on('agent/pre-step', async (detail, next) => {
      await this.prepare(detail);
      return next();
    });
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const run = this.contexts.get(agent.session.id);
      if (!run || message.source.kind !== 'a2a') return;
      const task = run.tasks.get(message.source.taskId);
      if (task && !task.settled) {
        if (!run.active) this.select(run, task);
        if (run.active === task) {
          const selectedAt = Date.now();
          task.selectedAt.set(message.id, selectedAt);
          this.observeInput('selected', run, message, { selectedAt, turn });
        }
      }
    });
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
        await this.admit(
          run,
          task,
          admitted,
          task.context,
          options.target ?? 'next-turn',
          options.wakeup !== false,
        );
      } finally {
        task.pendingRequests--;
        this.settle(run, task);
      }
      return;
    }
    throw new Error('Host input must address a live A2A task.');
  }

  private context(contextId: string, context = new ServerCallContext()): Promise<ContextRun> {
    if (this.stopping) return Promise.reject(new Error('Native inbox is unloading.'));
    const existing = this.contexts.get(contextId);
    if (existing) return Promise.resolve(existing);
    let creating = this.resolving.get(contextId);
    if (!creating) {
      creating = (async () => {
        const { entry } = await this.bridge.ensureTask(randomUUID(), contextId);
        const run: ContextRun = {
          entry,
          tasks: new Map(),
          admissions: new Set(),
          admissionTail: Promise.resolve(),
        };
        const snapshots = new Map<string, Task>();
        for (const message of this.pending(run)) {
          if (message.source.kind !== 'a2a' || snapshots.has(message.source.taskId)) continue;
          const snapshot = await this.store.load(message.source.taskId, context);
          if (!snapshot || snapshot.contextId !== contextId)
            throw new Error('Queued A2A task is not accessible.');
          if (this.terminal(snapshot)) entry.handle.agent.inbox.remove(message.id);
          else snapshots.set(snapshot.id, snapshot);
        }
        await this.flush(entry.handle.agent.session);
        for (const snapshot of snapshots.values()) this.restoreTask(run, snapshot, context);
        this.contexts.set(contextId, run);
        this.observe('resolved', run);
        for (const message of this.pending(run)) this.observeInput('restored', run, message);
        return run;
      })().finally(() => this.resolving.delete(contextId));
      this.resolving.set(contextId, creating);
    }
    return creating;
  }

  private observe(phase: string, run: ContextRun, fields: Partial<A2aInboxEvent> = {}): void {
    try {
      const pending = this.pending(run);
      void this.ctx
        .parallel('a2a/inbox', {
          phase,
          contextId: run.entry.sessionId,
          at: Date.now(),
          pending: pending.length,
          agentStatus: run.entry.handle.agent.status,
          taskIds: [
            ...new Set(
              [...run.tasks.values()]
                .filter((task) => !task.settled)
                .map((task) => task.task.id)
                .concat(
                  pending.flatMap((message) =>
                    message.source.kind === 'a2a' ? [message.source.taskId] : [],
                  ),
                ),
            ),
          ],
          ...fields,
        })
        .catch((error: unknown) => console.error('[dsh-a2a] inbox observer failed:', error));
    } catch (error) {
      console.error('[dsh-a2a] inbox observer failed:', error);
    }
  }

  private observeInput(
    phase: string,
    run: ContextRun,
    message: UserMessage,
    fields: Partial<A2aInboxEvent> = {},
  ): void {
    try {
      if (message.source.kind !== 'a2a') return;
      const original = Message.fromJSON(JSON.parse(message.source.message));
      const position = this.pending(run).findIndex((input) => input.id === message.id);
      this.observe(phase, run, {
        target: message.source.target,
        input: original.parts
          .flatMap((part) => (part.content?.$case === 'text' ? [part.content.value] : []))
          .join('\n'),
        position: position < 0 ? undefined : position + 1,
        taskId: message.source.taskId,
        messageId: original.messageId,
        referenceTaskIds: original.referenceTaskIds,
        nativeMessageId: message.id,
        queuedAt: message.source.queuedAt,
        ...fields,
      });
    } catch (error) {
      console.error('[dsh-a2a] inbox observer failed:', error);
    }
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
    let complete!: () => void;
    let finished = false;
    const selectedAt = new Map<string, number>();
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      const phase = this.outcome(task);
      const run = this.contexts.get(task.contextId);
      if (phase && run) this.observe(phase, run, { taskId: task.id });
      selectedAt.clear();
      complete();
    };
    return {
      task,
      translator: new SessionTranslator(task.id, task.contextId),
      bus,
      done,
      finish,
      settled: false,
      headers: new Map(),
      selectedAt,
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
    const run = await this.context(snapshot.contextId, context);
    let task = run.tasks.get(snapshot.id);
    if (!task) task = this.restoreTask(run, snapshot, context);
    task.pendingRequests++;
    try {
      await this.admit(run, task, message, context, controls.target, controls.wakeup);
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
    const run = await this.context(snapshot.contextId, context);
    const task = run.tasks.get(taskId) ?? this.restoreTask(run, snapshot, context);
    if (task.settled) {
      await task.done;
      await this.checkpoint(structuredClone(task.task), task.context);
    }
  }

  private outcome(task: Task): 'completed' | 'failed' | 'canceled' | undefined {
    if (task.status?.state === TaskState.TASK_STATE_COMPLETED) return 'completed';
    if (task.status?.state === TaskState.TASK_STATE_CANCELED) return 'canceled';
    if (
      task.status?.state === TaskState.TASK_STATE_FAILED ||
      task.status?.state === TaskState.TASK_STATE_REJECTED
    )
      return 'failed';
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
    wakeup: boolean,
    accepted?: () => void,
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
          queuedAt: Date.now(),
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
      accepted?.();
      run.entry.handle.agent.send(message, target, wakeup);
      this.observeInput('admitted', run, message);
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
      const run = await this.context(contextId, context);
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
      if (!preadmitted)
        await this.admit(run, task, userMessage, context, controls.target, controls.wakeup, () =>
          bus.publish(AgentEvent.task(structuredClone(task!.task))),
        );
      else {
        task.pendingRequests--;
        bus.publish(AgentEvent.task(structuredClone(task.task)));
      }
      this.settle(run, task);
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
        task.task.status = snapshot.status;
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
    if (
      snapshot.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED &&
      !this.pending(run).some(
        (message) => message.source.kind === 'a2a' && message.source.taskId === snapshot.id,
      )
    )
      this.fail(
        restored,
        snapshot.contextId,
        new Error('Task execution was interrupted; DSH has no pending input to resume.'),
      );
    return restored;
  }

  private select(run: ContextRun, task: TaskRun) {
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
  }

  private async prepare(detail: {
    agent: Agent;
    messages: UserMessage[];
    signal: AbortSignal;
    turn?: number;
    step?: number;
  }) {
    const run = this.contexts.get(detail.agent.session.id);
    if (!run) return;
    if (this.stopping) throw new Error('Inbox is unloading.');
    if (!run.active && detail.messages.some((message) => message.source.kind !== 'a2a'))
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
      this.select(run, task);
      const selectedAt = task.selectedAt.get(message.id) ?? Date.now();
      const timing = { selectedAt, turn: detail.turn, step: detail.step };
      try {
        await this.flush(detail.agent.session);
        await this.ctx.serial('a2a/before-step', {
          agent: detail.agent,
          contextId: detail.agent.session.id,
          taskId: task.task.id,
          a2aMessage: Message.fromJSON(JSON.parse(message.source.message)),
          dshMessageId: message.id,
          requestHeaders: task.headers.get(message.id),
          signal: detail.signal,
        });
        detail.signal.throwIfAborted();
      } catch (error) {
        this.observeInput(
          detail.signal.aborted ? 'prepare-aborted' : 'prepare-failed',
          run,
          message,
          timing,
        );
        throw error;
      }
      this.observeInput('prepared', run, message, timing);
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
      task.final = outputs.at(-1);
      if (
        task.final?.kind === 'statusUpdate' &&
        [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED].includes(
          task.final.data.status!.state,
        )
      ) {
        // Official inbox edits append session events; wait until turn/end publication exits.
        void Promise.resolve()
          .then(() => this.settle(run, task))
          .catch((error) => this.fail(task, session.id, error));
        return true;
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
    const terminal =
      task.final?.kind === 'statusUpdate' &&
      [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED].includes(
        task.final.data.status!.state,
      );
    if (task.settled || this.stopping) return;
    if (terminal) {
      this.discard(run, task.task.id);
    } else if (
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
    if (task.settled) return;
    task.settled = true;
    task.controller.abort();
    task.final = terminalStatusUpdate(
      task.task.id,
      contextId,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    if (task.final.kind === 'statusUpdate') task.task.status = task.final.data.status;
    // Cleanup may append inbox events, so it must run outside session publication.
    queueMicrotask(() => {
      try {
        const run = this.contexts.get(contextId);
        if (run) {
          this.discard(run, task.task.id);
          if (run.active === task)
            run.entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
        }
      } catch (cleanupError) {
        console.error('[dsh-a2a] failed task cleanup failed:', cleanupError);
      } finally {
        task.headers.clear();
        task.bus.publish(task.final!);
        task.finish();
      }
    });
  }

  private discard(run: ContextRun, taskId: string): void {
    for (const message of this.pending(run))
      if (message.source.kind === 'a2a' && message.source.taskId === taskId)
        run.entry.handle.agent.inbox.remove(message.id);
  }

  async cancel(taskId: string): Promise<string | undefined> {
    if (this.stopping) throw new Error('Native inbox is unloading.');
    for (const [contextId, run] of this.contexts) {
      if (!run.tasks.has(taskId)) continue;
      const task = run.tasks.get(taskId);
      if (!task) continue;
      if (this.stopping && !task.cancellation) throw new Error('Native inbox is unloading.');
      if (task.settled && task.task.status?.state !== TaskState.TASK_STATE_CANCELED)
        return contextId;
      let operation = task.cancellation;
      if (!operation) {
        operation = this.cancelTask(run, task);
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

  private async cancelTask(run: ContextRun, task: TaskRun): Promise<void> {
    const contextId = run.entry.sessionId;
    const taskId = task.task.id;
    this.discard(run, taskId);
    task.controller.abort();
    task.settled = true;
    task.final = terminalStatusUpdate(taskId, contextId, 'canceled', 'Task canceled by request.');
    if (task.final.kind === 'statusUpdate') task.task.status = task.final.data.status;
    if (run.active === task) {
      run.entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
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
    await this.resolving.get(contextId);
    const run = this.contexts.get(contextId);
    if (!run) return;
    const taskIds = [
      ...new Set(
        [...run.tasks.values()]
          .filter((task) => !task.settled)
          .map((task) => task.task.id)
          .concat(
            this.pending(run).flatMap((message) =>
              message.source.kind === 'a2a' ? [message.source.taskId] : [],
            ),
          ),
      ),
    ];
    for (const admission of run.admissions) admission.abort();
    run.entry.handle.agent.inbox.clear();
    run.entry.handle.agent.cancel({ kind: 'user' });
    await run.entry.handle.agent.whenIdle();
    this.observe('cleared', run, { taskIds });
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
      if (!task.settled) {
        const final = terminalStatusUpdate(task.task.id, session.id, 'canceled', 'Agent disposed.');
        if (final.kind === 'statusUpdate') task.task.status = final.data.status;
        task.bus.publish(final);
      }
      task.settled = true;
      task.controller.abort();
      task.finish();
    }
    this.observe('disposed', run);
    this.contexts.delete(session.id);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = (async () => {
      const failures: unknown[] = [];
      await Promise.allSettled([...this.resolving.values()]);
      const cancellations = [...this.contexts.values()].flatMap((run) =>
        [...run.tasks.values()].flatMap((task) => (task.cancellation ? [task.cancellation] : [])),
      );
      for (const outcome of await Promise.allSettled(cancellations))
        if (outcome.status === 'rejected') failures.push(outcome.reason);
      for (const run of this.contexts.values()) {
        for (const admission of run.admissions) admission.abort();
        try {
          run.entry.handle.agent.cancel({ kind: 'disposed' });
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
            try {
              if (!task.settled) await this.cancelTask(run, task);
            } catch (error) {
              failures.push(error);
            }
            task.finish();
          }
          this.observe('disposed', run);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Native inbox shutdown failed.');
    })();
    return this.shutdownPromise;
  }
}
