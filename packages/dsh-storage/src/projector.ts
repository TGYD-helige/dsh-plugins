/**
 * Projects dsh session events onto MessageRow / SessionRow.
 *
 * The dsh session log is the single source of truth; this module turns the
 * live `session/event` stream into the relational shape that downstream
 * consumers (message lists, history views) expect.
 *
 * TODO(verify): event payload field names against your pinned dsh version —
 * the SessionEventMap is pre-release. Relevant docs: docs/subsystems/session.md
 * and the generated docs/persistence-catalog.md in the dsh repo.
 */

import { randomUUID } from 'node:crypto'
import type { MessageRow } from './types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ProjectContext {
  sessionId: string
  userId: string
  agentId?: string | null
}

function textOf(message: any): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  const parts = Array.isArray(message.content) ? message.content : (message.parts ?? [])
  return parts
    .filter((p: any) => p?.type === 'text' || typeof p?.text === 'string')
    .map((p: any) => p.text)
    .join('')
}

function toolPartsOf(message: any): unknown[] | undefined {
  if (!message) return undefined
  const parts = Array.isArray(message.content) ? message.content : (message.parts ?? [])
  const calls = parts.filter((p: any) => p?.type === 'tool-call' || p?.type === 'tool-result')
  return calls.length > 0 ? calls : undefined
}

/**
 * Map one session event to zero or one message row. Returns null for events
 * that should not be persisted as standalone rows (deltas, lifecycle markers).
 */
export function projectEvent(session: any, event: any, ctx: ProjectContext): MessageRow | null {
  const base = {
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    historyId: null,
    agentId: ctx.agentId ?? 'main',
    createdAt: new Date(event?.timestamp ?? Date.now()),
  }

  switch (event?.type) {
    case 'user/message':
      return {
        ...base,
        id: event.message?.id ?? randomUUID(),
        type: 'user',
        content: textOf(event.message),
        metadata: { event: event.type },
      }

    case 'assistant/message':
      return {
        ...base,
        id: event.message?.id ?? randomUUID(),
        type: 'model',
        content: textOf(event.message),
        thoughts: undefined, // populated when reasoning blocks land in committed messages
        model: event.message?.model ?? undefined,
        tokens: event.usage ?? undefined,
        toolCalls: toolPartsOf(event.message),
        metadata: { event: event.type },
      }

    case 'tool/result':
      return {
        ...base,
        id: event.message?.id ?? randomUUID(),
        type: 'tool',
        content: textOf(event.message),
        toolCalls: [
          {
            callId: event.callId,
            result: event.error ? { error: String(event.error) } : event.message,
          },
        ],
        metadata: { event: event.type, callId: event.callId },
      }

    default:
      // assistant/chunk (deltas), turn/step lifecycle, approval events, ...
      // are not standalone rows; turn/end usage rolls up into SessionRow.
      return null
  }
}

/** Extract token usage from a `turn/end` or `assistant/message` event. */
export function usageOf(event: any): { input: number; output: number } {
  const u = event?.usage ?? event?.message?.usage
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
  }
}
