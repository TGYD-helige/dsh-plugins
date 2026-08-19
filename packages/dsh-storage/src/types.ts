/**
 * Shared row types and the backend contract.
 *
 * Row shapes mirror the `dsh_messages` / `dsh_chat_histories` Prisma models
 * (see prisma/schema.prisma), which are adapted from the source project's
 * ai_messages / ai_chat_histories tables.
 */

/** One row in `dsh_messages`. */
export interface MessageRow {
  id: string
  sessionId: string
  userId: string
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

/** One row in `dsh_chat_histories` — a per-session rollup. */
export interface SessionRow {
  id: string
  sessionId: string
  userId: string
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
  /**
   * Archive the session workspace (e.g. tar to GCS). Called on
   * `session/disposed` when `archiveWorkspace` is enabled in config and the
   * backend implements it.
   */
  archiveWorkspace?(sessionId: string, cwd: string): Promise<void>
  close?(): Promise<void>
}
