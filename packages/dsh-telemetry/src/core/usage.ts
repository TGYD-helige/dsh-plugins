import type { TokenUsage } from '@deepseek-ai/dsh-llm';
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
