/**
 * dsh-langfuse — Langfuse observability for DeepSeek Harness.
 *
 * Instruments the documented seams, with zero core patches:
 *
 * - `llm/stream` waterfall  → one Langfuse **generation** per LLM call
 *   (input = full request; output, token usage and finish reason collected
 *   from the chunk stream), plus a nested `llm-request` **span** holding the
 *   verbatim loop-built request (the rawest request a plugin can observe —
 *   the provider HTTP body is assembled inside the adapter).
 * - `tools/execute` waterfall → one Langfuse **span** per tool dispatch
 *   (routed to the session's trace via `exec.agent.id` — the agent/session
 *   shared identity).
 * - `session/event` emit    → one Langfuse **trace** per agent turn
 *   (`turn/start` opens, the turn's first `user/message` sets the input,
 *   `turn/end` stamps the end reason).
 * - subagent child sessions (`session/created` with `header.parentSession`)
 *   ride the parent's trace: a `subagent` **span** opened under the enclosing
 *   delegation tool span, the child's generations/tool spans nested under it,
 *   closed at `subagent/end` (enriched by `subagent/start` and the child's
 *   `subagent/descriptor` event).
 *
 * Event/waterfall shapes verified against the installed
 * @deepseek-ai/dsh-{llm,session,tools,agent,subagent}@0.1.0-rc.7 package sources
 * (types for shapes; `lib/*.js` for the session/created ordering claim).
 *
 * @module dsh-langfuse
 */

import type { Context } from '@deepseek-ai/cordis';
import type { FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { isTokenDelta } from '@deepseek-ai/dsh-llm/message';
import type { UserMessage } from '@deepseek-ai/dsh-session';
// Augmentation-only import: pulls the `subagent/start` / `subagent/end` Events
// declarations into the compilation (the listeners are contextually typed).
import type {} from '@deepseek-ai/dsh-subagent';
// Augmentation-only import: pulls the `tools/execute` Events declaration into
// the compilation (the listener itself is contextually typed).
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { LangfuseReporter, type ObservationLevel } from './client.js';

export const name = 'dsh-langfuse';

/**
 * Waterfall listeners only need the events to exist; no hard service
 * dependency is declared so the plugin still loads in minimal compositions
 * (it simply never observes anything). Add 'llm' / 'tools' to `inject` if you
 * prefer fail-fast wiring.
 */
export const inject = [] as string[];

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('master switch'),
  publicKey: Schema.string().default('').description('Langfuse public key'),
  secretKey: Schema.string().role('secret').default('').description('Langfuse secret key'),
  baseUrl: Schema.string().default('https://cloud.langfuse.com'),
  traceName: Schema.string().default('dsh-turn'),
  /** Include full message/tool payloads in Langfuse IO. Disable to log metadata only. */
  captureContent: Schema.boolean().default(true),
});

export interface LangfusePluginConfig {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  traceName: string;
  captureContent: boolean;
}

type TraceHandle = ReturnType<LangfuseReporter['openTrace']>;
type SpanHandle = ReturnType<LangfuseReporter['startSpan']>;

/** Per-session open turn trace. */
interface SessionTrace {
  trace: NonNullable<TraceHandle>;
  /** Whether the trace input was set — the turn's first `user/message` wins. */
  hasInput: boolean;
}

/**
 * A subagent child session (header.parentSession set at session/created):
 * rides the parent session's trace under one `subagent` span instead of
 * opening own turn traces.
 */
interface ChildSession {
  parentSessionId: string;
  /** The open `subagent` span for this child (null when creation failed). */
  span: SpanHandle;
  /** Whether the span input was set — the child's first `user/message` wins. */
  hasInput: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Provider/tool error text can embed prompt fragments, paths, or credentials —
 * it crosses to Langfuse only when `captureContent` allows content. Structural
 * facts (levels, kinds, error codes) always do.
 */
const contentMessage = (config: LangfusePluginConfig, text: string): string | undefined =>
  config.captureContent ? text : undefined;

/** Trace input: the user message's text blocks, joined. */
function messageText(message: UserMessage): string | undefined {
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  return text.length > 0 ? text.join('\n') : undefined;
}

/**
 * Langfuse model parameters: only the request fields actually set. Stop
 * sequences are arbitrary request strings — content, not metadata — so under
 * `captureContent: false` they collapse to a count.
 */
function modelParametersOf(
  options: GenerateOptions,
  captureContent: boolean,
): Record<string, string | number | boolean | string[] | null> | undefined {
  const params = Object.fromEntries(
    Object.entries({
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: captureContent ? options.stop : undefined,
      stopCount: captureContent ? undefined : options.stop?.length,
      reasoningEffort: options.reasoningEffort,
    }).filter(([, value]) => value !== undefined),
  );
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * The loop-built request as Langfuse input: verbatim (minus the AbortSignal,
 * which is not JSON-safe) when content capture is on, counts-only otherwise.
 */
function requestBodyOf(options: GenerateOptions, captureContent: boolean): Record<string, unknown> {
  if (!captureContent) {
    return {
      messageCount: options.messages.length,
      hasSystem: options.system !== undefined,
      toolCount: options.tools?.length,
    };
  }
  const body: Partial<GenerateOptions> = { ...options };
  delete body.signal;
  return body;
}

export function apply(ctx: Context, config: LangfusePluginConfig): Promise<void> | void {
  if (!config.enabled || !config.publicKey || !config.secretKey) return;

  const reporter = new LangfuseReporter(config);
  const sessions = new Map<string, SessionTrace>();
  const children = new Map<string, ChildSession>();
  /** Per-session stack of currently open tools/execute spans (for subagent parenting). */
  const openToolSpans = new Map<string, SpanHandle[]>();

  /**
   * The trace an observation for `sessionId` belongs to: the session's open
   * turn trace, else a per-session one-off trace shared by everything outside
   * a turn (between-turn maintenance calls like compaction, sessions that
   * started before the plugin loaded, session-less hand-built calls) so those
   * observations stay in one trace instead of fragmenting per call. The next
   * `turn/start` replaces it. Subagent child sessions resolve through their
   * parent chain to the root trace (the depth bound is a cycle guard —
   * delegation depth is config-capped, 8 is purely defensive).
   */
  function traceFor(sessionId: string | undefined): TraceHandle {
    let id = sessionId;
    for (let depth = 0; id && children.has(id) && depth < 8; depth++) {
      id = children.get(id)?.parentSessionId;
    }
    const existing = id ? sessions.get(id) : undefined;
    if (existing) return existing.trace;
    const trace = reporter.openTrace({ name: config.traceName, sessionId: id });
    // hasInput starts true: one-offs never take a turn's first-message input.
    if (trace && id) sessions.set(id, { trace, hasInput: true });
    return trace;
  }

  /**
   * The observation a generation/span for `sessionId` parents under: the
   * child's own `subagent` span when there is one, else the turn trace.
   */
  function parentFor(sessionId: string | undefined): TraceHandle | SpanHandle {
    const child = sessionId ? children.get(sessionId) : undefined;
    return child?.span ?? traceFor(sessionId);
  }

  // ------------------------------------------------------------------
  // Subagent child sessions: session/created precedes both subagent/start
  // and the child's first generation, and the durable header already links
  // child → parent (verified against dsh-subagent@0.1.0-rc.7).
  // ------------------------------------------------------------------
  ctx.on('session/created', (session) => {
    const parentSessionId: string | undefined = session.header.parentSession;
    if (!parentSessionId) return;
    const childId: string = session.id;
    // Parent under the enclosing delegation tool span when one is open
    // (foreground runs execute inside the parent's tools/execute), else the
    // parent's own subagent span (nested delegation), else the root trace.
    const parentObservation =
      openToolSpans.get(parentSessionId)?.at(-1) ??
      children.get(parentSessionId)?.span ??
      traceFor(parentSessionId);
    const span = reporter.startSpan(parentObservation, {
      name: 'subagent',
      metadata: {
        childSessionId: childId,
        delegationDepth: session.header.delegationDepth,
      },
    });
    children.set(childId, { parentSessionId, span, hasInput: false });
  });

  ctx.on('subagent/start', (info) => {
    const child = children.get(info.id);
    if (!child) return; // remote (ACP) runs have no local session — nothing to nest
    reporter.updateSpan(child.span, { metadata: { provider: info.provider, local: info.local } });
  });

  ctx.on('subagent/end', (info) => {
    const child = children.get(info.id);
    if (!child) return;
    children.delete(info.id);
    reporter.endSpan(child.span, {
      output: {
        stopReason: info.stopReason,
        ...(config.captureContent ? { lastAssistantMessage: info.lastAssistantMessage } : {}),
      },
      level:
        info.stopReason === 'error'
          ? 'ERROR'
          : info.stopReason === 'aborted'
            ? 'WARNING'
            : 'DEFAULT',
    });
  });

  // ------------------------------------------------------------------
  // Trace lifecycle: one trace per turn (top-level sessions only — child
  // sessions ride the parent's trace under their subagent span).
  // ------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const sessionId: string = session.id;
    const child = children.get(sessionId);
    if (child) {
      // The delegated prompt (the child's first user/message) is the
      // subagent span's input; the descriptor enriches the span name.
      if (event.type === 'user/message' && !child.hasInput && config.captureContent) {
        reporter.updateSpan(child.span, { input: messageText(event.data) });
        child.hasInput = true;
      } else if (event.type === 'subagent/descriptor') {
        reporter.updateSpan(child.span, {
          name: event.data.label ? `subagent: ${event.data.label}` : 'subagent',
          metadata: { mode: event.data.mode, provider: event.data.provider },
        });
      }
      return;
    }
    switch (event.type) {
      case 'turn/start': {
        // A leftover entry is either a between-turns one-off trace or a turn
        // whose `turn/end` was never seen (crash-orphaned): replace it — the
        // stale trace keeps what it already recorded.
        const trace = reporter.openTrace({
          name: config.traceName,
          sessionId,
          metadata: { turn: event.data.turn },
        });
        if (trace) sessions.set(sessionId, { trace, hasInput: false });
        break;
      }
      case 'user/message': {
        const state = sessions.get(sessionId);
        if (state && !state.hasInput && config.captureContent) {
          reporter.updateTrace(state.trace, { input: messageText(event.data) });
          state.hasInput = true;
        }
        break;
      }
      case 'turn/end': {
        const state = sessions.get(sessionId);
        if (state) {
          sessions.delete(sessionId);
          reporter.updateTrace(state.trace, {
            metadata: { turn: event.data.turn, endReason: event.data.reason.kind },
          });
        }
        break;
      }
    }
  });

  ctx.on('session/disposed', (session) => {
    const sessionId: string = session.id;
    sessions.delete(sessionId);
    openToolSpans.delete(sessionId);
    const child = children.get(sessionId);
    if (child) {
      children.delete(sessionId);
      // A child torn down without a subagent/end (crash, abort): close its
      // span instead of leaking it open.
      reporter.endSpan(child.span, {
        level: 'WARNING',
        statusMessage: 'session disposed before subagent/end',
      });
    }
  });

  // ------------------------------------------------------------------
  // Generation per LLM call. The waterfall is SYNCHRONOUS (cordis returns
  // the outermost listener's return value as the stream), so the listener
  // must not be async — it returns an async-generator tee instead.
  // ------------------------------------------------------------------
  ctx.on('llm/stream', (options, next) => {
    const generation = reporter.startGeneration(parentFor(options.sessionId), {
      name: options.purpose ? `llm-call [${options.purpose}]` : 'llm-call',
      model: options.model,
      input: config.captureContent
        ? { messages: options.messages, system: options.system, tools: options.tools }
        : { messageCount: options.messages.length },
      modelParameters: modelParametersOf(options, config.captureContent),
      metadata: { purpose: options.purpose },
    });

    // The rawest request a plugin can observe: the loop-built GenerateOptions
    // verbatim, pre-adapter (the provider HTTP body is assembled inside the
    // adapter — dsh exposes no seam for it). Nested under the generation,
    // closed alongside it with the same outcome.
    const requestSpan = reporter.startSpan(generation, {
      name: 'llm-request',
      input: requestBodyOf(options, config.captureContent),
      metadata: {
        provider: options.provider,
        reasoningEffort: options.reasoningEffort,
        purpose: options.purpose,
      },
    });
    const closeRequest = (level: ObservationLevel, statusMessage?: string) => {
      reporter.endSpan(requestSpan, { level, statusMessage });
    };

    let stream: AsyncIterable<StreamChunk>;
    try {
      stream = next();
    } catch (error) {
      const statusMessage = contentMessage(config, messageOf(error));
      closeRequest('ERROR', statusMessage);
      reporter.endGeneration(generation, { level: 'ERROR', statusMessage });
      throw error;
    }

    // Tee the chunk stream: replay every chunk unchanged, then close the
    // generation from the terminal `finish` chunk and accumulated content.
    // Stream failures surface as a `finish` chunk with an error/aborted
    // reason rather than throwing; the `finally` also closes the generation
    // when the consumer abandons the stream early.
    return (async function* () {
      let text = '';
      const toolCalls: Array<{ name: string; arguments: string }> = [];
      let usage: TokenUsage | undefined;
      let finish: FinishReason | undefined;
      let completionStartTime: Date | undefined;
      let failed = false;
      const outputBody = () =>
        config.captureContent
          ? toolCalls.length > 0
            ? { text, toolCalls }
            : text || undefined
          : undefined;
      try {
        for await (const chunk of stream) {
          // TTFT is the first real token — block boundaries, usage frames and
          // empty heartbeat deltas are not completions (dsh's shared predicate).
          if (completionStartTime === undefined && isTokenDelta(chunk)) {
            completionStartTime = new Date();
          }
          switch (chunk.type) {
            case 'text-delta':
              text += chunk.text;
              break;
            case 'block-end':
              if (chunk.block.type === 'tool-call') {
                toolCalls.push({ name: chunk.block.name, arguments: chunk.block.arguments });
              }
              break;
            case 'usage':
              usage = chunk.usage;
              break;
            case 'finish':
              finish = chunk.reason;
              break;
          }
          yield chunk;
        }
      } catch (error) {
        failed = true;
        const statusMessage = contentMessage(config, messageOf(error));
        closeRequest('ERROR', statusMessage);
        // Partial progress still counts: keep whatever streamed before the throw.
        reporter.endGeneration(generation, {
          output: outputBody(),
          usage,
          completionStartTime,
          level: 'ERROR',
          statusMessage,
        });
        throw error;
      } finally {
        if (!failed) {
          const failure =
            finish && (finish.kind === 'error' || finish.kind === 'aborted') ? finish : undefined;
          // No terminal finish chunk (the consumer abandoned the stream or
          // the adapter cut it short): the call's outcome is unknown — mark
          // it instead of posing as a normal completion.
          let level: ObservationLevel = 'DEFAULT';
          let statusMessage: string | undefined;
          if (failure) {
            level = failure.kind === 'aborted' ? 'WARNING' : 'ERROR';
            statusMessage = contentMessage(config, failure.failure.message);
          } else if (!finish) {
            level = 'WARNING';
            statusMessage = 'stream closed before the terminal finish chunk';
          }
          closeRequest(level, statusMessage);
          reporter.endGeneration(generation, {
            output: outputBody(),
            usage,
            completionStartTime,
            level,
            statusMessage,
            metadata: {
              finishReason: finish?.kind,
              errorCode: failure?.failure.code,
              incomplete: finish ? undefined : true,
              toolCallCount: toolCalls.length > 0 ? toolCalls.length : undefined,
            },
          });
        }
      }
    })();
  });

  // ------------------------------------------------------------------
  // Span per tool dispatch. This waterfall IS async: `next()` returns the
  // normalized dispatch result promise. Open spans are tracked per session
  // so a subagent span opened mid-dispatch (foreground delegation) parents
  // under the enclosing tool span.
  // ------------------------------------------------------------------
  ctx.on('tools/execute', async (exec, next) => {
    const sessionId = exec.agent?.id;
    const span = reporter.startSpan(parentFor(sessionId), {
      name: `tool:${exec.name}`,
      input: config.captureContent ? exec.arguments : undefined,
      metadata: { callId: exec.callId, toolName: exec.name },
    });
    if (sessionId && span) {
      const stack = openToolSpans.get(sessionId) ?? [];
      stack.push(span);
      openToolSpans.set(sessionId, stack);
    }
    try {
      const result = await next();
      reporter.endSpan(span, {
        output: config.captureContent ? result.content : undefined,
        level: result.isError ? 'ERROR' : 'DEFAULT',
        statusMessage: result.isError ? contentMessage(config, result.error.message) : undefined,
        metadata: { errorCode: result.isError ? result.error.info?.code : undefined },
      });
      return result;
    } catch (error) {
      reporter.endSpan(span, {
        level: 'ERROR',
        statusMessage: contentMessage(config, messageOf(error)),
      });
      throw error;
    } finally {
      if (sessionId && span) {
        const remaining = (openToolSpans.get(sessionId) ?? []).filter((s) => s !== span);
        if (remaining.length > 0) openToolSpans.set(sessionId, remaining);
        else openToolSpans.delete(sessionId);
      }
    }
  });

  // Durability checkpoint: the store awaits every session/flush listener.
  ctx.on('session/flush', () => reporter.flush());

  // Lifecycle: this cordis fork has no ready/dispose events — cleanup rides
  // the fiber unload via ctx.effect() (shutdown() chains behind the lazy
  // import, so a still-importing client is never shut down mid-construction).
  ctx.effect(() => {
    return async () => {
      sessions.clear();
      children.clear();
      openToolSpans.clear();
      await reporter.shutdown();
    };
  });

  // Returning the init promise folds the lazy SDK import into this fiber's
  // load transition: cordis awaits a plugin callback's thenable, so a boot
  // that awaits plugin readiness can never observe the import window.
  return reporter.ready;
}
