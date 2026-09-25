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
 * Turn settlement: `agent.followup()` is fire-and-forget, so callers await a
 * FIFO waiter resolved by the session's next `turn/end` event (dsh's inbox
 * serializes queued follow-ups into successive turns, so waiter order matches
 * turn order). The final status-update is published before the waiter
 * resolves, so an execute() that returns always landed its events first.
 */

import { type Message, TaskState } from '@a2a-js/sdk';
import { AgentEvent, type ExecutionEventBus } from '@a2a-js/sdk/server';
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
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types';
import {
  type A2aApproval,
  type A2aApprovalCodec,
  ApprovalReplyError,
  defaultApprovalCodec,
} from './approval.js';
import { type A2aFileMaterializer, buildMessageContent, uploadsDir } from './content.js';
import { agentTextMessage, SessionTranslator, terminalStatusUpdate } from './translator.js';

export interface BridgeOptions {
  /** Absolute working directory for spawned agents. */
  cwd: string;
  /** Upload root for persisted file parts; absent = the OS temp dir. */
  uploadsDir?: string;
  /** Optional provider/model overrides for created agents. */
  agentOptions?: { provider?: string; model?: string };
  /** Agent preset id; empty/absent = the deployment default (when a roster exists). */
  preset?: string;
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
  /** FIFO turn-end waiters, one per queued/running execute(). */
  settled: Array<() => void>;
  /** Active execute() calls that must finish before task shells are deleted. */
  running: Set<Promise<void>>;
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
  private readonly tasks = new Map<string, TaskEntry>(); // taskId → entry
  private readonly bySession = new Map<string, TaskEntry>(); // sessionId (== contextId) → entry
  private readonly clearing = new Set<string>();
  private readonly creating = new Map<string, Set<Promise<unknown>>>();
  private readonly executing = new Map<string, Set<Promise<void>>>();
  private readonly asked = new Map<
    string,
    Array<{ id: string; toolName: string; callId?: string }>
  >();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly codec: A2aApprovalCodec;

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
    const creation = this.ensureTaskInner(taskId, contextId);
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
    }
  }

  private async ensureTaskInner(
    taskId: string,
    contextId: string,
  ): Promise<{ entry: TaskEntry; freshTask: boolean }> {
    if (this.clearing.has(contextId)) throw new Error('Context is being cleared.');
    const existing = this.tasks.get(taskId);
    if (existing) return { entry: existing, freshTask: false };

    const forContext = this.bySession.get(contextId);
    if (forContext) {
      this.withdrawApprovals(forContext);
      this.tasks.delete(forContext.taskId);
      forContext.taskId = taskId;
      forContext.translator = new SessionTranslator(
        taskId,
        contextId,
        this.options.agentOptions?.model,
      );
      // A turn still open from the previous binding (e.g. a cancel whose abort
      // is still propagating) must not emit events under the new task id.
      forContext.staleTurn = forContext.turnActive;
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
      ? await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      : await this.ctx.agents.create({
          sessionId,
          meta: { cwd: this.options.cwd, ...(agentPreset ? { agentPreset } : {}) },
          agentOptions,
          setup,
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
      if (pending.size === 0) this.executing.delete(contextId);
    }
  }

  /** Queue one user-message turn on the task's agent and await its `turn/end`. */
  async runTurn(
    entry: TaskEntry,
    content: ContentBlock[],
    bus: ExecutionEventBus,
    a2aMessageId: string,
    requestHeaders: unknown,
  ): Promise<void> {
    if (this.clearing.has(entry.sessionId as string)) throw new Error('Context is being cleared.');
    const running = this.runTurnInner(entry, content, bus, a2aMessageId, requestHeaders);
    entry.running.add(running);
    try {
      await running;
    } finally {
      entry.running.delete(running);
    }
  }

  private async runTurnInner(
    entry: TaskEntry,
    content: ContentBlock[],
    bus: ExecutionEventBus,
    a2aMessageId: string,
    requestHeaders: unknown,
  ): Promise<void> {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    entry.settled.push(resolveSettled);
    entry.bus = bus;
    try {
      const message = createUserMessage({ content, source: { kind: 'user' } });
      // followup() inserts synchronously, then may claim the message before
      // returning. Observe that insertion so the mapping is both real and early.
      const stopListening = this.ctx.on('agent/inbox/inserted', ({ agent, message: inserted }) => {
        if (agent !== entry.handle.agent || inserted.id !== message.id) return;
        stopListening();
        void this.ctx
          .parallel('a2a/message-admitted', {
            contextId: entry.sessionId,
            taskId: entry.taskId,
            a2aMessageId,
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
          const message = error instanceof Error ? error.message : String(error);
          console.error('[dsh-a2a] followup failed:', error);
          if (entry.bus === bus) {
            entry.bus.publish(
              terminalStatusUpdate(entry.taskId, entry.sessionId as string, 'failed', message),
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
      throw error;
    } finally {
      if (entry.bus === bus) entry.bus = null;
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
      await Promise.allSettled([...(this.creating.get(contextId) ?? [])]);
      const entry = this.bySession.get(contextId);
      if (entry) {
        this.withdrawApprovals(entry);
        if (entry.turnActive || entry.running.size > 0) {
          await entry.handle.agent.cancel({ kind: 'user' });
        }
        await entry.handle.agent.whenIdle();
        this.settleEntry(entry, 'Context cleared.');
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
    this.withdrawApprovals(entry);
    // cancel() is typed void; the guard keeps a mistyped async impl from
    // crashing the host (the caller already published its canceled final).
    void Promise.resolve(entry.handle.agent.cancel({ kind: 'user' }) as unknown).catch(
      (error: unknown) => console.error('[dsh-a2a] cancel failed:', error),
    );
    return entry.sessionId as string;
  }

  /** Dispose every owned agent (plugin unload / server shutdown). */
  async dispose(): Promise<void> {
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
    if (!entry) return;
    if (event.type === 'approval/asked') {
      const queue = this.asked.get(session.id as string) ?? [];
      queue.push({ id: event.data.id, toolName: event.data.toolName, callId: event.data.callId });
      this.asked.set(session.id as string, queue);
    }
    if (event.type === 'turn/start') entry.turnActive = true;
    // A turn carried over from a previous task binding (e.g. a canceled turn
    // whose abort was still in flight when the context rebound): its turn/end
    // belongs to the old task — settle waiters, but publish nothing under the
    // new task id.
    const stale = event.type === 'turn/end' && entry.staleTurn;
    if (stale) entry.staleTurn = false;
    // No-throw seam: translation errors must never reach the agent loop. The
    // turn/end waiter still resolves below, so a poisoned event cannot hang
    // an in-flight execute() either.
    try {
      if (!stale) for (const out of entry.translator.handle(event)) entry.bus?.publish(out);
    } catch (error) {
      console.error('[dsh-a2a] failed to translate session event:', error);
    }
    if (event.type === 'turn/end') {
      this.withdrawApprovals(entry);
      this.asked.delete(session.id as string);
      entry.turnActive = false;
      entry.settled.shift()?.();
    }
  }

  /**
   * Live assistant deltas (V3: the durable log only commits settled
   * `assistant/message` events). Same no-throw seam as the session feed.
   */
  private onAssistantStream(agent: Agent, frame: AssistantStreamFrame): void {
    const entry = this.bySession.get(agent.session.id as string);
    if (!entry) return;
    try {
      for (const out of entry.translator.handleStreamFrame(frame)) entry.bus?.publish(out);
    } catch (error) {
      console.error('[dsh-a2a] failed to translate assistant stream frame:', error);
    }
  }

  private onSessionDisposed(session: Session): void {
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
    this.withdrawApprovals(entry);
    if (entry.turnActive && entry.bus) {
      entry.bus.publish(
        terminalStatusUpdate(entry.taskId, entry.sessionId as string, 'canceled', message),
      );
    }
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
