/**
 * Bridges A2A tasks to dsh agents.
 *
 * One A2A task maps to one dsh session/agent; the A2A `contextId` IS the dsh
 * sessionId. The bridge owns every agent it creates (the consumer-handle
 * pattern dsh's own ACP bridge uses) and routes the durable `session/event`
 * stream plus the live `agent/assistant-stream` frames (the V3 session log no
 * longer carries incremental chunks) through a per-task
 * {@link SessionTranslator} onto the executing request's
 * {@link ExecutionEventBus}.
 *
 * Turn settlement: `agent.followup()` is fire-and-forget. The default policy
 * settles at the next `turn/end`; a host may keep the same task open for
 * autonomous turns through `a2a/task-settlement`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { type Message, TaskState } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutionEvent, type ExecutionEventBus } from '@a2a-js/sdk/server';
import type { Context } from '@deepseek-ai/cordis';
import type {
  Agent,
  AgentHandle,
  AssistantStreamFrame,
  ModelSelection,
} from '@deepseek-ai/dsh-agent';
// installModelSelection is a root-module runtime import: the dsh-agent index
// pulls workspace-internal packages (dsh-scope) that are absent from the
// plugin's dev install, so unit tests vi.mock this module.
import { installModelSelection } from '@deepseek-ai/dsh-agent';
// Runtime helpers ride the clean subpaths: the dsh-llm/dsh-session index
// modules import packages that are not on npm yet (dsh-timeout, dsh-scope).
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-tools';
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types';
import { AdmissionGate } from './admission.js';
import {
  type A2aApproval,
  type A2aApprovalCodec,
  ApprovalReplyError,
  defaultApprovalCodec,
} from './approval.js';
import { type A2aFileMaterializer, buildMessageContent, uploadsDir } from './content.js';
import type { NativeInbox } from './inbox.js';
import type { A2aTurnContext, A2aWorkingTaskMessageContext } from './index.js';
import { agentTextMessage, SessionTranslator, terminalStatusUpdate } from './translator.js';

export interface BridgeOptions {
  /** Absolute working directory for spawned agents. */
  cwd: string;
  /** Upload root for persisted file parts; absent = the OS temp dir. */
  uploadsDir?: string;
  /** Allow every private URL host in a trusted intranet. */
  downloadAllowPrivate?: boolean;
  /** Private URL file hosts explicitly allowed by the deployment. */
  downloadAllowedHosts?: readonly string[];
  /** Optional provider/model overrides for created agents. */
  agentOptions?: { provider?: string; model?: string };
  /** Agent preset id; empty/absent = the deployment default (when a roster exists). */
  preset?: string;
  /** Forward attributed descendant tool events; disabled by default. */
  subagentTools?: { enabled: boolean };
}

interface Delegation {
  entry: TaskEntry;
  taskId: string;
  parentSessionId: string;
  parentCallId: string;
}

/**
 * The opportunistic slice of `dsh-agent-presets` we use. Profiles that mount
 * tools per-agent (the web profile disables the host-plane tool plugins) keep
 * them inside preset compositions, so an agent created without one sees an
 * empty tool catalog.
 */
interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
}

export interface TaskEntry {
  taskId: string;
  sessionId: SessionId;
  handle: AgentHandle;
  translator: SessionTranslator;
  /** The in-flight execute()'s bus; null between turns. */
  bus: ExecutionEventBus | null;
  /** Between turn/start and turn/end. */
  turnActive: boolean;
  /** A turn still open from a previous task binding; its turn/end is stale. */
  staleTurn: boolean;
  /** FIFO settlement waiters, one per queued/running execute(). */
  settled: Array<() => void>;
  /** Active execute() calls that must finish before task shells are deleted. */
  running: Set<Promise<void>>;
  pendingMessageAborts: Set<AbortController>;
  admissionAbort?: AbortController;
  settlementAbort: AbortController;
  settling: boolean;
  lastFinal?: AgentExecutionEvent;
  interrupted: boolean;
  terminalState?: 'failed' | 'canceled';
}

interface PendingApproval {
  entry: TaskEntry;
  request: A2aApproval;
  reservedBy?: string;
  prompted: boolean;
  resolve: (outcome: ApprovalOutcome) => void;
  removeAbort: () => void;
}

export class A2aBridge {
  inbox?: NativeInbox;
  private readonly tasks = new Map<string, TaskEntry>(); // taskId → entry
  private readonly bySession = new Map<string, TaskEntry>(); // sessionId (== contextId) → entry
  private readonly clearing = new Set<string>();
  private readonly creating = new Map<string, Set<Promise<unknown>>>();
  private readonly admissions = new AdmissionGate();
  private readonly executing = new Map<string, Set<Promise<void>>>();
  private readonly asked = new Map<
    string,
    Array<{ id: string; toolName: string; callId?: string }>
  >();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly codec: A2aApprovalCodec;
  private readonly delegation = new AsyncLocalStorage<Delegation>();
  private readonly children = new WeakMap<
    Session,
    Delegation & { translator: SessionTranslator }
  >();

  constructor(
    private readonly ctx: Context,
    private readonly options: BridgeOptions,
  ) {
    this.codec =
      (ctx.get('a2aApprovalCodec') as A2aApprovalCodec | undefined) ?? defaultApprovalCodec;
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    ctx.on('session/disposed', (session) => this.onSessionDisposed(session));
    ctx.on('agent/assistant-stream', ({ agent, frame }) => this.onAssistantStream(agent, frame));
    ctx.on('approval/request', (req, next) => this.onApprovalRequest(req, next));
    if (options.subagentTools?.enabled) {
      // Async context distinguishes concurrent dispatches without relying on event order.
      ctx.on('tools/execute', (exec, next) => {
        const session = exec.agent?.session;
        if (!session) return next();
        const child = this.children.get(session);
        const entry = this.bySession.get(session.id) ?? child?.entry;
        if (!entry || entry.staleTurn || (child && child.taskId !== entry.taskId)) return next();
        return this.delegation.run(
          {
            entry,
            taskId: entry.taskId,
            parentSessionId: session.id,
            parentCallId: exec.callId,
          },
          next,
        );
      });
      // Verified against dsh-subagent/session 0.2.0-rc.2: local child creation runs inside dispatch.
      ctx.on('session/created', (session) => {
        try {
          const delegation = this.delegation.getStore();
          if (
            !delegation ||
            session.header.origin !== 'subagent' ||
            session.header.parentSession !== delegation.parentSessionId ||
            // A wake/resume dispatch is not the original creating delegation.
            session.firstLifecycleSeq !== session.inheritedEventCount ||
            delegation.taskId !== delegation.entry.taskId
          )
            return;
          this.children.set(session, {
            ...delegation,
            translator: new SessionTranslator(
              delegation.taskId,
              delegation.entry.sessionId,
              undefined,
              {
                sessionId: session.id,
                agentId: session.id,
                parentSessionId: delegation.parentSessionId,
                parentCallId: delegation.parentCallId,
              },
            ),
          });
        } catch (error) {
          console.error('[dsh-a2a] failed to attribute child session:', error);
        }
      });
    }
  }

  /**
   * Resolve the live task entry, creating the session/agent when needed.
   * `freshTask` tells the executor to anchor the SDK's ResultManager with an
   * initial Task event (status-updates for a task id the store never saw are
   * dropped by it). Rebinding by bare contextId counts as fresh: the SDK mints
   * a new task id for `message/send` calls that omit `taskId`.
   */
  async ensureTask(
    taskId: string,
    contextId: string,
  ): Promise<{ entry: TaskEntry; freshTask: boolean }> {
    const admission = this.admissions.acquire(contextId);
    const creation = admission.ready.then(() => this.ensureTaskInner(taskId, contextId));
    let pending = this.creating.get(contextId);
    if (!pending) {
      pending = new Set();
      this.creating.set(contextId, pending);
    }
    pending.add(creation);
    try {
      return await creation;
    } finally {
      pending.delete(creation);
      if (pending.size === 0) this.creating.delete(contextId);
      admission.release();
    }
  }

  private async ensureTaskInner(
    taskId: string,
    contextId: string,
    clearing = false,
  ): Promise<{ entry: TaskEntry; freshTask: boolean }> {
    if (this.clearing.has(contextId) && !clearing) throw new Error('Context is being cleared.');
    const existing = this.tasks.get(taskId);
    if (existing) return { entry: existing, freshTask: false };

    const forContext = this.bySession.get(contextId);
    if (forContext) {
      const staleTurn = forContext.staleTurn || forContext.turnActive;
      this.settleEntry(forContext, 'Task superseded by a new request.');
      forContext.staleTurn = staleTurn;
      // The previous task may have queued autonomous work that has not started
      // a turn yet. dsh-agent cancel clears that inbox work synchronously.
      try {
        forContext.handle.agent.cancel({ kind: 'user' });
      } catch (error) {
        console.error('[dsh-a2a] rebind cancel failed:', error);
      }
      this.tasks.delete(forContext.taskId);
      forContext.taskId = taskId;
      forContext.translator = new SessionTranslator(
        taskId,
        contextId,
        this.options.agentOptions?.model,
      );
      // A turn still open from the previous binding (e.g. a cancel whose abort
      // is still propagating) must not emit events under the new task id.
      forContext.interrupted = false;
      forContext.terminalState = undefined;
      this.tasks.set(taskId, forContext);
      return { entry: forContext, freshTask: true };
    }

    const sessionId = SessionId(contextId);
    const selection = this.resolveSelection();

    // The web profile disables the host-plane tool plugins — agents get tools
    // only through a mounted agent preset (dsh-host-apiproxy's composeAgent is
    // the reference: resolve the id up front so it lands on the session header,
    // mount inside setup). Profiles without a preset roster (headless) keep
    // host-plane tools and skip this entirely.
    const presets = this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    let agentPreset: string | undefined;
    if (presets) {
      agentPreset = (await presets.resolve(this.options.preset || undefined)).id;
    }

    const agentOptions = selection
      ? { provider: selection.provider, model: selection.model }
      : undefined;
    // The loop's `{{model}}` prompt variable and request routing resolve from
    // the agent's installed model selection (dsh-agent-loop's variables read
    // agent.options; the scoped waterfalls wire provider/model into prompt
    // assembly and the request config). Verified against
    // @deepseek-ai/dsh-headless@0.1.6-alpha.2's run() — entry points are
    // expected to resolve the deployment default themselves.
    const setup =
      selection || agentPreset
        ? async (agentCtx: Context) => {
            if (selection) {
              // Statement, deliberately not returned: a returned disposer would
              // be invoked as the setup commit and immediately unwired. Likewise
              // the mount result must not escape — setup's return value is
              // commit()-shaped to the factory.
              installModelSelection(agentCtx, { current: selection, assembled: undefined });
            }
            if (agentPreset) await presets!.mount(agentCtx, agentPreset);
          }
        : undefined;
    // Persistence is optional in minimal compositions. A stat failure is not
    // absence: let it fail instead of trying create() against an existing id.
    const persistence = this.ctx.get('sessionPersistence') as
      | { stat(id: SessionId): Promise<unknown> }
      | undefined;
    const persisted = await persistence?.stat(sessionId);
    const handle = persisted
      ? await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup,
          ...(this.inbox ? { keepInboxOnDispose: true } : {}),
        })
      : await this.ctx.agents.create({
          sessionId,
          meta: { cwd: this.options.cwd, ...(agentPreset ? { agentPreset } : {}) },
          agentOptions,
          setup,
          ...(this.inbox ? { keepInboxOnDispose: true } : {}),
        });
    const entry: TaskEntry = {
      taskId,
      sessionId,
      handle,
      translator: new SessionTranslator(taskId, contextId, this.options.agentOptions?.model),
      bus: null,
      turnActive: false,
      staleTurn: false,
      settled: [],
      running: new Set(),
      pendingMessageAborts: new Set(),
      settlementAbort: new AbortController(),
      settling: false,
      interrupted: false,
    };
    this.tasks.set(taskId, entry);
    this.bySession.set(contextId, entry);
    return { entry, freshTask: true };
  }

  /** A2A parts → dsh content blocks; throws only when no part is usable. */
  async buildContent(message: Message, contextId: string): Promise<ContentBlock[]> {
    const attachments = this.ctx.get('attachments');
    const materializer = this.ctx.get('a2aFileMaterializer') as A2aFileMaterializer | undefined;
    return buildMessageContent(
      message.parts,
      attachments,
      uploadsDir(this.options.uploadsDir),
      materializer ? { contextId, materializer } : undefined,
      {
        allowPrivate: this.options.downloadAllowPrivate,
        allowedHosts: this.options.downloadAllowedHosts,
      },
    );
  }

  isClearing(contextId: string): boolean {
    return this.clearing.has(contextId);
  }

  /** Called before the SDK starts an executor, so a bad reply cannot fail the live task. */
  validateApprovalMessage(message: Message): boolean {
    const entry = message.contextId
      ? this.bySession.get(message.contextId)
      : this.tasks.get(message.taskId);
    const pending = [...this.approvals].filter(([, value]) => value.entry === entry);
    const reply = this.codec.decode(message);
    if (!pending.length && !reply) return false;
    if (!entry || !message.taskId || entry.taskId !== message.taskId || !reply) {
      throw new ApprovalReplyError(
        'Approval reply requires the current task and a supported outcome.',
      );
    }
    const found = this.findApproval(entry, reply);
    if (!found || (found[1].reservedBy && found[1].reservedBy !== message.messageId)) {
      throw new ApprovalReplyError(
        'Approval request ID or call ID does not match a pending request.',
      );
    }
    return true;
  }

  /** Reserve one reply before the SDK asynchronously loads and saves the task. */
  reserveApprovalMessage(message: Message): (() => void) | undefined {
    if (!this.validateApprovalMessage(message)) return;
    const entry = this.tasks.get(message.taskId)!;
    const [id, approval] = this.findApproval(entry, this.codec.decode(message)!)!;
    if (approval.reservedBy) throw new ApprovalReplyError('Approval reply is already in progress.');
    approval.reservedBy = message.messageId;
    return () => {
      if (this.approvals.get(id) === approval) approval.reservedBy = undefined;
    };
  }

  /** Claim the decision before publishing the reply's task anchor. */
  claimApproval(message: Message): { entry: TaskEntry; resume: () => void } {
    const reply = this.codec.decode(message);
    if (!reply) throw new ApprovalReplyError('Unsupported approval reply.');
    const entry = this.tasks.get(message.taskId);
    const found = entry && this.findApproval(entry, reply);
    if (
      !found ||
      entry.sessionId !== message.contextId ||
      (found[1].reservedBy && found[1].reservedBy !== message.messageId)
    ) {
      throw new ApprovalReplyError('Approval is no longer pending.');
    }
    const [id, approval] = found;
    this.approvals.delete(id);
    approval.removeAbort();
    return {
      entry,
      resume: () => {
        approval.resolve(reply.outcome);
        this.publishNextApproval(entry);
      },
    };
  }

  private findApproval(
    entry: TaskEntry,
    reply: { requestId?: string; callId?: string },
  ): [string, PendingApproval] | undefined {
    if (reply.requestId) {
      const approval = this.approvals.get(reply.requestId);
      return approval?.entry === entry &&
        (reply.callId === undefined || approval.request.callId === reply.callId)
        ? [reply.requestId, approval]
        : undefined;
    }
    if (!reply.callId) return;
    const matches = [...this.approvals].filter(
      ([, approval]) => approval.entry === entry && approval.request.callId === reply.callId,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  async waitForTurn(entry: TaskEntry): Promise<void> {
    await Promise.allSettled([...entry.running]);
  }

  /** The official inbox claim selects the task that owns the next model step. */
  bindInboxTask(
    entry: TaskEntry,
    taskId: string,
    translator: SessionTranslator,
    bus: ExecutionEventBus,
    completion: Promise<void>,
    controller: AbortController,
  ): void {
    this.tasks.delete(entry.taskId);
    entry.taskId = taskId;
    entry.translator = translator;
    entry.bus = bus;
    entry.interrupted = false;
    entry.settlementAbort = controller;
    entry.running.clear();
    entry.running.add(completion);
    void completion.then(() => entry.running.delete(completion));
    this.tasks.set(taskId, entry);
  }

  /** Inspect a message for a live task before the SDK starts its next request. */
  async beforeWorkingTaskMessage(a2aMessage: Message, requestHeaders: unknown): Promise<void> {
    const entry = this.tasks.get(a2aMessage.taskId);
    if (
      !entry ||
      (a2aMessage.contextId && entry.sessionId !== a2aMessage.contextId) ||
      entry.running.size === 0
    )
      return;
    const pending = new AbortController();
    entry.pendingMessageAborts.add(pending);
    try {
      await Promise.race([
        this.ctx.serial('a2a/working-task-message', {
          agent: entry.handle.agent,
          contextId: entry.sessionId,
          taskId: entry.taskId,
          a2aMessage,
          requestHeaders,
          signal: pending.signal,
        } satisfies A2aWorkingTaskMessageContext),
        new Promise<never>((_, reject) => {
          const abort = () =>
            reject(new Error('A2A task was interrupted before message admission.'));
          if (pending.signal.aborted) abort();
          else pending.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      entry.pendingMessageAborts.delete(pending);
    }
  }

  /** Include content preparation in the work a context clear must drain. */
  async trackExecution(contextId: string, run: () => Promise<void>): Promise<void> {
    const execution = run();
    let pending = this.executing.get(contextId);
    if (!pending) {
      pending = new Set();
      this.executing.set(contextId, pending);
    }
    pending.add(execution);
    try {
      await execution;
    } finally {
      pending.delete(execution);
      if (pending.size === 0) {
        this.executing.delete(contextId);
        const entry = this.bySession.get(contextId);
        if (entry && entry.running.size === 0) entry.terminalState = undefined;
      }
    }
  }

  /** Queue one user-message turn on the task's agent and await its `turn/end`. */
  async runTurn(
    entry: TaskEntry,
    content: ContentBlock[],
    bus: ExecutionEventBus,
    taskId: string,
    a2aMessage: Message,
    requestHeaders: unknown,
  ): Promise<void> {
    const previous = [...entry.running];
    const running = (async () => {
      if (entry.interrupted || entry.taskId !== taskId || this.tasks.get(taskId) !== entry) {
        bus.publish(
          terminalStatusUpdate(taskId, entry.sessionId as string, 'canceled', 'Task interrupted.'),
        );
        return;
      }
      await Promise.allSettled(previous);
      if (this.clearing.has(entry.sessionId as string))
        throw new Error('Context is being cleared.');
      if (entry.terminalState) {
        bus.publish(
          terminalStatusUpdate(
            taskId,
            entry.sessionId as string,
            entry.terminalState,
            'Task ended.',
          ),
        );
        return;
      }
      if (entry.interrupted || entry.taskId !== taskId || this.tasks.get(taskId) !== entry) {
        bus.publish(
          terminalStatusUpdate(taskId, entry.sessionId as string, 'canceled', 'Task interrupted.'),
        );
        return;
      }
      await this.runTurnInner(entry, content, bus, taskId, a2aMessage, requestHeaders);
    })();
    entry.running.add(running);
    try {
      await running;
    } catch (error) {
      entry.terminalState = 'failed';
      throw error;
    } finally {
      entry.running.delete(running);
      // Keep a failure visible to messages already admitted into this execution
      // batch; trackExecution clears it once a genuinely new batch can arrive.
      if (entry.running.size === 0 && !this.executing.get(entry.sessionId as string)?.size)
        entry.terminalState = undefined;
    }
  }

  private async runTurnInner(
    entry: TaskEntry,
    content: ContentBlock[],
    bus: ExecutionEventBus,
    taskId: string,
    a2aMessage: Message,
    requestHeaders: unknown,
  ): Promise<void> {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    entry.settled.push(resolveSettled);
    entry.bus = bus;
    entry.settlementAbort = new AbortController();
    entry.settling = false;
    entry.lastFinal = undefined;
    try {
      const message = createUserMessage({ content, source: { kind: 'user' } });
      const admission = new AbortController();
      entry.admissionAbort = admission;
      try {
        await Promise.race([
          this.ctx.serial('a2a/before-followup', {
            agent: entry.handle.agent,
            contextId: entry.sessionId,
            taskId,
            a2aMessage,
            dshMessageId: message.id,
            requestHeaders,
            signal: admission.signal,
          } satisfies A2aTurnContext),
          new Promise<never>((_, reject) => {
            const abort = () =>
              reject(new Error('A2A task was interrupted before message admission.'));
            if (admission.signal.aborted) abort();
            else admission.signal.addEventListener('abort', abort, { once: true });
          }),
        ]);
      } finally {
        if (entry.admissionAbort === admission) entry.admissionAbort = undefined;
      }
      if (
        !entry.settled.includes(resolveSettled) ||
        entry.interrupted ||
        entry.taskId !== taskId ||
        this.tasks.get(taskId) !== entry
      ) {
        return;
      }
      // followup() inserts synchronously, then may claim the message before
      // returning. Observe that insertion so the mapping is both real and early.
      const stopListening = this.ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
        if (agent !== entry.handle.agent || inserted.id !== message.id) return;
        stopListening();
        void this.ctx
          .parallel('a2a/message-admitted', {
            contextId: entry.sessionId,
            taskId,
            a2aMessageId: a2aMessage.messageId,
            dshMessageId: message.id,
            requestHeaders,
          })
          .catch((error: unknown) => {
            console.error('[dsh-a2a] message-admitted listener failed:', error);
          });
      });
      try {
        const result = entry.handle.agent.followup(message) as unknown;
        // followup() is typed void; guard a mistyped async impl anyway — an
        // unhandled rejection would crash the host process, and no turn/end
        // would ever settle this waiter.
        void Promise.resolve(result).catch((error: unknown) => {
          entry.terminalState = 'failed';
          const message = error instanceof Error ? error.message : String(error);
          console.error('[dsh-a2a] followup failed:', error);
          const index = entry.settled.indexOf(resolveSettled);
          if (index >= 0) entry.settled.splice(index, 1);
          if (entry.bus === bus) {
            entry.bus.publish(
              terminalStatusUpdate(taskId, entry.sessionId as string, 'failed', message),
            );
          }
          resolveSettled();
        });
        // Never rejects: waiters only resolve. A synchronous followup() throw
        // means no turn started, so pull its waiter from the FIFO below.
        await settled;
      } finally {
        stopListening();
      }
    } catch (error) {
      const index = entry.settled.indexOf(resolveSettled);
      if (index >= 0) entry.settled.splice(index, 1);
      else return; // cancellation/clear already published the terminal state
      throw error;
    } finally {
      if (entry.bus === bus) {
        entry.settlementAbort.abort();
        entry.bus = null;
      }
    }
  }

  /** Cancel and release the live binding before the caller deletes stored shells. */
  async clearContext(
    contextId: string,
    clearStored: (liveIds: string[]) => Promise<string[]> = async (ids) => ids,
  ): Promise<string[]> {
    if (this.clearing.has(contextId)) throw new Error('Context is already being cleared.');
    this.clearing.add(contextId);
    try {
      await this.inbox?.clear(contextId);
      await Promise.allSettled([...(this.creating.get(contextId) ?? [])]);
      if (this.inbox && !this.bySession.has(contextId)) {
        const persistence = this.ctx.get('sessionPersistence') as
          | { stat(id: SessionId): Promise<unknown> }
          | undefined;
        if (await persistence?.stat(SessionId(contextId)))
          await this.ensureTaskInner(randomUUID(), contextId, true);
      }
      const entry = this.bySession.get(contextId);
      if (entry) {
        entry.handle.agent.inbox?.clear();
        const active = entry.turnActive || entry.running.size > 0;
        this.settleEntry(entry, 'Context cleared.');
        if (active) {
          try {
            await entry.handle.agent.cancel({ kind: 'user' });
          } catch (error) {
            console.error('[dsh-a2a] clear cancel failed:', error);
          }
        }
        await entry.handle.agent.whenIdle();
        await Promise.allSettled([...entry.running]);
        this.tasks.delete(entry.taskId);
        this.bySession.delete(contextId);
        await entry.handle.dispose();
      }
      await Promise.allSettled([...(this.executing.get(contextId) ?? [])]);
      return await clearStored(entry ? [entry.taskId] : []);
    } finally {
      this.clearing.delete(contextId);
    }
  }

  /** Abort the task's active turn; returns the contextId when the task is live. */
  cancel(taskId: string): string | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    const staleTurn = entry.turnActive;
    this.settleEntry(entry, 'Task canceled by request.');
    entry.staleTurn ||= staleTurn;
    // cancel() is typed void; the guard keeps a mistyped async impl from
    // crashing the host (the caller already published its canceled final).
    try {
      void Promise.resolve(entry.handle.agent.cancel({ kind: 'user' }) as unknown).catch(
        (error: unknown) => console.error('[dsh-a2a] cancel failed:', error),
      );
    } catch (error) {
      console.error('[dsh-a2a] cancel failed:', error);
    }
    return entry.sessionId as string;
  }

  /** Dispose every owned agent (plugin unload / server shutdown). */
  async dispose(): Promise<void> {
    try {
      await this.inbox?.shutdown();
    } catch (error) {
      console.error('[dsh-a2a] native inbox shutdown failed:', error);
    }
    const entries = [...this.tasks.values()];
    this.tasks.clear();
    this.bySession.clear();
    for (const entry of entries) {
      this.withdrawApprovals(entry);
      this.settleEntry(entry, 'Plugin unloaded.');
      try {
        await entry.handle.dispose();
      } catch (error) {
        console.error('[dsh-a2a] failed to dispose agent:', error);
      }
    }
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const entry = this.bySession.get(session.id as string);
    if (!entry) {
      const child = this.children.get(session);
      if (
        !child ||
        child.taskId !== child.entry.taskId ||
        !child.entry.bus ||
        child.entry.staleTurn ||
        (event.type !== 'tool/call' && event.type !== 'tool/result')
      )
        return;
      try {
        for (const out of child.translator.handle(event)) child.entry.bus.publish(out);
      } catch (error) {
        console.error('[dsh-a2a] failed to translate child tool event:', error);
      }
      return;
    }
    if (entry.staleTurn) {
      if (event.type === 'turn/end') entry.staleTurn = false;
      return;
    }
    if (event.type === 'approval/asked') {
      const queue = this.asked.get(session.id as string) ?? [];
      queue.push({ id: event.data.id, toolName: event.data.toolName, callId: event.data.callId });
      this.asked.set(session.id as string, queue);
    }
    if (event.type === 'turn/start') entry.turnActive = true;
    if (this.inbox?.onSessionEvent(session, event)) {
      if (event.type === 'turn/end') {
        this.withdrawApprovals(entry);
        this.asked.delete(session.id as string);
        entry.turnActive = false;
      }
      return;
    }
    // No-throw seam: translation errors must never reach the agent loop. The
    // turn/end waiter still resolves below, so a poisoned event cannot hang
    // an in-flight execute() either.
    try {
      const outputs = entry.translator.handle(event);
      if (
        event.type === 'turn/end' &&
        (event.data.reason.kind === 'completed' || event.data.reason.kind === 'max-tokens') &&
        entry.bus
      ) {
        const bus = entry.bus;
        const taskId = entry.taskId;
        entry.lastFinal = outputs[0];
        if (!entry.settling) {
          entry.settling = true;
          const signal = entry.settlementAbort.signal;
          const complete = () => {
            if (signal.aborted || entry.bus !== bus || entry.taskId !== taskId) return;
            if (entry.lastFinal) bus.publish(entry.lastFinal);
            entry.bus = null;
            entry.settlementAbort.abort();
            entry.settled.shift()?.();
          };
          const wait = this.ctx.waterfall(
            'a2a/task-settlement',
            {
              agent: entry.handle.agent,
              contextId: entry.sessionId,
              taskId,
              reason: event.data.reason,
              signal,
            },
            () => {},
          );
          if (!wait) complete();
          else
            void Promise.race([
              wait,
              new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              }),
            ])
              .then(complete)
              .catch((error: unknown) => {
                if (entry.bus !== bus || entry.taskId !== taskId) return;
                entry.terminalState = 'failed';
                const message = error instanceof Error ? error.message : String(error);
                console.error('[dsh-a2a] task settlement failed:', error);
                bus.publish(
                  terminalStatusUpdate(taskId, entry.sessionId as string, 'failed', message),
                );
                entry.bus = null;
                entry.settlementAbort.abort();
                entry.settled.shift()?.();
              });
        }
      } else {
        for (const out of outputs) entry.bus?.publish(out);
      }
    } catch (error) {
      console.error('[dsh-a2a] failed to translate session event:', error);
      if (
        event.type === 'turn/end' &&
        (event.data.reason.kind === 'completed' || event.data.reason.kind === 'max-tokens')
      ) {
        entry.terminalState = 'failed';
        entry.bus?.publish(
          terminalStatusUpdate(
            entry.taskId,
            entry.sessionId as string,
            'failed',
            'Failed to translate agent turn.',
          ),
        );
        entry.bus = null;
        entry.settlementAbort.abort();
        entry.settled.shift()?.();
      }
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind === 'blocked' || event.data.reason.kind === 'error')
        entry.terminalState = 'failed';
      if (event.data.reason.kind === 'aborted') entry.terminalState = 'canceled';
      this.withdrawApprovals(entry);
      this.asked.delete(session.id as string);
      entry.turnActive = false;
      if (event.data.reason.kind !== 'completed' && event.data.reason.kind !== 'max-tokens') {
        entry.settlementAbort.abort();
        entry.bus = null;
        entry.settled.shift()?.();
      }
    }
  }

  /**
   * Live assistant deltas (V3: the durable log only commits settled
   * `assistant/message` events). Same no-throw seam as the session feed.
   */
  private onAssistantStream(agent: Agent, frame: AssistantStreamFrame): void {
    if (this.inbox?.onAssistantStream(agent, frame)) return;
    const entry = this.bySession.get(agent.session.id as string);
    if (!entry || entry.staleTurn) return;
    try {
      for (const out of entry.translator.handleStreamFrame(frame)) entry.bus?.publish(out);
    } catch (error) {
      console.error('[dsh-a2a] failed to translate assistant stream frame:', error);
    }
  }

  private onSessionDisposed(session: Session): void {
    this.inbox?.onDisposed(session);
    this.children.delete(session);
    const entry = this.bySession.get(session.id as string);
    if (!entry) return;
    this.withdrawApprovals(entry);
    this.tasks.delete(entry.taskId);
    this.bySession.delete(session.id as string);
    // A mid-turn disposal never emits turn/end — settle instead of hanging
    // the in-flight execute() calls.
    this.settleEntry(entry, 'Session disposed.');
  }

  /** Close an in-flight stream honestly and release every turn waiter. */
  private settleEntry(entry: TaskEntry, message: string): void {
    entry.interrupted = true;
    for (const pending of entry.pendingMessageAborts) pending.abort();
    entry.admissionAbort?.abort();
    entry.settlementAbort.abort();
    this.withdrawApprovals(entry);
    if (entry.bus && (entry.turnActive || entry.settled.length > 0)) {
      entry.bus.publish(
        terminalStatusUpdate(entry.taskId, entry.sessionId as string, 'canceled', message),
      );
    }
    entry.bus = null;
    entry.turnActive = false;
    for (const resolve of entry.settled.splice(0)) resolve();
  }

  private onApprovalRequest(
    req: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const entry = this.bySession.get(req.agent.session.id as string);
    if (!entry || entry.handle.agent !== req.agent) return next();
    const queue = this.asked.get(entry.sessionId as string) ?? [];
    const matching = queue.filter(
      (ask) => ask.toolName === req.toolName && ask.callId === req.callId,
    );
    // The answerer request has no request ID; duplicate unclaimed audit asks
    // cannot be paired safely without a distinct call ID.
    const asked =
      matching.length === 1 ? queue.splice(queue.indexOf(matching[0]), 1)[0] : undefined;
    if (!asked || !entry.bus || !entry.turnActive || req.signal?.aborted)
      return Promise.resolve('unavailable');
    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        this.approvals.delete(asked.id);
        resolve('cancelled');
        this.publishNextApproval(entry);
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      this.approvals.set(asked.id, {
        entry,
        request: {
          requestId: asked.id,
          toolName: req.toolName,
          reason: req.reason,
          callId: asked.callId,
        },
        prompted: false,
        resolve,
        removeAbort: () => req.signal?.removeEventListener('abort', onAbort),
      });
      this.publishNextApproval(entry);
    });
  }

  private publishNextApproval(entry: TaskEntry): void {
    const waiting = [...this.approvals].filter(([, approval]) => approval.entry === entry);
    if (waiting.some(([, approval]) => approval.prompted)) return;
    const next = waiting[0];
    if (!next || !entry.bus) return;
    const [id, approval] = next;
    approval.prompted = true;
    try {
      const data = this.codec.encode(approval.request);
      const message = agentTextMessage(
        entry.taskId,
        entry.sessionId as string,
        'Tool approval required.',
      );
      message.parts = [
        {
          content: { $case: 'data', value: data },
          metadata: undefined,
          filename: '',
          mediaType: 'application/json',
        },
      ];
      entry.bus!.publish(
        AgentEvent.statusUpdate({
          taskId: entry.taskId,
          contextId: entry.sessionId as string,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            message,
            timestamp: new Date().toISOString(),
          },
          metadata: { dshAgent: { kind: 'state-change', reason: 'approval' } },
        }),
      );
    } catch (error) {
      console.error('[dsh-a2a] failed to publish approval:', error);
      this.approvals.delete(id);
      approval.removeAbort();
      approval.resolve('unavailable');
      this.publishNextApproval(entry);
    }
  }

  private withdrawApprovals(entry: TaskEntry): void {
    for (const [id, approval] of this.approvals) {
      if (approval.entry !== entry) continue;
      this.approvals.delete(id);
      approval.removeAbort();
      approval.resolve('cancelled');
    }
    this.asked.delete(entry.sessionId as string);
  }

  /**
   * Config override wins per field; otherwise the deployment default read from
   * the `agentDefaultModel` service (the entry-point contract — the loop
   * itself does not apply it). Undefined when neither source has a pair
   * (persona-less minimal compositions stay valid).
   */
  private resolveSelection(): ModelSelection | undefined {
    const defaults = (
      this.ctx.get('agentDefaultModel') as { currentSelection?: () => ModelSelection } | undefined
    )?.currentSelection?.();
    const provider = this.options.agentOptions?.provider || defaults?.provider;
    const model = this.options.agentOptions?.model || defaults?.model;
    if (!provider || !model) return undefined;
    return { provider, model, reasoningEffort: defaults?.reasoningEffort };
  }
}
