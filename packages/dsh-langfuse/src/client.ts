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
  redactFields?: string[];
  environment?: string;
  release?: string;
  userId?: string;
  tags?: string[];
  captureContent?: boolean;
  captureMedia?: boolean;
}

export type ObservationLevel = 'DEFAULT' | 'WARNING' | 'ERROR';

/** Standard request context supplied by a host for one session's next trace. */
export interface LangfuseTraceContext {
  userId?: string;
  tags?: string[];
  traceparent?: string;
}

/** Any observation that can parent a span (trace root span or nested span/generation). */
type Observation = LangfuseSpan | LangfuseGeneration;

/** The trace-correlating attributes stamped on every observation of a trace. */
interface TraceContext {
  sessionId?: string;
  traceName?: string;
  userId?: string;
  tags?: string[];
}

/**
 * OTEL's canonical invalid span context as a literal (a static
 * `INVALID_SPAN_CONTEXT` import would load @opentelemetry/api eagerly, even
 * for a disabled plugin): the SDK starts a fresh traceId for an invalid
 * parent instead of adopting the ambient context's active span.
 */
const NO_PARENT = { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 };

function parentContext(traceparent: string | undefined) {
  if (traceparent === undefined) return NO_PARENT;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) {
    console.error('[dsh-langfuse] invalid traceparent; starting an independent trace');
    return NO_PARENT;
  }
  return {
    traceId: match[1],
    spanId: match[2],
    traceFlags: Number.parseInt(match[3], 16) & 1,
    isRemote: true,
  };
}

/**
 * Map dsh token accounting onto Langfuse's `usageDetails`, keeping every
 * bucket mutually exclusive (Langfuse's flat-bucket rule: `input` excludes
 * `input_*`, `output` excludes `output_*`, `total` is the bucket sum —
 * overlapping buckets double-count usage and inferred cost). dsh reports
 * uncached input, separate cache buckets, and provider-style output that
 * INCLUDES reasoning (verified in dsh-llm-deepseek@0.1.6-alpha.2:
 * `outputTokens: usage.completion_tokens`, with reasoning split out of
 * `completion_tokens_details`), so the `output` bucket subtracts
 * `reasoningTokens` into `output_reasoning_tokens`. Only `usageDetails` is sent.
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
  if (usage.cacheReadTokens) usageDetails.cache_read_input_tokens = usage.cacheReadTokens;
  if (usage.cacheWriteTokens) usageDetails.cache_creation_input_tokens = usage.cacheWriteTokens;
  if (reasoning) usageDetails.output_reasoning_tokens = reasoning;
  return usageDetails;
}

export class LangfuseReporter {
  private tracing: typeof import('@langfuse/tracing') | null = null;
  private api: typeof import('@opentelemetry/api') | null = null;
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

  /** Clone telemetry only; never mutate harness-owned messages or tool results. */
  mask<T>(data: T): T {
    const secrets = [this.config.publicKey, this.config.secretKey].filter(Boolean);
    const fields = new Set(this.config.redactFields?.map((key) => key.toLowerCase()));
    const seen = new WeakSet<object>();
    const redactText = (text: string): string => {
      const ranges: Array<[number, number]> = Array.from(
        text.matchAll(/(?:pk|sk)-lf-[\w-]+/g),
        (match) => [match.index, match.index + match[0].length],
      );
      for (const secret of secrets) {
        for (
          let index = text.indexOf(secret);
          index !== -1;
          index = text.indexOf(secret, index + 1)
        ) {
          ranges.push([index, index + secret.length]);
        }
      }
      let output = '';
      let end = 0;
      // Match the original text once, merging overlap before changing any bytes.
      for (const [start, stop] of ranges.sort((a, b) => a[0] - b[0])) {
        if (start >= end) output += `${text.slice(end, start)}[REDACTED]`;
        end = Math.max(end, stop);
      }
      return output + text.slice(end);
    };
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') {
        // Tool-call arguments and SDK attributes may themselves be JSON text.
        if (fields.size && /^\s*[[{]/.test(value)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value);
          } catch {
            /* not JSON */
          }
          if (parsed !== undefined) {
            const masked = JSON.stringify(redact(parsed));
            if (masked !== JSON.stringify(parsed)) return masked;
          }
        }
        return redactText(value);
      }
      if (!value || typeof value !== 'object' || value instanceof Date) return value;
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      const result = Array.isArray(value)
        ? value.map(redact)
        : Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              redact(key),
              fields.has(key.toLowerCase()) ? '[REDACTED]' : redact(child),
            ]),
          );
      seen.delete(value);
      return result;
    };
    try {
      return redact(data) as T;
    } catch (error) {
      console.error('[dsh-langfuse] redaction failed:', error);
      return '[REDACTED]' as T;
    }
  }

  /** Dynamically import the SDK and wire the isolated export pipeline. */
  private async init(): Promise<void> {
    try {
      const [tracing, otel, sdkNode, api] = await Promise.all([
        import('@langfuse/tracing'),
        import('@langfuse/otel'),
        import('@opentelemetry/sdk-trace-node'),
        import('@opentelemetry/api'),
      ]);
      const environment =
        this.config.environment || process.env.LANGFUSE_TRACING_ENVIRONMENT || undefined;
      const maskedEnvironment = this.mask(environment);
      const processor = new otel.LangfuseSpanProcessor({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.baseUrl,
        environment: maskedEnvironment === environment ? environment : 'redacted',
        release: this.mask(this.config.release || process.env.LANGFUSE_RELEASE || undefined),
        mediaUploadEnabled:
          !!this.config.captureMedia &&
          this.config.captureContent !== false &&
          !/^(false|0)$/i.test(process.env.LANGFUSE_MEDIA_UPLOAD_ENABLED ?? ''),
        mask: ({ data }) => {
          // OTEL attributes arrive as serialized JSON; configured field names
          // still need structural redaction at the final exporter boundary.
          if (typeof data === 'string') {
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              /* plain text */
            }
            if (parsed !== undefined) return JSON.stringify(this.mask(parsed));
          }
          return this.mask(data);
        },
      });
      this.provider = new sdkNode.NodeTracerProvider({ spanProcessors: [processor] });
      // Isolated provider, not provider.register(): the process-global OTEL
      // provider stays untouched. Set `tracing` last — observation methods
      // gate on it, and it must never be visible before the provider is wired.
      tracing.setLangfuseTracerProvider(this.provider);
      this.api = api;
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
    if (context.traceName)
      observation.otelSpan.setAttribute('langfuse.trace.name', this.mask(context.traceName));
    if (context.sessionId)
      observation.otelSpan.setAttribute('session.id', this.mask(context.sessionId));
    if (context.userId) observation.otelSpan.setAttribute('user.id', this.mask(context.userId));
    if (context.tags?.length)
      observation.otelSpan.setAttribute('langfuse.trace.tags', this.mask(context.tags));
    this.traceContext.set(observation, context);
  }

  /** Open a trace (one per agent turn, or one-off for session-less calls). */
  openTrace(input: {
    name: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    context?: LangfuseTraceContext;
  }): LangfuseSpan | null {
    const tracing = this.tracing;
    const api = this.api;
    if (!tracing || !api) return null;
    try {
      const parent = parentContext(input.context?.traceparent);
      input = this.mask(input);
      const root = api.context.with(api.ROOT_CONTEXT, () =>
        tracing.startObservation(
          input.name,
          { metadata: input.metadata },
          { parentSpanContext: parent },
        ),
      );
      this.stampTraceContext(root, {
        sessionId: input.sessionId,
        traceName: parent === NO_PARENT ? input.name : undefined,
        userId: input.context?.userId ?? this.config.userId,
        tags: input.context?.tags ?? this.config.tags,
      });
      // External traces retain their owner's trace name and trace-level IO.
      if (parent === NO_PARENT) this.roots.add(root);
      else root.otelSpan.setAttribute(tracing.LangfuseOtelSpanAttributes.IS_APP_ROOT, false);
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
    const api = this.api;
    if (!parent || !api) return null;
    try {
      input = this.mask(input);
      const generation = api.context.with(api.ROOT_CONTEXT, () =>
        parent.startObservation(
          input.name,
          {
            model: input.model,
            input: input.input,
            modelParameters: input.modelParameters,
            metadata: input.metadata,
          },
          { asType: 'generation' },
        ),
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
      update = this.mask(update);
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
    input: { name: string; input?: unknown; metadata?: Record<string, unknown>; asType?: 'tool' },
  ): LangfuseSpan | null {
    const api = this.api;
    if (!parent || !api) return null;
    try {
      input = this.mask(input);
      const attributes = {
        input: input.input,
        metadata: input.metadata,
      };
      const span = api.context.with(api.ROOT_CONTEXT, () =>
        input.asType === 'tool'
          ? parent.startObservation(input.name, attributes, { asType: 'tool' })
          : parent.startObservation(input.name, attributes),
      );
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
    span: Observation | null,
    update: { name?: string; input?: unknown; metadata?: Record<string, unknown> },
  ): void {
    if (!span) return;
    try {
      update = this.mask(update);
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
      update = this.mask(update);
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
    this.api = null;
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
