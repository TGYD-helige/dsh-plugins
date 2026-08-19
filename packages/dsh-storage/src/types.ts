/**
 * Shared row types and the backend contract.
 *
 * Row shapes mirror the `ai_messages` / `ai_chat_histories` Prisma models
 * (see prisma/schema.prisma), matching the source project's tables.
 */

/** One row in `ai_messages`. */
export interface MessageRow {
  id: string
  sessionId: string
  historyId: string | null
  /** 'user' | 'model' | 'tool' | 'utility_compressor' | plugin-defined */
  type: string
  content: string
  thoughts?: unknown
  model?: string | null
  tokens?: unknown
  toolCalls?: unknown
  agentId?: string | null
  metadata?: Record<string, unknown>
  createdAt: Date
}

/** One row in `ai_chat_histories` — a per-session rollup. */
export interface SessionRow {
  id: string
  sessionId: string
  title?: string | null
  summary?: string | null
  messageCount: number
  totalTokens: number
  firstMessageAt?: Date | null
  lastMessageAt?: Date | null
  archivedAt?: Date
  metadata?: Record<string, unknown>
}

/**
 * A storage backend receives already-projected rows. Backends must be
 * no-throw from the plugin's perspective: implementations report errors to
 * the plugin logger and swallow them, mirroring must never break the agent
 * loop.
 */
export interface StorageBackend {
  readonly name: string
  init?(): Promise<void>
  upsertMessage(row: MessageRow): Promise<void>
  upsertSession(row: SessionRow): Promise<void>
  close?(): Promise<void>
}
