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
import type { AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent';
// installModelSelection is a root-module runtime import: the dsh-agent index
// pulls workspace-internal packages (dsh-scope) that are absent from the
// plugin's dev install, so unit tests vi.mock this module.
import { installModelSelection } from '@deepseek-ai/dsh-agent';
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

    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.options.cwd, ...(agentPreset ? { agentPreset } : {}) },
      agentOptions: selection
        ? { provider: selection.provider, model: selection.model }
        : undefined,
      // The loop's `{{model}}` prompt variable and request routing resolve from
      // the agent's installed model selection (dsh-agent-loop's variables read
      // agent.options; the scoped waterfalls wire provider/model into prompt
      // assembly and the request config). Verified against
      // @deepseek-ai/dsh-headless@0.1.0-rc.7's run() — entry points are
      // expected to resolve the deployment default themselves.
      setup:
        selection || agentPreset
          ? async (agentCtx) => {
              if (selection) {
                // Statement, deliberately not returned: a returned disposer would
                // be invoked as the setup commit and immediately unwired. Likewise
                // the mount result must not escape — setup's return value is
                // commit()-shaped to the factory.
                installModelSelection(agentCtx, { current: selection, assembled: undefined });
              }
              if (agentPreset) await presets!.mount(agentCtx, agentPreset);
            }
          : undefined,
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
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    entry.settled.push(resolveSettled);
    entry.bus = bus;
    try {
      const result = entry.handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }),
      ) as unknown;
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
      // Never rejects: waiters only resolve. A synchronous followup() throw is
      // the one failure path — it means no turn ever started, so pull this
      // waiter back out of the FIFO before it can be settled by the NEXT
      // turn's turn/end (which would resolve one execute() too early).
      await settled;
    } catch (error) {
      const index = entry.settled.indexOf(resolveSettled);
      if (index >= 0) entry.settled.splice(index, 1);
      throw error;
    } finally {
      if (entry.bus === bus) entry.bus = null;
    }
  }

  /** Abort the task's active turn; returns the contextId when the task is live. */
  cancel(taskId: string): string | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
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
