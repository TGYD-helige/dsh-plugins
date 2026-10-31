/** Native DSH input ownership with standard A2A task delivery. */
import { randomUUID } from 'node:crypto';
import { Message, Role, type Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import {
  AgentEvent,
  type AgentExecutionEvent,
  type ExecutionEventBus,
  type RequestContext,
  ServerCallContext,
  STATE_HEADERS_KEY,
} from '@a2a-js/sdk/server';
import type { Context, FiberState } from '@deepseek-ai/cordis';
import type { Agent, AssistantStreamFrame, InboxTarget } from '@deepseek-ai/dsh-agent';
import type { GoalMessageSource } from '@deepseek-ai/dsh-goal';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm/types';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { A2aBridge, TaskEntry } from './bridge.js';
import { InboxChanges } from './inbox-changes.js';
import type { A2aTurnContext } from './index.js';
import type { A2aServer } from './server.js';
import { commitInboxInput, type ManagedTaskStore, markInboxInputPending } from './task-store.js';
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

const RETAINED_INPUTS = `${INBOX_EXTENSION}#retained-inputs`;

interface InboxSource {
  kind: 'a2a';
  taskId: string;
  /** JSON encoding removes protobuf optional undefined fields before durable admission. */
  message: string;
  target: InboxTarget;
  queuedAt?: number;
  promotedFrom?: string;
  promotionId?: string;
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    a2a: InboxSource;
    goal: GoalMessageSource;
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent/inbox/paused': { paused: boolean };
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
  get(contextId: string): Promise<InboxSnapshot>;
  update(contextId: string, id: string, message: Message): Promise<InboxSnapshot>;
  move(contextId: string, id: string, index: number): Promise<InboxSnapshot>;
  remove(contextId: string, id: string): Promise<InboxSnapshot>;
  clearPending(contextId: string): Promise<InboxSnapshot>;
  executePending(contextId: string, id?: string): Promise<InboxSnapshot>;
  resolve(contextId: string): Promise<Agent>;
  content(message: Message, contextId: string): Promise<ContentBlock[]>;
  /** Admit a same-process host follow-up under an existing task's durable identity. */
  enqueue(
    taskId: string,
    message: Message,
    options?: { target?: InboxTarget; wakeup?: boolean },
  ): Promise<void>;
  /** Transfer one unclaimed independent input into the active task. */
  promote(contextId: string, messageId: string, taskId: string): Promise<void>;
  /** Explicitly resume terminal retained input under a fresh task identity. */
  resume(contextId: string, taskId: string): Promise<string>;
  /** Pause admission and the current driver while retaining pending input. */
  pause(contextId: string): Promise<void>;
  /** Wake retained work in queue order without creating a replacement task. */
  wake(contextId: string): Promise<string[]>;
  /** Standard cancellation is terminal and removes only this task's pending input. */
  cancel(taskId: string): Promise<string | undefined>;
}

export interface InboxSnapshot {
  contextId: string;
  version: number;
  nextTurn: Array<{ id: string; message: unknown; editable: boolean }>;
  nextStep: Array<{ id: string; message: unknown; editable: boolean }>;
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
  /** Claimed input not yet committed as user/message, restored when paused. */
  claimedInputs?: UserMessage[];
  final?: AgentExecutionEvent;
  controller: AbortController;
  settlementStarted?: boolean;
  settlementReady?: boolean;
  pendingRequests: number;
  context: ServerCallContext;
  cancellation?: Promise<void>;
  /** Non-retaining cancellation discards even a commit that finishes later. */
  discardInput?: boolean;
}
interface ContextRun {
  entry: TaskEntry;
  /** Pause blocks new admissions and pre-step claims without clearing retained input. */
  paused: boolean;
  /** Context clear discards late commits after the clearing flag itself resets. */
  discardInput?: boolean;
  /** Full admission commits, drained before shutdown disposal. */
  commits: Set<Promise<void>>;
  // shortcut: settled handles live until context clear/unload; reclaim once task delivery exposes a drain acknowledgment.
  tasks: Map<string, TaskRun>;
  active?: TaskRun;
  goalOwner?: { goalId: string; task: TaskRun };
  claimed: Set<TaskRun>;
  turnStart?: SessionEvent;
  admissions: Set<AbortController>;
  admissionTail: Promise<void>;
  promotions: Map<string, Promise<void>>;
  rolledBack: Set<string>;
  retained: Record<InboxTarget, UserMessage[]>;
}

export class NativeInbox implements A2aInbox {
  readonly changes: InboxChanges;
  private readonly contexts = new Map<string, ContextRun>();
  private readonly resolving = new Map<string, Promise<ContextRun>>();
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private readonly preadmitted = new WeakMap<ServerCallContext, Set<string>>();
  server?: A2aServer;
  private readonly persistence?: SessionPersistence;

  constructor(
    private readonly ctx: Context,
    private readonly bridge: A2aBridge,
    private readonly store: ManagedTaskStore,
    private readonly retainPending = false,
    notifications = false,
  ) {
    this.changes = new InboxChanges(
      ctx,
      (contextId) => this.contexts.has(contextId),
      notifications,
    );
    bridge.inbox = this;
    this.persistence = ctx.get('sessionPersistence');
    if (retainPending)
      ctx.on('session/event', (session, event) => {
        const run = this.contexts.get(session.id);
        // Shutdown drains in-flight commits before disposal; those splices must
        // still update retained input or recovery would see history without a task.
        if (!run || event.type !== 'agent/inbox/spliced' || this.unloading()) return;
        try {
          const splice = event.data;
          run.retained[splice.target].splice(
            splice.start,
            splice.removedCount ?? 0,
            ...structuredClone(splice.inserted),
          );
        } catch (error) {
          console.error('[dsh-a2a] failed to track pending inbox:', error);
        }
      });
    ctx.on('agent/pre-step', async (detail, next) => {
      await this.prepare(detail);
      return next();
    });
    ctx.on('goal/changed', ({ agent, change }) => {
      const run = this.contexts.get(agent.session.id);
      if (!run) return;
      const previous = run.goalOwner;
      if (change.goal?.phase === 'active' && change.goal.activation === 'armed') {
        const task = previous?.goalId === change.ref.id ? previous.task : run.active;
        if (task && !task.settled) run.goalOwner = { goalId: change.ref.id, task };
      } else run.goalOwner = undefined;
      if (previous) this.settle(run, previous.task);
    });
    ctx.on('agent/status', ({ agent, status }) => {
      const run = this.contexts.get(agent.session.id);
      if (status !== 'idle' || !run?.goalOwner) return;
      const { task } = run.goalOwner;
      try {
        const goal = ctx.get('goals')?.get(agent);
        if (goal?.phase === 'active' && goal.activation === 'armed') return;
        run.goalOwner = undefined;
        this.settle(run, task);
      } catch (error) {
        run.goalOwner = undefined;
        this.fail(task, agent.session.id, error);
      }
    });
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const run = this.contexts.get(agent.session.id);
      if (!run) return;
      const task = this.owner(run, message);
      if (task && !task.settled) {
        run.claimed.add(task);
        if (!run.active) this.select(run, task);
        if (run.active === task) {
          const selectedAt = Date.now();
          task.selectedAt.set(message.id, selectedAt);
          this.observeInput('selected', run, message, { selectedAt, turn });
        }
      }
    });
  }

  private unloading(): boolean {
    // Cordis publishes FiberState as a const enum, without a runtime export.
    const unloading: FiberState = 5;
    for (let fiber = this.ctx.fiber; ; ) {
      if (fiber.uid === null || fiber.state === unloading) return true;
      const parent = fiber.parent.fiber;
      if (parent === fiber) return false;
      fiber = parent;
    }
  }

  content(message: Message, contextId: string) {
    return this.bridge.buildContent(message, contextId);
  }
  async resolve(contextId: string): Promise<Agent> {
    return (await this.context(contextId)).entry.handle.agent;
  }

  async get(contextId: string): Promise<InboxSnapshot> {
    const run = await this.context(contextId);
    const agent = run.entry.handle.agent;
    const entries = (messages: readonly UserMessage[]) =>
      messages.map((message) => {
        const task = this.owner(run, message);
        const protocol = task
          ? this.protocolMessage(run, task, message)
          : Message.fromJSON({
              messageId: message.id,
              contextId,
              role: 'ROLE_USER',
              parts: message.content
                .filter((block) => block.type === 'text')
                .map((block) => ({ text: block.text })),
            });
        return {
          id: message.id,
          message: Message.toJSON(protocol),
          editable: message.source.kind === 'a2a',
        };
      });
    return {
      contextId,
      version: agent.session.seq - 1,
      nextTurn: entries(agent.inbox.nextTurn),
      nextStep: entries(agent.inbox.nextStep),
    };
  }

  private async editQueue(
    contextId: string,
    edit: (run: ContextRun) => Promise<void> | void,
  ): Promise<InboxSnapshot> {
    const run = await this.context(contextId);
    const operation = run.admissionTail.then(async () => {
      if (this.stopping || this.bridge.isClearing(contextId))
        throw new RequestMalformedError('Inbox is unloading or clearing.');
      await edit(run);
      await this.flush(run.entry.handle.agent.session);
    });
    run.admissionTail = operation.catch(() => {});
    await operation;
    return this.get(contextId);
  }

  private queued(run: ContextRun, id: string) {
    const agent = run.entry.handle.agent;
    const target = agent.inbox.nextTurn.some((message) => message.id === id)
      ? 'next-turn'
      : 'next-step';
    const items = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
    const index = items.findIndex((message) => message.id === id);
    const message = items[index];
    if (!message) throw new RequestMalformedError('Input is no longer pending.');
    return { agent, target, items, index, message } as const;
  }

  async update(contextId: string, id: string, message: Message): Promise<InboxSnapshot> {
    return this.editQueue(contextId, async (run) => {
      const queued = this.queued(run, id);
      const task = this.owner(run, queued.message);
      if (queued.message.source.kind !== 'a2a' || !task)
        throw new RequestMalformedError('Only task-attributed A2A input can be edited.');
      const original = this.protocolMessage(run, task, queued.message);
      if (
        message.messageId !== original.messageId ||
        message.taskId !== original.taskId ||
        message.contextId !== contextId ||
        message.role !== Role.ROLE_USER ||
        !message.parts.length ||
        message.parts.some((part) => !part.content)
      )
        throw new RequestMalformedError(
          'A user Message with unchanged messageId, taskId and contextId is required.',
        );
      const content = await this.content(message, contextId);
      if (
        this.stopping ||
        this.bridge.isClearing(contextId) ||
        this.queued(run, id).message !== queued.message
      )
        throw new RequestMalformedError('Input changed while editing.');
      await this.ctx.parallel('a2a/before-followup', {
        agent: queued.agent,
        contextId,
        taskId: task.task.id,
        a2aMessage: message,
        dshMessageId: id,
        requestHeaders: task.headers,
        signal: task.controller.signal,
      });
      if (
        this.stopping ||
        this.bridge.isClearing(contextId) ||
        this.queued(run, id).message !== queued.message
      )
        throw new RequestMalformedError('Input changed while editing.');
      const replacement = {
        ...queued.message,
        content,
        source: {
          ...queued.message.source,
          message: JSON.stringify(Message.toJSON(message)),
        },
      };
      if (!queued.agent.inbox.replace(queued.message.id, replacement))
        throw new RequestMalformedError('Input has already been claimed.');
      task.task.history = task.task.history.map((item) =>
        item.messageId === original.messageId
          ? markInboxInputPending(structuredClone(message))
          : item,
      );
      await this.checkpoint(task.task, task.context);
    });
  }

  async move(contextId: string, id: string, index: number): Promise<InboxSnapshot> {
    return this.editQueue(contextId, (run) => {
      const queued = this.queued(run, id);
      if (!Number.isInteger(index) || index < 0 || index >= queued.items.length)
        throw new RequestMalformedError('index must address the same pending list.');
      if (index === queued.index) return;
      // One native splice keeps reordering atomic to observers and crash recovery.
      const items = [...queued.items];
      items.splice(queued.index, 1);
      items.splice(index, 0, queued.message);
      queued.agent.inbox.splice(queued.target, 0, queued.items.length, items);
    });
  }

  private async removed(run: ContextRun, messages: UserMessage[]): Promise<void> {
    for (const task of new Set(messages.map((message) => this.owner(run, message)))) {
      if (!task || task.settled) continue;
      const ids = new Set(
        messages
          .filter(
            (message) => message.source.kind === 'a2a' && message.source.taskId === task.task.id,
          )
          .map((message) =>
            message.source.kind === 'a2a'
              ? Message.fromJSON(JSON.parse(message.source.message)).messageId
              : '',
          ),
      );
      task.task.history = task.task.history.filter((message) => !ids.has(message.messageId));
      if (
        run.active !== task &&
        !run.claimed.has(task) &&
        !this.pending(run).some((message) => this.owner(run, message) === task)
      )
        await this.cancel(task.task.id);
      else await this.checkpoint(task.task, task.context);
    }
  }

  async remove(contextId: string, id: string): Promise<InboxSnapshot> {
    return this.editQueue(contextId, async (run) => {
      const { agent, message } = this.queued(run, id);
      agent.inbox.remove(message.id);
      await this.removed(run, [message]);
    });
  }

  async clearPending(contextId: string): Promise<InboxSnapshot> {
    return this.editQueue(contextId, async (run) => {
      const messages = this.pending(run);
      run.entry.handle.agent.inbox.clear();
      await this.removed(run, messages);
    });
  }

  async executePending(contextId: string, id?: string): Promise<InboxSnapshot> {
    return this.editQueue(contextId, async (run) => {
      if (id !== undefined) {
        const queued = this.queued(run, id);
        if (queued.target !== 'next-turn')
          throw new RequestMalformedError(
            'Execute selects next-turn input; use steer for next-step input.',
          );
        const items = [...queued.items];
        items.splice(queued.index, 1);
        items.unshift(queued.message);
        queued.agent.inbox.splice(queued.target, 0, queued.items.length, items);
      }
      await this.wake(contextId);
    });
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

  // A non-canceled removal keeps an interrupted move distinguishable from explicit cancellation.
  private moveInput(agent: Agent, message: UserMessage, target: InboxTarget): void {
    const from = target === 'next-step' ? 'next-turn' : 'next-step';
    const items = from === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep;
    const index = items.findIndex((item) => item.id === message.id);
    if (index < 0) throw new RequestMalformedError('Queued input has already been claimed.');
    agent.session.append('agent/inbox/spliced', {
      target: from,
      start: index,
      removedCount: 1,
      inserted: [],
    });
    agent.inbox.append(target, message);
  }

  async promote(contextId: string, messageId: string, taskId: string): Promise<void> {
    const run = await this.context(contextId);
    const operation = run.admissionTail.then(() => this.promoteInput(run, messageId, taskId));
    run.admissionTail = operation.catch(() => {});
    run.promotions.set(messageId, operation);
    const clear = () => {
      if (run.promotions.get(messageId) === operation) run.promotions.delete(messageId);
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async promoteInput(run: ContextRun, messageId: string, taskId: string): Promise<void> {
    const agent = run.entry.handle.agent;
    const target = run.tasks.get(taskId);
    const message = agent.inbox.nextTurn.find((item) => item.id === messageId);
    if (message?.source.kind !== 'a2a')
      throw new RequestMalformedError('Queued input has already been claimed.');
    const source = run.tasks.get(message.source.taskId);
    if (!target || !source)
      throw new RequestMalformedError('Promotion requires live source and target tasks.');
    const valid = () =>
      !this.stopping &&
      !this.bridge.isClearing(run.entry.sessionId) &&
      !target.settled &&
      !target.controller.signal.aborted &&
      run.active === target &&
      source !== target &&
      !source.settled &&
      !source.controller.signal.aborted &&
      source.task.history.length === 1 &&
      !source.pendingRequests &&
      !run.claimed.has(source) &&
      agent.inbox.nextTurn.some((item) => item === message);
    if (!valid())
      throw new RequestMalformedError(
        'Promotion requires an unclaimed independent input and an active target.',
      );
    const original = Message.fromJSON(JSON.parse(message.source.message));
    original.taskId = taskId;
    original.referenceTaskIds = [...new Set([...original.referenceTaskIds, source.task.id])];
    const promotionId = randomUUID();
    const promoted: UserMessage = {
      ...message,
      source: {
        ...message.source,
        taskId,
        target: 'next-step',
        promotedFrom: source.task.id,
        promotionId,
        message: JSON.stringify(Message.toJSON(original)),
      },
    };
    target.pendingRequests++;
    try {
      await this.checkpoint(target.task, target.context);
      if (!valid())
        throw new RequestMalformedError('Promotion raced input consumption or task settlement.');
      target.task.history = [...target.task.history, markInboxInputPending(original)];
      target.headers.set(message.id, source.headers.get(message.id));
      if (!agent.inbox.replace(message.id, promoted))
        throw new RequestMalformedError('Queued input has already been claimed.');
      this.moveInput(agent, promoted, 'next-step');
      try {
        await this.flush(agent.session);
      } catch (error) {
        // Until the session checkpoint succeeds, the independent task still owns this input.
        const rollback = {
          ...message,
          source: { ...message.source, promotedFrom: source.task.id },
        };
        run.rolledBack.add(promotionId);
        const live =
          this.contexts.get(run.entry.sessionId) === run &&
          !this.stopping &&
          !this.bridge.isClearing(run.entry.sessionId);
        if (live && !source.settled && !source.controller.signal.aborted) {
          if (this.pending(run).some((item) => item.id === message.id)) {
            agent.inbox.replace(message.id, rollback);
            this.moveInput(agent, rollback, 'next-turn');
          } else agent.inbox.append('next-turn', rollback);
        } else if (live) agent.inbox.remove(message.id);
        target.task.history = target.task.history.filter(
          (item) => item.messageId !== original.messageId,
        );
        target.headers.delete(message.id);
        try {
          if (live) await this.flush(agent.session);
        } catch (rollbackError) {
          console.error('[dsh-a2a] promotion rollback checkpoint failed:', rollbackError);
        }
        throw error;
      }
      if (
        this.stopping ||
        this.contexts.get(run.entry.sessionId) !== run ||
        this.bridge.isClearing(run.entry.sessionId)
      )
        throw new RequestMalformedError('Promotion was interrupted by context disposal.');
      source.controller.abort();
      try {
        await this.checkpoint(target.task, target.context);
      } finally {
        await this.cancel(source.task.id);
      }
      this.observeInput('promoted', run, promoted);
    } finally {
      target.pendingRequests--;
      this.settle(run, target);
    }
  }

  async resume(contextId: string, taskId: string): Promise<string> {
    const context = new ServerCallContext();
    const previous = await this.store.load(taskId, context);
    if (!previous || previous.contextId !== contextId || !this.terminal(previous))
      throw new Error('Resume requires a terminal retained task.');
    const retained = previous.metadata?.[RETAINED_INPUTS];
    if (typeof retained !== 'string') throw new Error('Task has no retained input to resume.');
    const inputs = JSON.parse(retained) as Array<{
      position: number;
      target: InboxTarget;
      message: UserMessage;
    }>;
    if (!inputs.length) throw new Error('Task has no retained input to resume.');
    const run = await this.context(contextId, context);
    const id = randomUUID();
    const replacement: Task = {
      ...previous,
      id,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      history: [],
      metadata: { ...previous.metadata },
    };
    delete replacement.metadata![RETAINED_INPUTS];
    const retainedInputs = inputs.map((input) => {
      if (input.message.source.kind !== 'a2a')
        throw new Error('Retained input has invalid task ownership.');
      const original = Message.fromJSON(JSON.parse(input.message.source.message));
      original.taskId = id;
      original.referenceTaskIds = [...new Set([...original.referenceTaskIds, taskId])];
      replacement.history.push(markInboxInputPending(original));
      return {
        ...input,
        message: {
          ...input.message,
          source: {
            ...input.message.source,
            taskId: id,
            message: JSON.stringify(Message.toJSON(original)),
          },
        },
      };
    });
    await this.checkpoint(replacement, context);
    for (const [index, input] of retainedInputs.entries()) {
      if (this.pending(run).some((pending) => pending.id === input.message.id))
        run.entry.handle.agent.inbox.remove(input.message.id);
      run.entry.handle.agent.send(input.message, input.target, index === retainedInputs.length - 1);
    }
    this.restoreTask(run, replacement, context);
    return id;
  }

  /** Repair only an incomplete ownership move, never an ordinary DSH claim. */
  private async recoverPromotions(run: ContextRun, context: ServerCallContext): Promise<void> {
    const agent = run.entry.handle.agent;
    const transfers = new Map<
      string,
      { message: UserMessage & { source: InboxSource }; placed: boolean }
    >();
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue;
      for (const message of event.data.inserted) {
        if (message.source.kind !== 'a2a' || !message.source.promotedFrom) continue;
        const previous = transfers.get(message.id);
        transfers.set(message.id, {
          message: message as UserMessage & { source: InboxSource },
          // A completed transfer stays complete after later public queue edits.
          placed:
            event.data.target === message.source.target ||
            !!(
              previous?.placed &&
              previous.message.source.taskId === message.source.taskId &&
              previous.message.source.promotionId === message.source.promotionId
            ),
        });
      }
    }
    for (const { message, placed } of transfers.values()) {
      if (!placed) {
        const queued = this.pending(run).find((item) => item.id === message.id);
        if (queued) this.moveInput(agent, message, message.source.target);
        else agent.inbox.append(message.source.target, message);
      }
      if (this.pending(run).some((item) => item.id === message.id)) {
        const recipient = await this.store.load(message.source.taskId, context);
        if (!recipient || recipient.contextId !== agent.session.id)
          throw new Error('Promoted A2A task is not accessible.');
        const original = Message.fromJSON(JSON.parse(message.source.message));
        if (!recipient.history.some((item) => item.messageId === original.messageId)) {
          recipient.history.push(markInboxInputPending(original));
          await this.checkpoint(recipient, context);
        }
      }
      if (message.source.promotedFrom === message.source.taskId) continue;
      const former = await this.store.load(message.source.promotedFrom!, context);
      if (!former || this.terminal(former)) continue;
      former.status = {
        state: TaskState.TASK_STATE_CANCELED,
        message: undefined,
        timestamp: new Date().toISOString(),
      };
      await this.flush(agent.session);
      await this.checkpoint(former, context);
    }
  }

  private async recoverRetained(run: ContextRun, context: ServerCallContext): Promise<void> {
    if (!this.retainPending) return;
    const agent = run.entry.handle.agent;
    const committed = new Set(
      agent.session
        .snapshotEvents()
        .flatMap((event) => (event.type === 'user/message' ? [event.data.id] : [])),
    );
    const snapshots: Task[] = [];
    const inputs: Array<{ position: number; target: InboxTarget; message: UserMessage }> = [];
    let pageToken = '';
    do {
      const page = await this.store.list(
        {
          tenant: '',
          contextId: agent.session.id,
          pageSize: 100,
          pageToken,
          status: TaskState.TASK_STATE_UNSPECIFIED,
          statusTimestampAfter: undefined,
        },
        context,
      );
      for (const task of page.tasks) {
        const retained = task.metadata?.[RETAINED_INPUTS];
        if (typeof retained !== 'string') continue;
        // Terminal snapshots belong to explicit resume(); do not consume their
        // retained metadata during ordinary context recovery.
        if (this.terminal(task)) continue;
        snapshots.push(task);
        for (const input of JSON.parse(retained) as typeof inputs) {
          const { message } = input;
          if (message.source.kind !== 'a2a' || message.source.taskId !== task.id)
            throw new Error('Retained input has invalid task ownership.');
          if (!committed.has(message.id)) inputs.push(input);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    const queuedAtOf = (input: (typeof inputs)[number]) =>
      input.message.source.kind === 'a2a' ? (input.message.source.queuedAt ?? 0) : 0;
    // Equal per-task positions must not inherit the store's timestamp ordering.
    const ordered = inputs.sort((a, b) => a.position - b.position || queuedAtOf(a) - queuedAtOf(b));
    const destinationIds: Record<InboxTarget, Set<UserMessage['id']>> = {
      'next-step': new Set(agent.inbox.nextStep.map((message) => message.id)),
      'next-turn': new Set(agent.inbox.nextTurn.map((message) => message.id)),
    };
    const existingIds = new Set([...destinationIds['next-step'], ...destinationIds['next-turn']]);
    type Candidate = (typeof inputs)[number];
    const byPosition = new Map<InboxTarget, Map<number, Candidate[]>>();
    for (const input of ordered) {
      const positions = byPosition.get(input.target) ?? new Map<number, Candidate[]>();
      const group = positions.get(input.position) ?? [];
      group.push(input);
      positions.set(input.position, group);
      byPosition.set(input.target, positions);
    }
    const nextInGroup = new Map<InboxTarget, Map<UserMessage['id'], Candidate | undefined>>();
    const nextPosition = new Map<InboxTarget, Map<number, number | undefined>>();
    for (const [target, positions] of byPosition) {
      nextInGroup.set(target, new Map());
      nextPosition.set(target, new Map());
      const orderedPositions = [...positions.keys()].sort((a, b) => a - b);
      for (const position of orderedPositions) {
        const group = positions.get(position)!;
        const stack: number[] = [];
        for (let index = 0; index < group.length; index++) {
          while (stack.length && queuedAtOf(group[stack.at(-1)!]) <= queuedAtOf(group[index]))
            stack.pop();
          if (stack.length)
            nextInGroup.get(target)!.set(group[index].message.id, group[stack.at(-1)!]);
          stack.push(index);
        }
      }
      for (let index = orderedPositions.length - 1; index >= 0; index--) {
        const position = orderedPositions[index];
        const next = orderedPositions[index + 1];
        nextPosition.get(target)!.set(position, next);
      }
    }
    const laterFor = (input: Candidate) => {
      let candidate = nextInGroup.get(input.target)?.get(input.message.id);
      while (candidate && !destinationIds[input.target].has(candidate.message.id))
        candidate = nextInGroup.get(input.target)?.get(candidate.message.id);
      if (candidate) return candidate;
      let position = nextPosition.get(input.target)?.get(input.position);
      const queuedAt = queuedAtOf(input);
      while (position !== undefined) {
        const candidate = byPosition
          .get(input.target)
          ?.get(position)
          ?.find(
            (item) =>
              queuedAtOf(item) > queuedAt && destinationIds[input.target].has(item.message.id),
          );
        if (candidate) return candidate;
        position = nextPosition.get(input.target)?.get(position);
      }
      return undefined;
    };
    for (const input of ordered) {
      const { message, target } = input;
      if (message.source.kind !== 'a2a') continue;
      const destination = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn;
      if (existingIds.has(message.id)) {
        if (!destinationIds[target].has(message.id)) {
          this.moveInput(agent, message, target);
          const from = target === 'next-step' ? 'next-turn' : 'next-step';
          destinationIds[from].delete(message.id);
          destinationIds[target].add(message.id);
        }
        continue;
      }
      // Keep the recovered public order; only an interrupted earlier input is
      // inserted before the first retained message queued after it.
      const later = laterFor(input);
      const insertAt = later
        ? destination.findIndex((pending) => pending.id === later.message.id)
        : destination.length;
      agent.inbox.splice(target, Math.min(insertAt, destination.length), 0, [message]);
      existingIds.add(message.id);
      destinationIds[target].add(message.id);
    }
    if (!snapshots.length) return;
    await this.flush(agent.session);
    for (const task of snapshots) {
      delete task.metadata![RETAINED_INPUTS];
      await this.checkpoint(task, context);
    }
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
          paused: false,
          tasks: new Map(),
          claimed: new Set(),
          admissions: new Set(),
          commits: new Set(),
          admissionTail: Promise.resolve(),
          promotions: new Map(),
          rolledBack: new Set(),
          retained: { 'next-step': [], 'next-turn': [] },
        };
        const pause = [...run.entry.handle.agent.session.snapshotEvents()]
          .reverse()
          .find((event) => event.type === 'agent/inbox/paused');
        if (pause) run.paused = pause.data.paused;
        await this.recoverRetained(run, context);
        await this.recoverPromotions(run, context);
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
        run.retained = structuredClone({
          'next-step': [...entry.handle.agent.inbox.nextStep],
          'next-turn': [...entry.handle.agent.inbox.nextTurn],
        });
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
      const pending =
        this.stopping && this.retainPending
          ? [...run.retained['next-step'], ...run.retained['next-turn']]
          : this.pending(run);
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
      const task = this.owner(run, message);
      if (!task) return;
      const original = this.protocolMessage(run, task, message);
      const position = this.pending(run).findIndex((input) => input.id === message.id);
      this.observe(phase, run, {
        target: message.source.kind === 'a2a' ? message.source.target : 'next-turn',
        input: original.parts
          .flatMap((part) => (part.content?.$case === 'text' ? [part.content.value] : []))
          .join('\n'),
        position: position < 0 ? undefined : position + 1,
        taskId: task.task.id,
        messageId: original.messageId,
        referenceTaskIds: original.referenceTaskIds,
        nativeMessageId: message.id,
        queuedAt: message.source.kind === 'a2a' ? message.source.queuedAt : undefined,
        ...fields,
      });
    } catch (error) {
      console.error('[dsh-a2a] inbox observer failed:', error);
    }
  }

  private async flush(session: Session): Promise<void> {
    const sessions = this.ctx.get('sessions');
    if (sessions) await sessions.flush(session);
    else await this.ctx.parallel('session/flush', session);
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
    if (run.paused) throw new Error('Inbox is paused.');
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
        : [...history, markInboxInputPending(a2aMessage)];
      await this.checkpoint({ ...task.task, history: acceptedHistory }, context);
      // The durable checkpoint is the admission commit point. A later abort may
      // reject the caller, but must not strand history without its native input.
      task.task.history = acceptedHistory;
      task.headers.set(message.id, headers);
      accepted?.();
      run.entry.handle.agent.send(message, target, wakeup);
      // Explicit discard markers survive cancel/clear state resets. Disposal
      // and retain-pending shutdown deliberately leave them unset.
      if (task.discardInput || run.discardInput) run.entry.handle.agent.inbox.remove(message.id);
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
    // Admission order follows the abortable wait, but shutdown separately drains
    // every full commit so an interrupted caller cannot strand durable input.
    run.commits.add(work);
    void work.finally(() => run.commits.delete(work)).catch(() => {});
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
      if (task?.settled || (this.stopping && this.retainPending)) return;
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
      if (task) {
        this.fail(task, contextId, error);
        await task.done;
      } else bus.publish(terminalStatusUpdate(taskId, contextId, 'failed', text));
    } finally {
      bus.finished();
    }
  }

  private restoreTask(run: ContextRun, snapshot: Task, context: ServerCallContext): TaskRun {
    for (const event of run.entry.handle.agent.session.snapshotEvents()) {
      if (
        event.type === 'user/message' &&
        event.data.source.kind === 'a2a' &&
        event.data.source.taskId === snapshot.id
      )
        commitInboxInput(snapshot.history, Message.fromJSON(JSON.parse(event.data.source.message)));
    }

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

  private protocolMessage(run: ContextRun, task: TaskRun, message: UserMessage): Message {
    if (message.source.kind === 'a2a') return Message.fromJSON(JSON.parse(message.source.message));
    return Message.fromJSON({
      messageId: message.id,
      taskId: task.task.id,
      contextId: run.entry.sessionId,
      role: 'ROLE_USER',
      parts: message.content
        .filter((block) => block.type === 'text')
        .map((block) => ({ text: block.text })),
    });
  }

  private owner(run: ContextRun, message: UserMessage): TaskRun | undefined {
    if (message.source.kind === 'a2a') return run.tasks.get(message.source.taskId);
    if (message.source.kind !== 'goal' || message.source.round <= 0) return;
    const goal = this.ctx.get('goals')?.get(run.entry.handle.agent);
    if (
      run.goalOwner &&
      goal &&
      run.goalOwner.goalId === message.source.goalId &&
      goal.id === message.source.goalId &&
      goal.revision === message.source.revision &&
      goal.phase === 'active' &&
      goal.activation === 'armed'
    )
      return run.goalOwner.task;
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
    if (run.paused) throw new Error('Inbox is paused.');
    if (this.stopping) throw new Error('Inbox is unloading.');
    for (let index = detail.messages.length - 1; index >= 0; index--) {
      const message = detail.messages[index]!;
      if (message.source.kind !== 'a2a' || !message.source.promotionId) continue;
      const promotion = run.promotions.get(message.id);
      if (promotion) {
        let onAbort!: () => void;
        try {
          await Promise.race([
            promotion.catch(() => {}),
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(detail.signal.reason);
              detail.signal.addEventListener('abort', onAbort, { once: true });
              if (detail.signal.aborted) onAbort();
            }),
          ]);
          detail.signal.throwIfAborted();
        } finally {
          detail.signal.removeEventListener('abort', onAbort);
        }
      }
      if (run.rolledBack.delete(message.source.promotionId)) detail.messages.splice(index, 1);
    }
    if (!run.active && detail.messages.some((message) => !this.owner(run, message)))
      throw new Error('Native host input requires task-attributed a2aInbox.enqueue().');
    // Restarted steering and an ordinary queued turn may be claimed together by the core.
    // Requeue other owners before committing any user message, keeping task lifecycles separate.
    const owner = detail.messages.find((message) => message.source.kind === 'a2a');
    if (owner?.source.kind === 'a2a') {
      const taskId = owner.source.taskId;
      const deferred = detail.messages.filter(
        (message) => message.source.kind === 'a2a' && message.source.taskId !== taskId,
      );
      for (const message of deferred.slice().reverse()) {
        detail.agent.inbox.prepend('next-turn', message);
        if (message.source.kind === 'a2a') {
          const task = run.tasks.get(message.source.taskId);
          if (task) run.claimed.delete(task);
        }
      }
      for (let index = detail.messages.length - 1; index >= 0; index--)
        if (deferred.includes(detail.messages[index]!)) detail.messages.splice(index, 1);
    }
    for (const message of detail.messages) {
      const task = this.owner(run, message);
      if (!task && message.source.kind !== 'a2a') continue;
      if (!task || task.settled)
        throw new Error('Queued input has no live A2A task; restore it before waking.');
      if (run.active && run.active !== task)
        throw new Error('A model step cannot consume inputs from different A2A tasks.');
      this.select(run, task);
      task.claimedInputs = detail.messages.filter(
        (candidate) => this.owner(run, candidate) === task,
      );
      const selectedAt = task.selectedAt.get(message.id) ?? Date.now();
      const timing = { selectedAt, turn: detail.turn, step: detail.step };
      try {
        await this.flush(detail.agent.session);
        await this.ctx.serial('a2a/before-step', {
          agent: detail.agent,
          contextId: detail.agent.session.id,
          taskId: task.task.id,
          a2aMessage: this.protocolMessage(run, task, message),
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
      run.claimed.clear();
      run.turnStart = event;
      return true;
    }
    const task = run.active;
    if (event.type === 'turn/end' && run.paused) {
      // Paused turns must never discard retained input, including a driver
      // started accidentally before wake(). Requeue before any failure cleanup.
      this.requeueClaimed(run);
      return true;
    }
    if (event.type === 'turn/end') {
      if (!this.stopping && ['error', 'blocked', 'aborted'].includes(event.data.reason.kind))
        for (const owner of run.claimed)
          if (owner !== task && !owner.settled)
            this.fail(
              owner,
              session.id,
              new Error('Selected input was interrupted before its task step.'),
            );
      run.claimed.clear();
    }
    if (!task) return true;
    if (event.type === 'turn/end') task.claimedInputs = undefined;
    if (task.settled) {
      if (event.type === 'turn/end') run.active = undefined;
      return true;
    }
    try {
      if (event.type === 'user/message' && event.data.source.kind === 'a2a') {
        // Commit on the task bus before subsequent assistant deltas, not on admission.
        const status = {
          state: TaskState.TASK_STATE_WORKING,
          message: { ...this.protocolMessage(run, task, event.data), taskId: task.task.id },
          timestamp: new Date().toISOString(),
        };
        task.translator.handle(event);
        commitInboxInput(task.task.history, status.message);
        task.task.status = status;
        task.bus.publish(
          AgentEvent.statusUpdate({
            taskId: task.task.id,
            contextId: session.id,
            status,
            metadata: { dshAgent: { kind: 'user-message' } },
          }),
        );
        return true;
      }
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
      run.goalOwner?.task === task ||
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
    task.discardInput = true;
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

  private requeueClaimed(run: ContextRun): void {
    const task = run.active;
    if (!task?.claimedInputs) return;
    const committed = new Set(
      run.entry.handle.agent.session
        .snapshotEvents()
        .flatMap((event) => (event.type === 'user/message' ? [event.data.id] : [])),
    );
    for (const message of [...task.claimedInputs].reverse()) {
      if (message.source.kind !== 'a2a' || committed.has(message.id)) continue;
      if (!this.pending(run).some((pending) => pending.id === message.id))
        run.entry.handle.agent.inbox.prepend(message.source.target, message);
    }
    task.claimedInputs = undefined;
  }

  async pause(contextId: string): Promise<void> {
    const run = await this.context(contextId);
    if (run.paused) return;
    run.paused = true;
    run.entry.handle.agent.session.append('agent/inbox/paused', { paused: true });
    for (const admission of run.admissions) admission.abort();
    run.entry.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await run.entry.handle.agent.whenIdle();
    this.requeueClaimed(run);
  }

  async wake(contextId: string): Promise<string[]> {
    const run = await this.context(contextId);
    const pending = this.pending(run).filter((message) => message.source.kind === 'a2a');
    run.paused = false;
    run.entry.handle.agent.session.append('agent/inbox/paused', { paused: false });
    for (const [index, input] of pending.entries()) {
      if (this.pending(run).some((message) => message.id === input.id))
        run.entry.handle.agent.inbox.remove(input.id);
      const target = input.source.kind === 'a2a' ? input.source.target : 'next-turn';
      run.entry.handle.agent.send(input, target, index === pending.length - 1);
    }
    const taskIds = [
      ...new Set(
        pending.flatMap((input) => (input.source.kind === 'a2a' ? [input.source.taskId] : [])),
      ),
    ];
    this.observe('woken', run, { taskIds });
    return taskIds;
  }

  async clear(contextId: string) {
    await this.resolving.get(contextId);
    const run = this.contexts.get(contextId);
    if (!run) return;
    run.discardInput = true;
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
    run.retained = { 'next-step': [], 'next-turn': [] };
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
    if (!run || (this.retainPending && this.stopping)) return;
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
    this.changes.close();
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
        // An aborted caller may already have settled, but its durable commit can
        // still be in flight. Finish that work before agent/session disposal.
        for (const outcome of await Promise.allSettled([...run.commits]))
          if (outcome.status === 'rejected') failures.push(outcome.reason);
        try {
          run.entry.handle.agent.cancel({ kind: 'disposed' }, { keepInbox: this.retainPending });
        } catch (error) {
          failures.push(error);
        }
        try {
          await run.entry.handle.agent.whenIdle();
        } catch (error) {
          failures.push(error);
        }
        try {
          // The persistence barrier tolerates writers already closed by parallel core teardown.
          if (this.retainPending && this.persistence) await this.persistence.flush();
          else await this.flush(run.entry.handle.agent.session);
        } catch (error) {
          failures.push(error);
        } finally {
          const targets: InboxTarget[] = ['next-step', 'next-turn'];
          const committed = this.retainPending
            ? new Set(
                run.entry.handle.agent.session
                  .snapshotEvents()
                  .flatMap((event) => (event.type === 'user/message' ? [event.data.id] : [])),
              )
            : new Set<string>();
          const retainedByTask = new Map<
            string,
            Array<{ message: UserMessage; target: InboxTarget; position: number }>
          >();
          let position = 0;
          for (const target of targets) {
            for (const message of run.retained[target]) {
              const input = { message, target, position: position++ };
              if (message.source.kind !== 'a2a' || committed.has(message.id)) continue;
              const group = retainedByTask.get(message.source.taskId) ?? [];
              group.push(input);
              retainedByTask.set(message.source.taskId, group);
            }
          }
          for (const task of run.tasks.values()) {
            try {
              if (!task.settled) {
                if (this.retainPending) {
                  const pending = retainedByTask.get(task.task.id) ?? [];
                  if (pending.length) {
                    task.task.metadata = {
                      ...task.task.metadata,
                      [RETAINED_INPUTS]: JSON.stringify(pending),
                    };
                    await this.checkpoint(structuredClone(task.task), task.context);
                  } else {
                    task.final = terminalStatusUpdate(
                      task.task.id,
                      run.entry.sessionId,
                      'failed',
                      'Host stopped; active input will not be replayed.',
                    );
                    if (task.final.kind === 'statusUpdate')
                      task.task.status = task.final.data.status;
                    await this.checkpoint(structuredClone(task.task), task.context);
                    task.bus.publish(task.final);
                  }
                  task.settled = true;
                  task.controller.abort();
                } else await this.cancelTask(run, task);
              }
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
