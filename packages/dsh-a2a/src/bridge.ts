/**
 * Bridges A2A tasks to dsh agents.
 *
 * One A2A task maps to one dsh session/agent; the A2A `contextId` IS the dsh
 * sessionId. The bridge owns every agent it creates (the consumer-handle
 * pattern dsh's own ACP bridge uses) and routes the durable `session/event`
 * stream through a per-task {@link SessionTranslator} onto the executing
 * request's {@link ExecutionEventBus}.
 *
 * Turn settlement: `agent.followup()` is fire-and-forget, so callers await a
 * FIFO waiter resolved by the session's next `turn/end` event (dsh's inbox
 * serializes queued follow-ups into successive turns, so waiter order matches
 * turn order). The final status-update is published before the waiter
 * resolves, so an execute() that returns always landed its events first.
 */

import type { ExecutionEventBus } from '@a2a-js/sdk/server';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
// Runtime helpers ride the clean subpaths: the dsh-llm/dsh-session index
// modules import packages that are not on npm yet (dsh-timeout, dsh-scope).
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { SessionTranslator, terminalStatusUpdate } from './translator.js';

export interface BridgeOptions {
  /** Absolute working directory for spawned agents. */
  cwd: string;
  /** Optional provider/model overrides for created agents. */
  agentOptions?: { provider?: string; model?: string };
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
  /** FIFO turn-end waiters, one per queued/running execute(). */
  settled: Array<() => void>;
}

export class A2aBridge {
  private readonly tasks = new Map<string, TaskEntry>(); // taskId → entry
  private readonly bySession = new Map<string, TaskEntry>(); // sessionId (== contextId) → entry

  constructor(
    private readonly ctx: Context,
    private readonly options: BridgeOptions,
  ) {
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    ctx.on('session/disposed', (session) => this.onSessionDisposed(session));
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
    const existing = this.tasks.get(taskId);
    if (existing) return { entry: existing, freshTask: false };

    const forContext = this.bySession.get(contextId);
    if (forContext) {
      this.tasks.delete(forContext.taskId);
      forContext.taskId = taskId;
      forContext.translator = new SessionTranslator(
        taskId,
        contextId,
        this.options.agentOptions?.model,
      );
      this.tasks.set(taskId, forContext);
      return { entry: forContext, freshTask: true };
    }

    // TODO(verify): resuming a persisted session (agents.resume) after a
    // restart — needs dsh's sessionPersistence service composed. For now a
    // client-supplied contextId simply names the fresh session.
    const sessionId = SessionId(contextId);
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.options.cwd },
      agentOptions: this.options.agentOptions,
    });
    const entry: TaskEntry = {
      taskId,
      sessionId,
      handle,
      translator: new SessionTranslator(taskId, contextId, this.options.agentOptions?.model),
      bus: null,
      turnActive: false,
      settled: [],
    };
    this.tasks.set(taskId, entry);
    this.bySession.set(contextId, entry);
    return { entry, freshTask: true };
  }

  /** Queue one user-message turn on the task's agent and await its `turn/end`. */
  async runTurn(entry: TaskEntry, text: string, bus: ExecutionEventBus): Promise<void> {
    const settled = new Promise<void>((resolve) => entry.settled.push(resolve));
    entry.bus = bus;
    entry.handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    );
    try {
      await settled;
    } finally {
      if (entry.bus === bus) entry.bus = null;
    }
  }

  /** Abort the task's active turn; returns the contextId when the task is live. */
  cancel(taskId: string): string | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    entry.handle.agent.cancel({ kind: 'user' });
    return entry.sessionId as string;
  }

  /** Dispose every owned agent (plugin unload / server shutdown). */
  async dispose(): Promise<void> {
    const entries = [...this.tasks.values()];
    this.tasks.clear();
    this.bySession.clear();
    for (const entry of entries) {
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
    if (event.type === 'turn/start') entry.turnActive = true;
    // No-throw seam: translation errors must never reach the agent loop. The
    // turn/end waiter still resolves below, so a poisoned event cannot hang
    // an in-flight execute() either.
    try {
      for (const out of entry.translator.handle(event)) entry.bus?.publish(out);
    } catch (error) {
      console.error('[dsh-a2a] failed to translate session event:', error);
    }
    if (event.type === 'turn/end') {
      entry.turnActive = false;
      entry.settled.shift()?.();
    }
  }

  private onSessionDisposed(session: Session): void {
    const entry = this.bySession.get(session.id as string);
    if (!entry) return;
    this.tasks.delete(entry.taskId);
    this.bySession.delete(session.id as string);
    // A mid-turn disposal never emits turn/end — settle instead of hanging
    // the in-flight execute() calls.
    this.settleEntry(entry, 'Session disposed.');
  }

  /** Close an in-flight stream honestly and release every turn waiter. */
  private settleEntry(entry: TaskEntry, message: string): void {
    if (entry.turnActive && entry.bus) {
      entry.bus.publish(
        terminalStatusUpdate(entry.taskId, entry.sessionId as string, 'canceled', message),
      );
    }
    entry.turnActive = false;
    for (const resolve of entry.settled.splice(0)) resolve();
  }
}
