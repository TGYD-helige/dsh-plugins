/**
 * dsh-langfuse — Langfuse observability for DeepSeek Harness.
 *
 * Instruments three documented seams, with zero core patches:
 *
 * - `llm/stream` waterfall  → one Langfuse **generation** per LLM call
 *   (input = full request, output + token usage from the chunk stream).
 * - `tools/execute` waterfall → one Langfuse **span** per tool dispatch.
 * - `session/event` emit    → one Langfuse **trace** per agent turn
 *   (`turn/start` opens, `turn/end` closes).
 *
 * @module dsh-langfuse
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LangfuseReporter } from './client.js'

export const name = 'dsh-langfuse'

/**
 * Waterfall listeners only need the events to exist; no hard service
 * dependency is declared so the plugin still loads in minimal compositions
 * (it simply never observes anything). Add 'llm' / 'tools' to `inject` if you
 * prefer fail-fast wiring.
 */
export const inject = [] as string[]

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('master switch'),
  publicKey: Schema.string().default('').description('Langfuse public key'),
  secretKey: Schema.string().role('secret').default('').description('Langfuse secret key'),
  baseUrl: Schema.string().default('https://cloud.langfuse.com'),
  traceName: Schema.string().default('dsh-turn'),
  /** Include full message/tool payloads in Langfuse IO. Disable to log metadata only. */
  captureContent: Schema.boolean().default(true),
})

export interface LangfusePluginConfig {
  enabled: boolean
  publicKey: string
  secretKey: string
  baseUrl: string
  traceName: string
  captureContent: boolean
}

/** Per-turn trace handles, keyed by `${sessionId}:${turnId}`. */
const traces = new Map<string, unknown>()

function traceKey(sessionId: string, turnId: string | undefined): string {
  return `${sessionId}:${turnId ?? 'current'}`
}

export function apply(ctx: Context, config: LangfusePluginConfig): void {
  if (!config.enabled || !config.publicKey || !config.secretKey) return

  const reporter = new LangfuseReporter(config)

  // ------------------------------------------------------------------
  // Trace lifecycle: one trace per turn.
  // TODO(verify): confirm the exact `turn/start` / `turn/end` payload field
  // names (`turn.id`, `turn.kind`, `reason.kind`) against the dsh version you
  // pin — the session event map is pre-release and may shift.
  // ------------------------------------------------------------------
  ctx.on('session/event', (session: any, event: any) => {
    const sessionId: string = session?.id ?? event?.session ?? 'unknown'
    if (event?.type === 'turn/start') {
      const key = traceKey(sessionId, event.turn?.id)
      void reporter
        .startTrace({
          traceId: key,
          name: config.traceName,
          sessionId,
          metadata: { turnId: event.turn?.id },
        })
        .then((trace) => traces.set(key, trace))
    } else if (event?.type === 'turn/end') {
      const key = traceKey(sessionId, event.turn?.id)
      const trace = traces.get(key)
      if (trace) {
        void (trace as any)?.update?.({
          metadata: { endReason: event.reason?.kind },
        })
        traces.delete(key)
      }
    }
  })

  // ------------------------------------------------------------------
  // Generation per LLM call.
  // Waterfall signature per docs/subsystems/llm-streaming.md:
  //   (this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)
  // TODO(verify): how to reach session/turn identity from `options` /
  // `this` (agent-loop requests carry `markAgentLoopRequest` identity).
  // ------------------------------------------------------------------
  ctx.on('llm/stream', async function (this: unknown, options: any, next: any) {
    const model: string | undefined = options?.model
    const generation = await reporter.generation(undefined /* trace-less until turn wiring is verified */, {
      name: 'llm-call',
      model,
      input: config.captureContent
        ? { messages: options?.messages, system: options?.system, tools: options?.tools }
        : { messageCount: options?.messages?.length },
      metadata: { purpose: options?.purpose },
    })

    let stream: AsyncIterable<any>
    try {
      stream = await next()
    } catch (error) {
      reporter.endGeneration(generation, {
        level: 'ERROR',
        statusMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    // Tee the chunk stream: capture text + the guaranteed `usage` chunk.
    return (async function* () {
      let text = ''
      let usage: unknown
      try {
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += chunk.text ?? ''
          if (chunk?.type === 'usage') usage = chunk.usage
          yield chunk
        }
        reporter.endGeneration(generation, {
          output: config.captureContent ? text : undefined,
          usage: usage as never,
        })
      } catch (error) {
        reporter.endGeneration(generation, {
          level: 'ERROR',
          statusMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })()
  })

  // ------------------------------------------------------------------
  // Span per tool dispatch.
  // Waterfall per docs/tool-execution-pipeline.md:
  //   (exec: { name, arguments, agent, signal }, next)
  // ------------------------------------------------------------------
  ctx.on('tools/execute', async (exec: any, next: any) => {
    const span = await reporter.span(undefined /* trace-less; see TODO above */, {
      name: `tool:${exec?.name ?? 'unknown'}`,
      input: config.captureContent ? exec?.arguments : undefined,
    })
    try {
      const result = await next()
      reporter.endSpan(span, { output: config.captureContent ? result : undefined })
      return result
    } catch (error) {
      reporter.endSpan(span, {
        level: 'ERROR',
        statusMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })

  ctx.on('dispose', () => {
    traces.clear()
    return reporter.shutdown()
  })
}
