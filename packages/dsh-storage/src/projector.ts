/**
 * Projects dsh session events onto MessageRow / SessionRow.
 *
 * Event shapes verified against the dsh persistence catalog
 * (https://deepseek-harness.github.io/deepseek-harness/reference/persistence-catalog)
 * and the @deepseek-ai/dsh-llm message types:
 * - envelope: `{ type, seq, time, data }` — payload lives under `data`.
 * - `user/message` and `assistant/message` produce rows; `tool/result` updates
 *   the matching assistant row's toolCalls instead of producing a tool row.
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

/** Reasoning blocks of an assistant message, in their original order. */
function thoughtsOf(message: any): Array<{ content: string }> | undefined {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const replay = message?.source?.replayState?.blocks;
  const thoughts = blocks
    .map((b: any, index: number) => {
      if (b?.type !== 'reasoning' || !b.text) return null;
      const metadata = Array.isArray(replay) ? replay[index] : undefined;
      const signature =
        metadata?.type === 'reasoning'
          ? (metadata.signature ?? metadata.thoughtSignature)
          : undefined;
      return {
        content: b.text,
        ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
      };
    })
    .filter((thought: any) => thought !== null);
  return thoughts.length ? thoughts : undefined;
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
        metadata: { event: event.type, seq: event.seq, message },
      };
    }

    case 'assistant/message': {
      const message = data.message;
      return {
        ...base,
        id: message?.id ?? randomUUID(),
        type: 'model',
        content: textOf(message),
        thoughts: thoughtsOf(message),
        model: message?.source?.model ?? undefined,
        tokens: data.usage ?? undefined,
        toolCalls: toolPartsOf(message),
        metadata: {
          event: event.type,
          seq: event.seq,
          ...(message?.source ? { source: message.source } : {}),
          ...(data.interrupted ? { interrupted: true } : {}),
        },
      };
    }

    default:
      // Log-only events (assistant/attempt, turn/step lifecycle, approvals,
      // compaction markers, ...) are not standalone rows; usage rolls up into
      // SessionRow via usageSampleOf (assistant/message and assistant/attempt).
      return null;
  }
}

/** Identify the assistant tool call answered by either supported result shape. */
export function toolResultCallId(event: any): string | undefined {
  const message = event?.data?.message;
  const first = message?.content?.[0];
  const callId =
    message?.toolCallId ??
    message?.source?.callId ??
    (first?.type === 'tool-result' ? first.toolCallId : undefined);
  return typeof callId === 'string' ? callId : undefined;
}

/** Update the persisted assistant call identified by a tool result. */
export function mergeToolResult(event: any, rows: MessageRow[]): MessageRow | null {
  const message = event?.data?.message;
  const content = Array.isArray(message?.content) ? message.content : [];
  const legacy =
    content.length === 1 && content[0]?.type === 'tool-result' ? content[0] : undefined;
  const callId = toolResultCallId(event);
  if (!callId) return null;
  const result =
    legacy ??
    (message
      ? {
          type: 'tool-result',
          toolCallId: callId,
          content,
          ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
        }
      : null);
  const model = [...rows]
    .reverse()
    .find(
      (row) =>
        row.type === 'model' &&
        Array.isArray(row.toolCalls) &&
        row.toolCalls.some((call: any) => call?.id === callId),
    );
  if (!model) return null;
  return {
    ...model,
    toolCalls: (model.toolCalls as any[]).map((call) =>
      call?.id === callId
        ? {
            ...call,
            result,
            error: event.data.error
              ? { name: event.data.error.name, code: event.data.error.code }
              : undefined,
          }
        : call,
    ),
  };
}

export interface UsageSample {
  input: number;
  output: number;
}

/**
 * Extract one model call's usage, keyed by its durable event sequence.
 *
 * V3 session log (dsh-session@0.1.6-alpha.2):
 * - `assistant/message.data.usage` — the settled call's accounting;
 * - `assistant/attempt` — a failed/retried/cancelled call commits no surface
 *   message; the adapter's usage chunk survives as a raw `chunk` record in the
 *   embedded compact `stream` (deltas are packed, but usage is a raw type).
 *
 * Calls on one `(turn, step)` are additive: a retry is another billed model
 * call, not a progressive snapshot. Only redelivery of the same event sequence
 * is a duplicate. Totals include the cache buckets: cacheRead/cacheWrite are
 * billed in their own buckets (observed cacheReadTokens ≫ inputTokens in dsh
 * session logs — they are not subsets of inputTokens).
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
  if (!usage || !Number.isSafeInteger(event?.seq)) return null;
  return { key: String(event.seq), sample: total(usage) };
}
