/**
 * Langfuse reporter — thin synchronous wrapper over the `langfuse` v3 SDK's
 * stateful API (`client.trace()` / `trace.generation()` / `trace.span()`), and
 * the plugin's single no-throw seam: every method swallows SDK failures with a
 * `[dsh-langfuse]` console.error so observability can never break the agent
 * loop. The SDK batches and retries ingestion on its own; this wrapper only
 * adds dsh→Langfuse mapping and error containment.
 *
 * The `langfuse` peer is a heavy optional backend, so it loads via dynamic
 * `import()` kicked off in the constructor — a disabled plugin never pays for
 * it, and a missing or incompatible peer degrades the reporter to a no-op
 * instead of breaking the plugin load. {@link LangfuseReporter.ready} settles
 * (never rejects) once the import+construction finished: the plugin returns
 * it from `apply()` so fiber readiness covers the import window, and
 * {@link flush}/{@link shutdown} chain behind it. Observation calls landing
 * before readiness are still dropped — a window that cannot exist once the
 * plugin fiber has been awaited.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm';
import type {
  Langfuse,
  LangfuseGenerationClient,
  LangfuseSpanClient,
  LangfuseTraceClient,
} from 'langfuse';

export interface LangfuseConnectionConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export type ObservationLevel = 'DEFAULT' | 'WARNING' | 'ERROR';

/** Any observation client that can parent a span (trace, span, or generation). */
export type SpanParent = LangfuseTraceClient | LangfuseSpanClient | LangfuseGenerationClient;

/**
 * Map dsh token accounting onto Langfuse's usage fields, keeping every
 * `usageDetails` bucket mutually exclusive (Langfuse's flat-bucket rule:
 * `input` excludes `input_*`, `output` excludes `output_*`, `total` is the
 * bucket sum — overlapping buckets double-count usage and inferred cost).
 * dsh reports uncached input, separate cache buckets, and provider-style
 * output that includes reasoning, so the `output` bucket subtracts
 * `reasoningTokens` into `output_reasoning`. The legacy `usage` triple keeps
 * the provider's inclusive billed counts.
 */
export function usageOf(usage: TokenUsage): {
  usage: { input: number; output: number; total: number };
  usageDetails: Record<string, number>;
} {
  // The dsh type marks the two primary fields required, but a non-conformant
  // adapter emitting a partial usage chunk would otherwise turn every bucket
  // NaN (serialized as null by the SDK — silently corrupting billed usage).
  const input =
    (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const output = usage.outputTokens ?? 0;
  const total = input + output;
  const usageDetails: Record<string, number> = {
    input: usage.inputTokens ?? 0,
    output: Math.max(0, output - (usage.reasoningTokens ?? 0)),
    total,
  };
  if (usage.cacheReadTokens) usageDetails.input_cache_read = usage.cacheReadTokens;
  if (usage.cacheWriteTokens) usageDetails.input_cache_creation = usage.cacheWriteTokens;
  if (usage.reasoningTokens) usageDetails.output_reasoning = usage.reasoningTokens;
  return { usage: { input, output, total }, usageDetails };
}

export class LangfuseReporter {
  private client: Langfuse | null = null;
  /** Settles (never rejects) once the lazy SDK import+construction finished. */
  readonly ready: Promise<void>;

  constructor(private config: LangfuseConnectionConfig) {
    this.ready = this.init();
  }

  /** Dynamically import the SDK and construct the client. */
  private async init(): Promise<void> {
    try {
      const { Langfuse } = await import('langfuse');
      this.client = new Langfuse({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.baseUrl,
      });
    } catch (error) {
      console.error('[dsh-langfuse] client init failed:', error);
      this.client = null;
    }
  }

  /** Open a trace (one per agent turn, or one-off for session-less calls). */
  openTrace(input: {
    name: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): LangfuseTraceClient | null {
    if (!this.client) return null;
    try {
      return this.client.trace({
        name: input.name,
        sessionId: input.sessionId,
        metadata: input.metadata,
      });
    } catch (error) {
      console.error('[dsh-langfuse] trace creation failed:', error);
      return null;
    }
  }

  /**
   * Merge fields into an open trace: the input from the turn's first user
   * message, the end reason at `turn/end` (Langfuse merges metadata on update).
   */
  updateTrace(
    trace: LangfuseTraceClient | null,
    update: { input?: unknown; metadata?: Record<string, unknown> },
  ): void {
    if (!trace) return;
    try {
      trace.update({ input: update.input, metadata: update.metadata });
    } catch (error) {
      console.error('[dsh-langfuse] trace update failed:', error);
    }
  }

  /** Open a generation (one per LLM call) under any observation parent. */
  startGeneration(
    parent: SpanParent | null,
    input: {
      name: string;
      model?: string;
      input?: unknown;
      modelParameters?: Record<string, string | number | boolean | string[] | null>;
      metadata?: Record<string, unknown>;
    },
  ): LangfuseGenerationClient | null {
    if (!parent) return null;
    try {
      return parent.generation({
        name: input.name,
        model: input.model,
        input: input.input,
        modelParameters: input.modelParameters,
        metadata: input.metadata,
      });
    } catch (error) {
      console.error('[dsh-langfuse] generation creation failed:', error);
      return null;
    }
  }

  endGeneration(
    generation: LangfuseGenerationClient | null,
    update: {
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
      generation.end({
        output: update.output,
        ...(update.usage ? usageOf(update.usage) : {}),
        completionStartTime: update.completionStartTime,
        level: update.level,
        statusMessage: update.statusMessage,
        metadata: update.metadata,
      });
    } catch (error) {
      console.error('[dsh-langfuse] generation end failed:', error);
    }
  }

  /** Open a span (one per tool dispatch, or a nested detail span) under any observation parent. */
  startSpan(
    parent: SpanParent | null,
    input: { name: string; input?: unknown; metadata?: Record<string, unknown> },
  ): LangfuseSpanClient | null {
    if (!parent) return null;
    try {
      return parent.span({ name: input.name, input: input.input, metadata: input.metadata });
    } catch (error) {
      console.error('[dsh-langfuse] span creation failed:', error);
      return null;
    }
  }

  /** Merge fields into an open span (subagent enrichment: label, provider). */
  updateSpan(
    span: LangfuseSpanClient | null,
    update: { name?: string; input?: unknown; metadata?: Record<string, unknown> },
  ): void {
    if (!span) return;
    try {
      span.update({ name: update.name, input: update.input, metadata: update.metadata });
    } catch (error) {
      console.error('[dsh-langfuse] span update failed:', error);
    }
  }

  endSpan(
    span: LangfuseSpanClient | null,
    update: {
      output?: unknown;
      level?: ObservationLevel;
      statusMessage?: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    if (!span) return;
    try {
      span.end({
        output: update.output,
        level: update.level,
        statusMessage: update.statusMessage,
        metadata: update.metadata,
      });
    } catch (error) {
      console.error('[dsh-langfuse] span end failed:', error);
    }
  }

  /** Drain buffered ingestion events (the `session/flush` checkpoint). */
  async flush(): Promise<void> {
    await this.ready;
    if (!this.client) return;
    try {
      await this.client.flushAsync();
    } catch (error) {
      console.error('[dsh-langfuse] flush failed:', error);
    }
  }

  /** Flush and shut the SDK down at fiber unload. */
  async shutdown(): Promise<void> {
    await this.ready;
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.flushAsync();
    } catch (error) {
      console.error('[dsh-langfuse] flush failed:', error);
    }
    try {
      await client.shutdownAsync();
    } catch (error) {
      console.error('[dsh-langfuse] shutdown failed:', error);
    }
  }
}
