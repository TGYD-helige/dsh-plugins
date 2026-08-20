/**
 * Projects dsh session events onto MessageRow / SessionRow.
 *
 * Event shapes verified against the dsh persistence catalog
 * (https://deepseek-harness.github.io/deepseek-harness/reference/persistence-catalog)
 * and the @deepseek-ai/dsh-llm message types:
 * - envelope: `{ type, seq, time, data }` — payload lives under `data`.
 * - surface events (the only ones producing LLM messages, and the only ones
 *   projected to rows): `user/message`, `assistant/message`, `tool/result`.
 * - token usage rides on `assistant/message`'s `data.usage`; `turn/end`
 *   carries none — it only serves as a rollup checkpoint.
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
      // Log-only events (assistant/chunk, turn/step lifecycle, approvals,
      // compaction markers, ...) are not standalone rows; assistant/message
      // usage rolls up into SessionRow.
      return null;
  }
}

/**
 * Extract token usage — only `assistant/message` carries it (`data.usage`).
 * The catalog states there is no separate usage record: the usage chunks in
 * the raw stream are the same accounting in flight, so counting them too
 * would double-count. Accepted edge: a request that fails before producing
 * an assistant/message contributes nothing to the rollup.
 */
export function usageOf(event: any): { input: number; output: number } {
  if (event?.type !== 'assistant/message') return { input: 0, output: 0 };
  const u = event.data?.usage;
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
  };
}
