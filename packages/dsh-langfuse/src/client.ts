/**
 * Lazy Langfuse client wrapper.
 *
 * All public methods are no-throw: observability must never break the agent
 * loop. The underlying `langfuse` package is a peer dependency so deployments
 * that disable the plugin do not pay for it.
 */

export interface LangfuseConnectionConfig {
  publicKey: string
  secretKey: string
  baseUrl: string
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

// The langfuse v3 SDK surface we use. Declared structurally to keep this file
// compilable before dependencies are installed; the real types come from the
// `langfuse` peer dependency.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type LangfuseClientLike = any
export type TraceLike = any
export type GenerationLike = any
export type SpanLike = any

export class LangfuseReporter {
  private clientPromise: Promise<LangfuseClientLike> | null = null

  constructor(private config: LangfuseConnectionConfig) {}

  private async client(): Promise<LangfuseClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = import('langfuse').then(
        (mod) =>
          new (mod as any).Langfuse({
            publicKey: this.config.publicKey,
            secretKey: this.config.secretKey,
            baseUrl: this.config.baseUrl,
          }),
      )
    }
    return this.clientPromise
  }

  /** Open (or fetch) the trace for one agent turn. */
  async startTrace(input: {
    traceId: string
    name: string
    sessionId: string
    userId?: string
    metadata?: Record<string, unknown>
  }): Promise<TraceLike> {
    try {
      const client = await this.client()
      return client.trace({
        id: input.traceId,
        name: input.name,
        sessionId: input.sessionId,
        userId: input.userId,
        metadata: input.metadata,
      })
    } catch {
      return null
    }
  }

  /** Record one LLM call as a Langfuse generation under `trace`. */
  async generation(
    trace: TraceLike,
    input: {
      name: string
      model?: string
      input: unknown
      metadata?: Record<string, unknown>
    },
  ): Promise<GenerationLike> {
    if (!trace) return null
    try {
      return trace.generation({
        name: input.name,
        model: input.model,
        input: input.input,
        metadata: input.metadata,
      })
    } catch {
      return null
    }
  }

  endGeneration(
    generation: GenerationLike,
    output: { output?: unknown; usage?: TokenUsage; level?: 'DEFAULT' | 'ERROR'; statusMessage?: string },
  ): void {
    if (!generation) return
    try {
      generation.end({
        output: output.output,
        usage: output.usage
          ? {
              input: output.usage.inputTokens,
              output: output.usage.outputTokens,
              total:
                (output.usage.inputTokens ?? 0) + (output.usage.outputTokens ?? 0),
            }
          : undefined,
        level: output.level ?? 'DEFAULT',
        statusMessage: output.statusMessage,
      })
    } catch {
      /* observability must not throw */
    }
  }

  /** Record one tool call as a span under `trace`. */
  async span(
    trace: TraceLike,
    input: { name: string; input: unknown; metadata?: Record<string, unknown> },
  ): Promise<SpanLike> {
    if (!trace) return null
    try {
      return trace.span({ name: input.name, input: input.input, metadata: input.metadata })
    } catch {
      return null
    }
  }

  endSpan(
    span: SpanLike,
    output: { output?: unknown; level?: 'DEFAULT' | 'ERROR'; statusMessage?: string },
  ): void {
    if (!span) return
    try {
      span.end({
        output: output.output,
        level: output.level ?? 'DEFAULT',
        statusMessage: output.statusMessage,
      })
    } catch {
      /* observability must not throw */
    }
  }

  async shutdown(): Promise<void> {
    try {
      const client = await this.clientPromise
      await client?.flushAsync?.()
      await client?.shutdownAsync?.()
    } catch {
      /* ignore */
    }
  }
}
