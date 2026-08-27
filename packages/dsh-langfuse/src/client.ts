/**
 * Langfuse reporter — thin synchronous wrapper over the Langfuse JS SDK v5's
 * OpenTelemetry-based tracing API (`@langfuse/tracing` + `@langfuse/otel`),
 * and the plugin's single no-throw seam: every method swallows SDK failures
 * with a `[dsh-langfuse]` console.error so observability can never break the
 * agent loop.
 *
 * v5's observations-first data model has no trace object: a trace is the root
 * observation plus the correlating attributes every observation carries. So:
 * - a "trace" here is a root `LangfuseSpan` created with {@link NO_PARENT} —
 *   without it the SDK parents to whatever span is active in the host's
 *   ambient OTEL context (e.g. an instrumented HTTP server around dsh),
 *   smearing turn traces into foreign traces;
 * - trace-level input/output/metadata live on that root span (the v5
 *   replacement for the removed `trace.update()`), and the root must be
 *   ENDED — spans only export on end, so an un-ended root never leaves the
 *   process;
 * - the correlating `session.id` attribute is stamped on every observation
 *   via a handle-keyed WeakMap — the explicit-tree equivalent of v5's
 *   context-scoped `propagateAttributes()`, which cannot wrap this plugin's
 *   event-driven lifecycle.
 *
 * The SDK stack is a heavy optional peer set, so it loads via dynamic
 * `import()` kicked off in the constructor — a disabled plugin never pays for
 * it, and a missing or incompatible peer degrades the reporter to a no-op
 * instead of breaking the plugin load. The exporter runs on an ISOLATED
 * tracer provider (`setLangfuseTracerProvider`) rather than
 * `provider.register()`: the process-global OTEL provider stays untouched and
 * the host keeps its own tracing pipeline. {@link LangfuseReporter.ready}
 * settles (never rejects) once the import+wiring finished: the plugin returns
 * it from `apply()` so fiber readiness covers the import window, and
 * {@link flush}/{@link shutdown} chain behind it. Observation calls landing
 * before readiness are still dropped — a window that cannot exist once the
 * plugin fiber has been awaited.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type { LangfuseGeneration, LangfuseSpan } from '@langfuse/tracing';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export interface LangfuseConnectionConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export type ObservationLevel = 'DEFAULT' | 'WARNING' | 'ERROR';

/** Any observation that can parent a span (trace root span or nested span/generation). */
type Observation = LangfuseSpan | LangfuseGeneration;

/** The trace-correlating attributes stamped on every observation of a trace. */
interface TraceContext {
  sessionId?: string;
  traceName: string;
}

/**
 * OTEL's canonical invalid span context as a literal (a static
 * `INVALID_SPAN_CONTEXT` import would load @opentelemetry/api eagerly, even
 * for a disabled plugin): the SDK starts a fresh traceId for an invalid
 * parent instead of adopting the ambient context's active span.
 */
const NO_PARENT = { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };

/**
 * Map dsh token accounting onto Langfuse's `usageDetails`, keeping every
 * bucket mutually exclusive (Langfuse's flat-bucket rule: `input` excludes
 * `input_*`, `output` excludes `output_*`, `total` is the bucket sum —
 * overlapping buckets double-count usage and inferred cost). dsh reports
 * uncached input, separate cache buckets, and provider-style output that
 * INCLUDES reasoning (verified in dsh-llm-deepseek@0.1.0-rc.7:
 * `outputTokens: usage.completion_tokens`, with reasoning split out of
 * `completion_tokens_details`), so the `output` bucket subtracts
 * `reasoningTokens` into `output_reasoning`. Only `usageDetails` is sent.
 */
export function usageOf(usage: TokenUsage): Record<string, number> {
  // The dsh type marks the two primary fields required, but a non-conformant
  // adapter emitting a partial usage chunk would otherwise turn every bucket
  // NaN (serialized as null by the SDK — silently corrupting billed usage).
  const input =
    (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const output = usage.outputTokens ?? 0;
  const total = input + output;
  // Clamp reasoning at the provider's output count: reasoning is a subset of
  // output, and only a broken adapter would report more — clamping keeps the
  // buckets summing to total even then.
  const reasoning = Math.min(usage.reasoningTokens ?? 0, output);
  const usageDetails: Record<string, number> = {
    input: usage.inputTokens ?? 0,
    output: output - reasoning,
    total,
  };
  if (usage.cacheReadTokens) usageDetails.input_cache_read = usage.cacheReadTokens;
  if (usage.cacheWriteTokens) usageDetails.input_cache_creation = usage.cacheWriteTokens;
  if (reasoning) usageDetails.output_reasoning = reasoning;
  return usageDetails;
}

export class LangfuseReporter {
  private tracing: typeof import('@langfuse/tracing') | null = null;
  private provider: NodeTracerProvider | null = null;
  /**
   * Observation → its trace's correlating attributes; children inherit their
   * parent's. Stamped on every observation (`session.id`,
   * `langfuse.trace.name`): v5's observations-first model wants trace context
   * on every span (the v4 migration doc: "copied to every span where the name
   * must be queryable"), and older Langfuse servers derive the trace row from
   * ANY span carrying these — a root-only stamp can lose to child-derived
   * trace events depending on ingestion order. This is the explicit
   * handle-tree equivalent of v5's context-scoped propagateAttributes, which
   * cannot wrap this plugin's event-driven lifecycle.
   */
  private traceContext = new WeakMap<Observation, TraceContext>();
  /** Trace roots (created by openTrace) — the spans that may carry trace-level IO. */
  private roots = new WeakSet<Observation>();
  /** Settles (never rejects) once the lazy SDK import+wiring finished. */
  readonly ready: Promise<void>;

  constructor(private config: LangfuseConnectionConfig) {
    this.ready = this.init();
  }

  /** Dynamically import the SDK and wire the isolated export pipeline. */
  private async init(): Promise<void> {
    try {
      const [tracing, otel, sdkNode] = await Promise.all([
        import('@langfuse/tracing'),
        import('@langfuse/otel'),
        import('@opentelemetry/sdk-trace-node'),
      ]);
      const processor = new otel.LangfuseSpanProcessor({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.baseUrl,
      });
      this.provider = new sdkNode.NodeTracerProvider({ spanProcessors: [processor] });
      // Isolated provider, not provider.register(): the process-global OTEL
      // provider stays untouched. Set `tracing` last — observation methods
      // gate on it, and it must never be visible before the provider is wired.
      tracing.setLangfuseTracerProvider(this.provider);
      this.tracing = tracing;
    } catch (error) {
      console.error('[dsh-langfuse] client init failed:', error);
    }
  }

  /**
   * Stamp the trace-correlating attributes on an observation and record them
   * for future children. `session.id` = `LangfuseOtelSpanAttributes.TRACE_SESSION_ID`
   * (the OTEL semconv key); `langfuse.trace.name` = `TRACE_NAME`.
   */
  private stampTraceContext(observation: Observation, context: TraceContext | undefined): void {
    if (!context) return;
    observation.otelSpan.setAttribute('langfuse.trace.name', context.traceName);
    if (context.sessionId) observation.otelSpan.setAttribute('session.id', context.sessionId);
    this.traceContext.set(observation, context);
  }

  /** Open a trace (one per agent turn, or one-off for session-less calls). */
  openTrace(input: {
    name: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): LangfuseSpan | null {
    if (!this.tracing) return null;
    try {
      const root = this.tracing.startObservation(
        input.name,
        { metadata: input.metadata },
        { parentSpanContext: NO_PARENT },
      );
      this.stampTraceContext(root, { sessionId: input.sessionId, traceName: input.name });
      this.roots.add(root);
      return root;
    } catch (error) {
      console.error('[dsh-langfuse] trace creation failed:', error);
      return null;
    }
  }

  /** Open a generation (one per LLM call) under any observation parent. */
  startGeneration(
    parent: Observation | null,
    input: {
      name: string;
      model?: string;
      input?: unknown;
      modelParameters?: Record<string, string | number>;
      metadata?: Record<string, unknown>;
    },
  ): LangfuseGeneration | null {
    if (!parent) return null;
    try {
      const generation = parent.startObservation(
        input.name,
        {
          model: input.model,
          input: input.input,
          modelParameters: input.modelParameters,
          metadata: input.metadata,
        },
        { asType: 'generation' },
      );
      this.stampTraceContext(generation, this.traceContext.get(parent));
      return generation;
    } catch (error) {
      console.error('[dsh-langfuse] generation creation failed:', error);
      return null;
    }
  }

  endGeneration(
    generation: LangfuseGeneration | null,
    update: {
      name?: string;
      output?: unknown;
      usage?: TokenUsage;
      completionStartTime?: Date;
      level?: ObservationLevel;
      statusMessage?: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    if (!generation) return;
    try {
      generation.update({
        output: update.output,
        usageDetails: update.usage ? usageOf(update.usage) : undefined,
        completionStartTime: update.completionStartTime,
        level: update.level,
        statusMessage: update.statusMessage,
        metadata: update.metadata,
      });
      // v5 observation attributes have no `name` — renames ride the OTEL span.
      if (update.name) generation.otelSpan.updateName(update.name);
      generation.end();
    } catch (error) {
      console.error('[dsh-langfuse] generation end failed:', error);
    }
  }

  /** Open a span (one per tool dispatch, or a nested detail span) under any observation parent. */
  startSpan(
    parent: Observation | null,
    input: { name: string; input?: unknown; metadata?: Record<string, unknown> },
  ): LangfuseSpan | null {
    if (!parent) return null;
    try {
      const span = parent.startObservation(input.name, {
        input: input.input,
        metadata: input.metadata,
      });
      this.stampTraceContext(span, this.traceContext.get(parent));
      return span;
    } catch (error) {
      console.error('[dsh-langfuse] span creation failed:', error);
      return null;
    }
  }

  /**
   * Merge fields into an open span — subagent enrichment (label, provider),
   * and the trace root's input (a v5 trace IS its root span, so trace-level
   * updates are span updates; OTEL attributes merge per key, so partial
   * updates compose). On trace roots the input/output also rides the
   * deprecated `langfuse.trace.*` attributes (setTraceIO): older Langfuse
   * servers derive the trace row's IO from exactly those keys.
   */
  updateSpan(
    span: LangfuseSpan | null,
    update: { name?: string; input?: unknown; metadata?: Record<string, unknown> },
  ): void {
    if (!span) return;
    try {
      span.update({ input: update.input, metadata: update.metadata });
      if (update.name) span.otelSpan.updateName(update.name);
      if (update.input !== undefined && this.roots.has(span)) {
        span.setTraceIO({ input: update.input });
      }
    } catch (error) {
      console.error('[dsh-langfuse] span update failed:', error);
    }
  }

  /**
   * Close any span observation, trace roots included: final fields, then end —
   * v5 spans only export on end, so an un-ended root never reaches Langfuse.
   * On trace roots the output also rides the deprecated `langfuse.trace.*`
   * attributes (setTraceIO) for older servers — same rule as updateSpan.
   */
  endSpan(
    span: LangfuseSpan | null,
    update: {
      output?: unknown;
      level?: ObservationLevel;
      statusMessage?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    if (!span) return;
    try {
      span.update(update);
      if (update.output !== undefined && this.roots.has(span)) {
        span.setTraceIO({ output: update.output });
      }
      span.end();
    } catch (error) {
      console.error('[dsh-langfuse] span end failed:', error);
    }
  }

  /** Drain buffered spans (the `session/flush` checkpoint). */
  async flush(): Promise<void> {
    await this.ready;
    if (!this.provider) return;
    try {
      await this.provider.forceFlush();
    } catch (error) {
      console.error('[dsh-langfuse] flush failed:', error);
    }
  }

  /** Shut the exporter down at fiber unload (provider.shutdown flushes internally). */
  async shutdown(): Promise<void> {
    await this.ready;
    const provider = this.provider;
    const tracing = this.tracing;
    this.provider = null;
    this.tracing = null;
    if (!provider || !tracing) return;
    try {
      await provider.shutdown();
    } catch (error) {
      console.error('[dsh-langfuse] shutdown failed:', error);
    } finally {
      // Release the module-global isolated-provider slot so a reloaded fiber
      // starts clean — even when the shutdown flush failed.
      tracing.setLangfuseTracerProvider(null);
    }
  }
}
