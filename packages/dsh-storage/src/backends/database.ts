/**
 * MySQL/PostgreSQL/SQLite/SQL Server backend via Prisma 7. The clients are
 * pre-generated at package build time (`pnpm generate`, see
 * scripts/prisma-generate.mjs) from the schema variants in prisma/ and
 * shipped compiled in lib/generated — consumers never run `prisma generate`.
 *
 * Prisma 7 requires a driver adapter per database; `@prisma/client` and the
 * adapter for your provider are optional peer dependencies (sqlite uses
 * `@prisma/adapter-libsql` — no native build scripts, unlike
 * `@prisma/adapter-better-sqlite3`). Table creation
 * (`prisma db push` / migrations) uses the shipped schema variant with the
 * connection URL in the user's prisma.config.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';
import type { MessageRow, SessionRow, StorageBackend } from '../types.js';

export type DatabaseProvider = 'mysql' | 'postgresql' | 'sqlite' | 'sqlserver';

export interface DatabaseBackendConfig {
  provider: DatabaseProvider;
  /** Full connection URL, e.g. mysql://user:pass@host:3306/dbname, file:/data/dsh.db */
  url: string;
}

/**
 * Deterministic primary key for a row: one logical id maps to one row, so
 * redelivery (plugin reload, resume edge cases) updates in place instead of
 * duplicating. A PK upsert works on every Prisma connector — the source
 * project's `metadata.id` JSON-path lookup does not (advanced JSON filtering
 * is PostgreSQL/MySQL only). `metadata.id` is still written for
 * source-compatible read paths.
 */
function pk(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 36);
}

/**
 * Parse the prisma-style sqlserver URL
 * (sqlserver://host:1433;database=d;user=u;password=p;encrypt=true;trustServerCertificate=true)
 * into a node-mssql config object. Values are URL-decoded — credentials with
 * special characters arrive percent-encoded.
 */
function mssqlConfig(url: string): Record<string, unknown> {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value; // plain value with a raw '%' — pass through unchanged
    }
  };
  const [authority, ...pairs] = url.replace(/^sqlserver:\/\//, '').split(';');
  const [server, port] = authority.split(':');
  const params = Object.fromEntries(
    pairs
      .filter((pair) => pair.includes('='))
      .map((pair) => [pair.slice(0, pair.indexOf('=')), decode(pair.slice(pair.indexOf('=') + 1))]),
  );
  for (const key of ['database', 'user', 'password']) {
    // Redact everything from 'password=' on: this error surfaces in logs via
    // the no-throw seam, and a malformed URL must not leak any fragment.
    if (params[key] == null)
      throw new Error(
        `sqlserver url is missing '${key}': ${url.replace(/(password=).*$/i, '$1***')}`,
      );
  }
  return {
    server,
    ...(port ? { port: Number(port) } : {}),
    database: params.database,
    user: params.user,
    password: params.password,
    options: {
      encrypt: params.encrypt === 'true',
      trustServerCertificate: params.trustServerCertificate === 'true',
    },
  };
}

export async function createAdapter(config: DatabaseBackendConfig): Promise<unknown> {
  switch (config.provider) {
    case 'mysql': {
      // The mariadb driver accepts mariadb:// URIs; mysql:// is the same wire.
      const { PrismaMariaDb } = await import('@prisma/adapter-mariadb');
      return new PrismaMariaDb(config.url.replace(/^mysql:\/\//, 'mariadb://'));
    }
    case 'postgresql': {
      const { PrismaPg } = await import('@prisma/adapter-pg');
      return new PrismaPg({ connectionString: config.url });
    }
    case 'sqlite': {
      // adapter-libsql (not adapter-better-sqlite3): its native binding ships
      // as platform optionalDependencies with no install scripts, so it works
      // under pnpm's default build-script block (dsh profiles install that way).
      const { PrismaLibSql } = await import('@prisma/adapter-libsql');
      return new PrismaLibSql({ url: config.url });
    }
    case 'sqlserver': {
      const { PrismaMssql } = await import('@prisma/adapter-mssql');
      return new PrismaMssql(mssqlConfig(config.url));
    }
  }
}

export class DatabaseBackend implements StorageBackend {
  readonly name = 'database';
  private prisma: any = null;
  private activeHistoryIds = new Map<string, string>();

  constructor(private config: DatabaseBackendConfig) {}

  /** Load the pre-generated client for the configured provider (seam for tests). */
  protected async loadClient(): Promise<any> {
    const mod = await import(
      new URL(`../generated/${this.config.provider}/client.js`, import.meta.url).href
    );
    return mod.PrismaClient;
  }

  async init(): Promise<void> {
    const [PrismaClient, adapter] = await Promise.all([
      this.loadClient(),
      createAdapter(this.config),
    ]);
    this.prisma = new PrismaClient({ adapter });
    await this.prisma.$connect();
  }

  /** JSON column value, text-serialized on SQL Server (no Prisma Json type). */
  private jsonField(value: unknown): unknown {
    return value == null
      ? undefined
      : this.config.provider === 'sqlserver'
        ? JSON.stringify(value)
        : value;
  }

  private toDbData(row: MessageRow): Record<string, unknown> {
    // SQL Server has no Prisma Json type: its variant uses text columns, so
    // JSON fields are serialized on write (derived from the provider — the
    // only valid combination, not a user knob).
    return {
      type: row.type,
      content: row.content,
      thoughts: this.jsonField(row.thoughts),
      model: row.model ?? undefined,
      tokens: this.jsonField(row.tokens),
      toolCalls: this.jsonField(row.toolCalls),
      agentId: row.agentId ?? undefined,
      metadata: this.jsonField({ id: row.id, ...(row.metadata ?? {}) }),
      createdAt: row.createdAt,
    };
  }

  async upsertMessage(row: MessageRow): Promise<void> {
    if (!this.prisma) return;
    // NUL-separated: a space-joined pair would be ambiguous ('a b','c' ≡ 'a','b c').
    const id = pk(`message ${row.sessionId}\0${row.id}`);
    const data = this.toDbData(row);
    await this.prisma.aiMessage.upsert({
      where: { id },
      create: { id, sessionId: row.sessionId, historyId: row.historyId, ...data },
      update: data,
    });
  }

  async readMessages(sessionId: string, messageId: string): Promise<MessageRow[]> {
    return this.readRows({
      sessionId,
      deletedAt: null,
      id: pk(`message ${sessionId}\0${messageId}`),
    });
  }

  async readToolCallMessages(sessionId: string, callId: string): Promise<MessageRow[]> {
    if (!this.prisma) return [];
    const provider = this.config.provider;
    const sqlserver = provider === 'sqlserver';
    const sortTime =
      provider === 'mysql'
        ? "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f')"
        : provider === 'postgresql'
          ? "to_char(created_at, 'YYYY-MM-DD HH24:MI:SS.US')"
          : sqlserver
            ? 'CONVERT(varchar(33), created_at, 126)'
            : 'CAST(created_at AS TEXT)';
    let cursor: { id: string; time: string | null } | undefined;
    for (;;) {
      const params: Array<string | null> =
        provider === 'mysql' || provider === 'sqlite' ? [sessionId, sessionId] : [sessionId];
      let before = '';
      if (cursor) {
        if (cursor.time === null) {
          before =
            provider === 'postgresql'
              ? 'AND (created_at IS NOT NULL OR (created_at IS NULL AND id < ?))'
              : 'AND created_at IS NULL AND id < ?';
          params.push(cursor.id);
        } else {
          before = `AND (created_at < ? OR (created_at = ? AND id < ?)${provider === 'postgresql' ? '' : ' OR created_at IS NULL'})`;
          params.push(cursor.time, cursor.time, cursor.id);
        }
      }
      let sql = `SELECT ${sqlserver ? 'TOP 100 ' : ''}id, tool_calls, ${sortTime} AS sort_time
        FROM ai_messages WHERE session_id = ?
        ${provider === 'sqlite' ? 'AND session_id COLLATE BINARY = ?' : ''}
        ${provider === 'mysql' ? 'AND BINARY session_id = BINARY ?' : ''}
        AND deleted_at IS NULL AND history_id IS NULL AND type = 'model' AND tool_calls IS NOT NULL
        ${
          sqlserver
            ? `AND session_id COLLATE Latin1_General_100_BIN2 = @P1
          AND DATALENGTH(CAST(session_id AS nvarchar(max))) = DATALENGTH(CAST(@P1 AS nvarchar(max)))`
            : ''
        }
        ${before} ORDER BY created_at DESC, id DESC ${sqlserver ? '' : 'LIMIT 100'}`;
      if (sqlserver || provider === 'postgresql') {
        let index = 0;
        sql = sql.replaceAll('?', () => `${sqlserver ? '@P' : '$'}${++index}`);
      }
      const page = await this.prisma.$queryRawUnsafe(sql, ...params);
      for (const row of page) {
        let calls = row.tool_calls;
        if (typeof calls === 'string') {
          try {
            calls = JSON.parse(calls);
          } catch {
            continue;
          }
        }
        if (Array.isArray(calls) && calls.some((call: any) => call?.id === callId)) {
          return this.readRows({
            sessionId,
            deletedAt: null,
            historyId: null,
            type: 'model',
            id: row.id,
          });
        }
      }
      if (page.length < 100) return [];
      const last = page.at(-1);
      cursor = { id: last.id, time: last.sort_time };
    }
  }

  private rememberHistory(sessionId: string, id: string): void {
    if (!this.activeHistoryIds.has(sessionId) && this.activeHistoryIds.size >= 1000) {
      const oldest = this.activeHistoryIds.keys().next().value;
      if (oldest !== undefined) this.activeHistoryIds.delete(oldest);
    }
    this.activeHistoryIds.set(sessionId, id);
  }

  private async activeHistory(client: any, sessionId: string): Promise<{ id: string } | null> {
    const cachedId = this.activeHistoryIds.get(sessionId);
    if (cachedId) {
      const cached = await client.aiChatHistory.findFirst({
        where: { id: cachedId, sessionId, deletedAt: null },
        select: { id: true, sessionId: true },
      });
      if (
        cached?.sessionId === sessionId &&
        !(await client.aiMessage.findFirst({
          where: { historyId: cachedId },
          select: { id: true },
        }))
      )
        return { id: cachedId };
      this.activeHistoryIds.delete(sessionId);
    }
    let lastId: string | undefined;
    for (;;) {
      const page = await client.aiChatHistory.findMany({
        where: { sessionId, deletedAt: null, ...(lastId ? { id: { lt: lastId } } : {}) },
        select: { id: true, sessionId: true },
        orderBy: { id: 'desc' },
        take: 100,
      });
      for (const row of page) {
        if (row.sessionId !== sessionId) continue;
        const attached = await client.aiMessage.findFirst({
          where: { historyId: row.id },
          select: { id: true },
        });
        if (!attached) {
          this.rememberHistory(sessionId, row.id);
          return { id: row.id };
        }
      }
      if (page.length < 100) return null;
      lastId = page.at(-1).id;
    }
  }

  private async readRows(where: Record<string, unknown>): Promise<MessageRow[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.aiMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1,
    });
    const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
    return rows.map((row: any) => {
      const metadata = json(row.metadata) ?? {};
      const storedThoughts = json(row.thoughts);
      const thoughts = Array.isArray(storedThoughts)
        ? storedThoughts.map((thought) => {
            if (
              thought &&
              typeof thought === 'object' &&
              !('content' in thought) &&
              'description' in thought
            ) {
              const { description, ...rest } = thought;
              return { ...rest, content: description };
            }
            return thought;
          })
        : typeof storedThoughts === 'string'
          ? [{ content: storedThoughts }]
          : storedThoughts;
      return {
        id: typeof metadata.id === 'string' ? metadata.id : row.id,
        sessionId: row.sessionId,
        historyId: row.historyId,
        type: row.type,
        content: row.content,
        thoughts,
        model: row.model,
        tokens: json(row.tokens),
        toolCalls: json(row.toolCalls),
        agentId: row.agentId,
        metadata,
        createdAt: row.createdAt,
      };
    });
  }

  async readSession(sessionId: string): Promise<SessionRow | null> {
    if (!this.prisma) return null;
    const active = await this.activeHistory(this.prisma, sessionId);
    if (!active) return null;
    const row = await this.prisma.aiChatHistory.findFirst({
      where: { id: active.id, sessionId, deletedAt: null },
    });
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      title: row.title,
      messageCount: row.messageCount,
      totalTokens: Number(row.totalTokens),
      firstMessageAt: row.firstMessageAt,
      lastMessageAt: row.lastMessageAt,
      // SQL Server stores JSON columns as text — parse them back on read.
      metadata:
        row.metadata == null
          ? undefined
          : typeof row.metadata === 'string'
            ? JSON.parse(row.metadata)
            : row.metadata,
    };
  }

  async upsertSession(row: SessionRow): Promise<void> {
    if (!this.prisma) return;
    // Find-then-write is race-free because the plugin serializes event
    // processing per session (see the per-session chain in index.ts). The
    // cuid primary key matches the source project and early-scaffold rows,
    // so existing data is continued, never duplicated.
    const existing = await this.activeHistory(this.prisma, row.sessionId);
    const data = {
      sessionId: row.sessionId,
      title: row.title ?? undefined,
      messageCount: row.messageCount,
      totalTokens: BigInt(row.totalTokens),
      firstMessageAt: row.firstMessageAt ?? undefined,
      lastMessageAt: row.lastMessageAt ?? undefined,
      metadata: this.jsonField(row.metadata),
    };
    if (existing) {
      await this.prisma.aiChatHistory.update({ where: { id: existing.id }, data });
    } else {
      const created = await this.prisma.aiChatHistory.create({ data, select: { id: true } });
      if (created) this.rememberHistory(row.sessionId, created.id);
    }
  }

  async archiveSession(sessionId: string): Promise<string | null> {
    if (!this.prisma) throw new Error('dsh-storage database is not initialized');
    const provider = this.config.provider;
    const scope =
      provider === 'mysql'
        ? 'session_id = ? AND BINARY session_id = BINARY ?'
        : provider === 'sqlite'
          ? 'session_id = ? AND session_id COLLATE BINARY = ?'
          : provider === 'sqlserver'
            ? `session_id = ? AND session_id COLLATE Latin1_General_100_BIN2 = ?
              AND DATALENGTH(CAST(session_id AS nvarchar(max))) = DATALENGTH(CAST(? AS nvarchar(max)))`
            : 'session_id = ?';
    const sessionParams =
      provider === 'postgresql'
        ? [sessionId]
        : provider === 'sqlserver'
          ? [sessionId, sessionId, sessionId]
          : [sessionId, sessionId];
    const bind = (sql: string) => {
      let index = 0;
      return provider === 'postgresql' || provider === 'sqlserver'
        ? sql.replaceAll('?', () => `${provider === 'postgresql' ? '$' : '@P'}${++index}`)
        : sql;
    };
    const date = (value: unknown): Date | null => {
      if (value === null) return null;
      if (value instanceof Date) return value;
      if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string')
        throw new Error('Invalid archive timestamp');
      const parsed = new Date(
        typeof value === 'bigint' || (typeof value === 'string' && /^-?\d+$/.test(value))
          ? Number(value)
          : value,
      );
      if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid archive timestamp');
      return parsed;
    };
    const archived = await this.prisma.$transaction(async (tx: any) => {
      const [stats] = await tx.$queryRawUnsafe(
        bind(
          `SELECT ${provider === 'sqlserver' ? 'COUNT_BIG' : 'COUNT'}(*) AS message_count,
         MIN(created_at) AS first_message_at, MAX(created_at) AS last_message_at
         FROM ai_messages WHERE ${scope} AND history_id IS NULL AND deleted_at IS NULL`,
        ),
        ...sessionParams,
      );
      const messageCount = Number(stats?.message_count);
      if (!Number.isSafeInteger(messageCount) || messageCount < 0)
        throw new Error('Invalid archive message count');
      if (messageCount === 0) return null;
      const firstMessageAt = date(stats.first_message_at);
      const lastMessageAt = date(stats.last_message_at);

      // Active rollups have no attached messages; an archive gains them below.
      const active = await this.activeHistory(tx, sessionId);
      const rollup = {
        messageCount,
        firstMessageAt,
        lastMessageAt,
      };
      const history = active
        ? await tx.aiChatHistory.update({ where: { id: active.id }, data: rollup })
        : await tx.aiChatHistory.create({
            data: { sessionId, ...rollup, totalTokens: 0n },
            select: { id: true },
          });
      const timestamp =
        provider === 'sqlite'
          ? '?'
          : provider === 'sqlserver'
            ? 'SYSUTCDATETIME()'
            : provider === 'mysql'
              ? 'CURRENT_TIMESTAMP(3)'
              : "CURRENT_TIMESTAMP(3) AT TIME ZONE 'UTC'";
      const params = [
        history.id,
        ...(provider === 'sqlite' ? [new Date().toISOString()] : []),
        ...sessionParams,
      ];
      const updated = await tx.$executeRawUnsafe(
        bind(
          `UPDATE ai_messages SET history_id = ?, updated_at = ${timestamp}
         WHERE ${scope} AND history_id IS NULL AND deleted_at IS NULL`,
        ),
        ...params,
      );
      if (Number(updated) !== messageCount) {
        throw new Error('active messages changed during archive');
      }
      return history.id;
    });
    this.activeHistoryIds.delete(sessionId);
    return archived;
  }

  async close(): Promise<void> {
    this.activeHistoryIds.clear();
    await this.prisma?.$disconnect?.();
  }
}
