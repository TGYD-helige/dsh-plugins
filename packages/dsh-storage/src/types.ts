/**
 * Shared row types and the backend contract.
 *
 * Row shapes mirror the `ai_messages` / `ai_chat_histories` Prisma models
 * (see prisma/schema.{mysql,postgresql,sqlite,sqlserver}.prisma), matching
 * the source project's tables.
 */

/** One row in `ai_messages`. */
export interface MessageRow {
  id: string;
  sessionId: string;
  historyId: string | null;
  /** 'user' | 'model' | 'tool' | 'utility_compressor' | plugin-defined */
  type: string;
  content: string;
  thoughts?: unknown;
  model?: string | null;
  tokens?: unknown;
  toolCalls?: unknown;
  agentId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

/** One row in `ai_chat_histories` — a per-session rollup. */
export interface SessionRow {
  sessionId: string;
  title?: string | null;
  messageCount: number;
  totalTokens: number;
  firstMessageAt?: Date | null;
  lastMessageAt?: Date | null;
  /** Plugin bookkeeping persisted in the row's JSON metadata column. */
  metadata?: Record<string, unknown>;
}

/**
 * A storage backend receives already-projected rows. Backends must be
 * no-throw from the plugin's perspective: implementations report errors to
 * the plugin logger and swallow them, mirroring must never break the agent
 * loop.
 */
export interface StorageBackend {
  readonly name: string;
  init?(): Promise<void>;
  /** Read the stored session row, for seeding the live rollup on resume. */
  readSession?(sessionId: string): Promise<SessionRow | null>;
  upsertMessage(row: MessageRow): Promise<void>;
  upsertSession(row: SessionRow): Promise<void>;
  close?(): Promise<void>;
}
