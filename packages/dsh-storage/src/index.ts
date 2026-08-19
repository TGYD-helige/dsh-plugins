/**
 * dsh-storage — mirrors the dsh session event stream into external stores.
 *
 * Design: dsh's own session persistence (JSONL/SQLite) stays authoritative.
 * This plugin taps `session/event` (the same seam the built-in persistence
 * coordinator uses) and projects events into MessageRow / SessionRow shaped
 * after the source project's ai_messages / ai_chat_histories tables, feeding
 * any combination of database / redis / gcs backends.
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
import { RedisBackend } from './backends/redis.js'
import { GcsBackend } from './backends/gcs.js'

export const name = 'dsh-storage'

// Event-tap only: no hard service dependency. Add 'sessionPersistence' to
// `inject` if you want fail-fast when persistence is not composed.
export const inject = [] as string[]

export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  /** Fallback userId when the session carries no identity. */
  defaultUserId: Schema.string().default('0'),
  /** Tar the workspace to backends implementing archiveWorkspace on session dispose. */
  archiveWorkspace: Schema.boolean().default(false),
  database: Schema.object({
    enabled: Schema.boolean().default(false),
    url: Schema.string().role('secret').default(''),
  }),
  redis: Schema.object({
    enabled: Schema.boolean().default(false),
    url: Schema.string().default('redis://127.0.0.1:6379'),
    keyPrefix: Schema.string().default('dsh'),
    ttlSeconds: Schema.natural().default(86400),
  }),
  gcs: Schema.object({
    enabled: Schema.boolean().default(false),
    bucket: Schema.string().default(''),
    prefix: Schema.string().default('dsh'),
    keyFilename: Schema.string().default(''),
  }),
})

export interface StoragePluginConfig {
  enabled: boolean
  defaultUserId: string
  archiveWorkspace: boolean
  database: { enabled: boolean; url: string }
  redis: { enabled: boolean; url: string; keyPrefix: string; ttlSeconds: number }
  gcs: { enabled: boolean; bucket: string; prefix: string; keyFilename: string }
}

/** Per-session live rollup used to maintain the session row. */
interface SessionAccum {
  messageCount: number
  totalTokens: number
  firstMessageAt?: Date
  lastMessageAt?: Date
  cwd?: string
}

export function apply(ctx: Context, config: StoragePluginConfig): void {
  if (!config.enabled) return

  const backends: StorageBackend[] = []
  if (config.database.enabled && config.database.url) {
    backends.push(new DatabaseBackend({ url: config.database.url }))
  }
  if (config.redis.enabled) {
    backends.push(
      new RedisBackend({
        url: config.redis.url,
        keyPrefix: config.redis.keyPrefix,
        ttlSeconds: config.redis.ttlSeconds,
      }),
    )
  }
  if (config.gcs.enabled && config.gcs.bucket) {
    backends.push(
      new GcsBackend({
        bucket: config.gcs.bucket,
        prefix: config.gcs.prefix,
        keyFilename: config.gcs.keyFilename || undefined,
      }),
    )
  }
  if (backends.length === 0) return

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
    accum.cwd ??= session?.header?.cwd

    const row: MessageRow | null = projectEvent(session, event, {
      sessionId,
      userId: session?.header?.meta?.userId ?? config.defaultUserId,
    })
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
        userId: session?.header?.meta?.userId ?? config.defaultUserId,
        messageCount: accum.messageCount,
        totalTokens: accum.totalTokens,
        firstMessageAt: accum.firstMessageAt ?? null,
        lastMessageAt: accum.lastMessageAt ?? null,
      }
      void fanout((backend) => backend.upsertSession(sessionRow))
    }
  })

  ctx.on('session/disposed' as never, (session: any) => {
    const sessionId: string = session?.id ?? 'unknown'
    const accum = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (config.archiveWorkspace && accum?.cwd) {
      void fanout(async (backend) => backend.archiveWorkspace?.(sessionId, accum.cwd!))
    }
  })

  ctx.on('dispose', async () => {
    sessions.clear()
    await fanout(async (backend) => backend.close?.())
  })
}
