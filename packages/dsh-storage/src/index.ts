/**
 * dsh-storage — mirrors the dsh session event stream into the ai_messages /
 * ai_chat_histories tables (MySQL/PostgreSQL).
 *
 * Design: dsh's own session persistence (JSONL/SQLite) stays authoritative.
 * This plugin taps `session/event` (the same seam the built-in persistence
 * coordinator uses) and projects events into MessageRow / SessionRow shaped
 * after the source project's ai_messages / ai_chat_histories tables.
 *
 * A2A task state (task metadata in Redis, workspace archives in GCS) is NOT
 * here — that belongs to the A2A layer, see dsh-a2a's TaskStore backends.
 *
 * Resume caveat (docs/subsystems/persistence.md): constructor seeds do not
 * emit events. On agent resume, only events >= `session.firstLiveSeq` fire
 * on this stream — historical rows must come from the database itself, not
 * from replaying the tap.
 *
 * @module dsh-storage
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { projectEvent, usageOf } from './projector.js'
import type { MessageRow, SessionRow, StorageBackend } from './types.js'
import { DatabaseBackend } from './backends/database.js'

export const name = 'dsh-storage'

// Event-tap only: no hard service dependency. Add 'sessionPersistence' to
// `inject` if you want fail-fast when persistence is not composed.
export const inject = [] as string[]

export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  database: Schema.object({
    enabled: Schema.boolean().default(false),
    url: Schema.string().role('secret').default(''),
  }),
})

export interface StoragePluginConfig {
  enabled: boolean
  database: { enabled: boolean; url: string }
}

/** Per-session live rollup used to maintain the session row. */
interface SessionAccum {
  messageCount: number
  totalTokens: number
  firstMessageAt?: Date
  lastMessageAt?: Date
}

export function apply(ctx: Context, config: StoragePluginConfig): void {
  if (!config.enabled || !config.database.enabled || !config.database.url) return

  const backends: StorageBackend[] = [new DatabaseBackend({ url: config.database.url })]

  const sessions = new Map<string, SessionAccum>()

  async function fanout(call: (backend: StorageBackend) => Promise<void>): Promise<void> {
    // Mirroring must never break the agent loop: log and swallow.
    await Promise.all(
      backends.map((backend) =>
        call(backend).catch((error) => console.error(`[dsh-storage] ${backend.name} error:`, error)),
      ),
    )
  }

  ctx.on('ready', async () => {
    await fanout(async (backend) => backend.init?.())
  })

  /* eslint-disable @typescript-eslint/no-explicit-any */
  ctx.on('session/event', (session: any, event: any) => {
    const sessionId: string = session?.id ?? 'unknown'
    const accum = sessions.get(sessionId) ?? { messageCount: 0, totalTokens: 0 }
    sessions.set(sessionId, accum)

    const row: MessageRow | null = projectEvent(session, event, { sessionId })
    if (row) {
      accum.messageCount += 1
      accum.firstMessageAt ??= row.createdAt
      accum.lastMessageAt = row.createdAt
      void fanout((backend) => backend.upsertMessage(row))
    }

    const usage = usageOf(event)
    accum.totalTokens += usage.input + usage.output

    if (row || usage.input + usage.output > 0 || event?.type === 'turn/end') {
      const sessionRow: SessionRow = {
        id: sessionId,
        sessionId,
        messageCount: accum.messageCount,
        totalTokens: accum.totalTokens,
        firstMessageAt: accum.firstMessageAt ?? null,
        lastMessageAt: accum.lastMessageAt ?? null,
      }
      void fanout((backend) => backend.upsertSession(sessionRow))
    }
  })

  ctx.on('session/disposed' as never, (session: any) => {
    sessions.delete(session?.id ?? 'unknown')
  })

  ctx.on('dispose', async () => {
    sessions.clear()
    await fanout(async (backend) => backend.close?.())
  })
}
