/**
 * dsh-langfuse — Langfuse observability for DeepSeek Harness.
 *
 * Instruments three documented seams, with zero core patches:
 *
 * - `llm/stream` waterfall  → one Langfuse **generation** per LLM call
 *   (input = full request; output, token usage and finish reason collected
 *   from the chunk stream).
 * - `tools/execute` waterfall → one Langfuse **span** per tool dispatch
 *   (routed to the session's trace via `exec.agent.id` — the agent/session
 *   shared identity).
 * - `session/event` emit    → one Langfuse **trace** per agent turn
 *   (`turn/start` opens, the turn's first `user/message` sets the input,
 *   `turn/end` stamps the end reason).
 *
 * Event/waterfall shapes verified against the installed
 * @deepseek-ai/dsh-{llm,session,tools,agent}@0.1.0-rc.7 type declarations.
 *
 * @module dsh-langfuse
 */

import type { Context } from '@deepseek-ai/cordis';
import type { FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import { isTokenDelta } from '@deepseek-ai/dsh-llm/message';
import type { UserMessage } from '@deepseek-ai/dsh-session';
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

/** Per-session open turn trace. */
interface SessionTrace {
  trace: NonNullable<TraceHandle>;
  /** Whether the trace input was set — the turn's first `user/message` wins. */
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

export function apply(ctx: Context, config: LangfusePluginConfig): Promise<void> | void {
  if (!config.enabled || !config.publicKey || !config.secretKey) return;

  const reporter = new LangfuseReporter(config);
  const sessions = new Map<string, SessionTrace>();

  /**
   * The trace an observation for `sessionId` belongs to: the session's open
   * turn trace, else a fresh one-off (between-turn maintenance calls like
   * compaction, sessions that started before the plugin loaded, and
   * session-less hand-built calls all land on untracked traces).
   */
  function traceFor(sessionId: string | undefined): TraceHandle {
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) return existing.trace;
    return reporter.openTrace({ name: config.traceName, sessionId });
  }

  // ------------------------------------------------------------------
  // Trace lifecycle: one trace per turn.
  // ------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const sessionId: string = session.id;
    switch (event.type) {
      case 'turn/start': {
        // A leftover entry means a `turn/end` was never seen (crash-orphaned
        // turn): drop it — the stale trace keeps what it already recorded.
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
    sessions.delete(session.id);
  });

  // ------------------------------------------------------------------
  // Generation per LLM call. The waterfall is SYNCHRONOUS (cordis returns
  // the outermost listener's return value as the stream), so the listener
  // must not be async — it returns an async-generator tee instead.
  // ------------------------------------------------------------------
  ctx.on('llm/stream', (options, next) => {
    const generation = reporter.startGeneration(traceFor(options.sessionId), {
      name: options.purpose ? `llm-call [${options.purpose}]` : 'llm-call',
      model: options.model,
      input: config.captureContent
        ? { messages: options.messages, system: options.system, tools: options.tools }
        : { messageCount: options.messages.length },
      modelParameters: modelParametersOf(options, config.captureContent),
      metadata: { purpose: options.purpose },
    });

    let stream: AsyncIterable<StreamChunk>;
    try {
      stream = next();
    } catch (error) {
      reporter.endGeneration(generation, {
        level: 'ERROR',
        statusMessage: contentMessage(config, messageOf(error)),
      });
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
        reporter.endGeneration(generation, {
          level: 'ERROR',
          statusMessage: contentMessage(config, messageOf(error)),
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
          reporter.endGeneration(generation, {
            output: config.captureContent
              ? toolCalls.length > 0
                ? { text, toolCalls }
                : text || undefined
              : undefined,
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
  // normalized dispatch result promise.
  // ------------------------------------------------------------------
  ctx.on('tools/execute', async (exec, next) => {
    const span = reporter.startSpan(traceFor(exec.agent?.id), {
      name: `tool:${exec.name}`,
      input: config.captureContent ? exec.arguments : undefined,
      metadata: { callId: exec.callId, toolName: exec.name },
    });
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
      await reporter.shutdown();
    };
  });

  // Returning the init promise folds the lazy SDK import into this fiber's
  // load transition: cordis awaits a plugin callback's thenable, so a boot
  // that awaits plugin readiness can never observe the import window.
  return reporter.ready;
}
