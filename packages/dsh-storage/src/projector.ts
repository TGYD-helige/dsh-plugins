/**
 * Projects dsh session events onto MessageRow / SessionRow.
 *
 * Event shapes verified against the dsh persistence catalog
 * (https://deepseek-harness.github.io/deepseek-harness/reference/persistence-catalog)
 * and the @deepseek-ai/dsh-llm message types:
 * - envelope: `{ type, seq, time, data }` — payload lives under `data`.
 * - surface events (the only ones producing LLM messages, and the only ones
 *   projected to rows): `user/message`, `assistant/message`, `tool/result`.
 * - token usage (V3 log): `assistant/message.data.usage` is the settled
 *   step's accounting; a failed/cancelled attempt commits `assistant/attempt`
 *   instead, with the adapter's usage chunk preserved as a raw record in its
 *   embedded compact stream (recovered in usageSampleOf). `turn/end` carries
 *   none — it only serves as a rollup checkpoint.
 * - compaction summaries enter the surface as a `user/message` with
 *   `surfaceOp: replace`, so they flow through the user path unchanged.
 */

import { randomUUID } from 'node:crypto';
import type { MessageRow } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Visible text of a message: its `text` blocks, unwrapping tool-result blocks. */
function textOf(message: any): string {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .map((b: any) => {
      if (b?.type === 'text') return b.text ?? '';
      if (b?.type === 'tool-result' && Array.isArray(b.content))
        return textOf({ content: b.content });
      return '';
    })
    .join('');
}

/** Reasoning text of an assistant message, if it carried reasoning blocks. */
function reasoningOf(message: any): string | undefined {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((b: any) => b?.type === 'reasoning')
    .map((b: any) => b.text)
    .join('');
  return text || undefined;
}

function toolPartsOf(message: any): unknown[] | undefined {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const calls = blocks.filter((b: any) => b?.type === 'tool-call');
  return calls.length > 0 ? calls : undefined;
}

/**
 * Map one session event to zero or one message row. Returns null for events
 * that should not be persisted as standalone rows (log-only events: chunks,
 * turn/step lifecycle, approvals, ...).
 */
export function projectEvent(_session: any, event: any, sessionId: string): MessageRow | null {
  const data = event?.data ?? {};
  const base = {
    sessionId,
    historyId: null,
    agentId: 'main',
    createdAt: new Date(event?.time ?? Date.now()),
  };

  switch (event?.type) {
    case 'user/message': {
      // data IS the UserMessage.
      const message = data;
      return {
        ...base,
        id: message.id ?? randomUUID(),
        type: 'user',
        content: textOf(message),
        metadata: { event: event.type, seq: event.seq },
      };
    }

    case 'assistant/message': {
      const message = data.message;
      return {
        ...base,
        id: message?.id ?? randomUUID(),
        type: 'model',
        content: textOf(message),
        thoughts: reasoningOf(message),
        model: message?.source?.model ?? undefined,
        tokens: data.usage ?? undefined,
        toolCalls: toolPartsOf(message),
        metadata: {
          event: event.type,
          seq: event.seq,
          ...(data.interrupted ? { interrupted: true } : {}),
        },
      };
    }

    case 'tool/result': {
      const message = data.message;
      const callId = message?.source?.callId ?? undefined;
      return {
        ...base,
        id: message?.id ?? randomUUID(),
        type: 'tool',
        content: textOf(message),
        toolCalls: [
          {
            callId,
            result: message?.content?.[0] ?? null,
            // Internal failure identity, when the call failed.
            ...(data.error ? { error: { name: data.error.name, code: data.error.code } } : {}),
          },
        ],
        metadata: { event: event.type, seq: event.seq, callId },
      };
    }

    default:
      // Log-only events (assistant/attempt, turn/step lifecycle, approvals,
      // compaction markers, ...) are not standalone rows; usage rolls up into
      // SessionRow via usageSampleOf (assistant/message and assistant/attempt).
      return null;
  }
}

export interface UsageSample {
  input: number;
  output: number;
}

/**
 * Extract the usage sample carried by one event, keyed by its step, or null
 * when the event carries none.
 *
 * V3 session log (dsh-session@0.1.6-alpha.2):
 * - `assistant/message.data.usage` — the settled step's final accounting;
 * - `assistant/attempt` — a failed/retried/cancelled step commits no surface
 *   message; the adapter's usage chunk survives as a raw `chunk` record in the
 *   embedded compact `stream` (deltas are packed, but usage is a raw type).
 *
 * Samples for one `(turn, step)` are REPLACEMENTS, not additive: later
 * samples supersede earlier ones (a failed attempt's usage, then the settled
 * message's). The caller keeps the latest sample per step and folds only the
 * delta into its rollup. Totals include the cache buckets: cacheRead/cacheWrite
 * are billed in their own buckets (observed cacheReadTokens ≫ inputTokens in
 * dsh session logs — they are not subsets of inputTokens).
 */
export function usageSampleOf(event: any): { key: string; sample: UsageSample } | null {
  const total = (u: any): UsageSample => ({
    input: (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0),
    output: u?.outputTokens ?? 0,
  });

  let data: any;
  let usage: any;
  if (event?.type === 'assistant/message') {
    data = event.data;
    usage = data?.usage;
  } else if (event?.type === 'assistant/attempt') {
    data = event.data;
    usage = (Array.isArray(data?.stream) ? data.stream : []).find(
      (r: any) => r?.type === 'chunk' && r.chunk?.type === 'usage',
    )?.chunk?.usage;
  } else {
    return null;
  }
  if (!usage || data?.turn == null || data?.step == null) return null;
  return { key: `${data.turn}:${data.step}`, sample: total(usage) };
}
