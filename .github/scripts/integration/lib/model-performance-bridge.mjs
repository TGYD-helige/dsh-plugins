/** CI-only observer: one small numeric record per existing model stream, never its content. */
import { appendFileSync } from 'node:fs';
import { isTokenDelta } from '@deepseek-ai/dsh-llm/assistant-stream';

export const name = 'ci-model-performance';
export const inject = [];
const count = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const finishes = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);

export function apply(ctx) {
  const output = process.env.DSH_MODEL_PERFORMANCE_OUTPUT;
  if (!output) return;
  let call = 0;
  ctx.on('llm/stream', (options, next) => {
    const id = ++call;
    const started = performance.now();
    let firstToken;
    let chunks = 0;
    let usage = {};
    let outcome = 'consumer-closed';
    let finished = false;
    const record = () => {
      const ended = performance.now();
      const input = count(usage.inputTokens);
      const cacheRead = count(usage.cacheReadTokens);
      const cacheWrite = count(usage.cacheWriteTokens);
      const outputTokens = count(usage.outputTokens);
      const decodeMs = firstToken === undefined ? null : ended - firstToken;
      try {
        appendFileSync(
          output,
          `${JSON.stringify({
            pid: process.pid,
            call: id,
            provider: options.provider,
            model: options.model,
            purpose: options.purpose ?? 'main',
            outcome,
            durationMs: ended - started,
            firstTokenMs: firstToken === undefined ? null : firstToken - started,
            decodeMs,
            outputTokensPerSecond:
              outputTokens !== null && decodeMs > 0 ? (outputTokens * 1000) / decodeMs : null,
            chunks,
            uncachedInputTokens: input,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            totalInputTokens: input === null ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0),
            outputTokens,
            reasoningTokens: count(usage.reasoningTokens),
          })}\n`,
        );
      } catch {
        console.error('[ci-model-performance] metrics write failed');
      }
    };
    let source;
    try {
      source = next();
    } catch (error) {
      outcome = options.signal?.aborted ? 'aborted' : 'error';
      record();
      throw error;
    }
    return (async function* () {
      try {
        for await (const chunk of source) {
          chunks++;
          if (firstToken === undefined && isTokenDelta(chunk)) firstToken = performance.now();
          if (chunk.type === 'usage') usage = chunk.usage ?? {};
          if (chunk.type === 'finish') {
            finished = true;
            outcome = finishes.has(chunk.reason?.kind) ? chunk.reason.kind : 'unknown-finish';
          }
          yield chunk;
        }
        if (!finished) outcome = options.signal?.aborted ? 'aborted' : 'incomplete';
      } catch (error) {
        outcome = options.signal?.aborted ? 'aborted' : 'error';
        throw error;
      } finally {
        if (!finished && options.signal?.aborted) outcome = 'aborted';
        record();
      }
    })();
  });
}
