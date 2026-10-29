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
    const where = "session_id = ? AND deleted_at IS NULL AND history_id IS NULL AND type = 'model'";
    let sql: string;
    let params: string[];
    switch (this.config.provider) {
      case 'mysql':
        sql = `SELECT id FROM ai_messages WHERE ${where} AND BINARY session_id = BINARY ?
          AND JSON_CONTAINS(tool_calls, ?) ORDER BY created_at DESC, id DESC LIMIT 1`;
        params = [sessionId, sessionId, JSON.stringify([{ id: callId }])];
        break;
      case 'postgresql':
        sql = `SELECT id FROM ai_messages WHERE ${where.replace('?', '$1')}
          AND tool_calls @> $2::jsonb ORDER BY created_at DESC, id DESC LIMIT 1`;
        params = [sessionId, JSON.stringify([{ id: callId }])];
        break;
      case 'sqlite':
        sql = `SELECT id FROM ai_messages WHERE ${where}
          AND EXISTS (SELECT 1 FROM json_each(tool_calls) WHERE CASE WHEN type = 'object' THEN json_extract(value, '$.id') END = ?)
          ORDER BY created_at DESC, id DESC LIMIT 1`;
        params = [sessionId, callId];
        break;
      case 'sqlserver':
        // SQL Server equality ignores case in common collations and pads trailing spaces.
        sql = `SELECT TOP 1 id FROM ai_messages WHERE ${where.replace('?', '@P1')}
          AND session_id COLLATE Latin1_General_100_BIN2 = @P1
          AND DATALENGTH(CAST(session_id AS nvarchar(max))) = DATALENGTH(CAST(@P1 AS nvarchar(max)))
          AND EXISTS (SELECT 1 FROM OPENJSON(tool_calls) WITH (call_id nvarchar(max) '$.id')
            WHERE call_id COLLATE Latin1_General_100_BIN2 = @P2
            AND DATALENGTH(call_id) = DATALENGTH(CAST(@P2 AS nvarchar(max))))
          ORDER BY created_at DESC, id DESC`;
        params = [sessionId, callId];
        break;
    }
    const rows = await this.prisma.$queryRawUnsafe(sql, ...params);
    if (rows.length === 0) return [];
    return this.readRows({
      sessionId,
      deletedAt: null,
      historyId: null,
      type: 'model',
      id: rows[0].id,
    });
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
    const row = await this.prisma.aiChatHistory.findFirst({
      where: { sessionId, deletedAt: null, messages: { none: {} } },
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
    const existing = await this.prisma.aiChatHistory.findFirst({
      where: { sessionId: row.sessionId, deletedAt: null, messages: { none: {} } },
      select: { id: true },
    });
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
      await this.prisma.aiChatHistory.create({ data });
    }
  }

  async archiveSession(sessionId: string): Promise<string | null> {
    if (!this.prisma) throw new Error('dsh-storage database is not initialized');
    return this.prisma.$transaction(async (tx: any) => {
      const where = { sessionId, historyId: null, deletedAt: null };
      const stats = await tx.aiMessage.aggregate({
        where,
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      });
      if (stats._count._all === 0) return null;

      // Active rollups have no attached messages; an archive gains them below.
      const active = await tx.aiChatHistory.findFirst({
        where: { sessionId, deletedAt: null, messages: { none: {} } },
        select: { id: true },
      });
      const rollup = {
        messageCount: stats._count._all,
        firstMessageAt: stats._min.createdAt,
        lastMessageAt: stats._max.createdAt,
      };
      const history = active
        ? await tx.aiChatHistory.update({ where: { id: active.id }, data: rollup })
        : await tx.aiChatHistory.create({
            data: { sessionId, ...rollup, totalTokens: 0n },
            select: { id: true },
          });
      const updated = await tx.aiMessage.updateMany({ where, data: { historyId: history.id } });
      if (updated.count !== stats._count._all) {
        throw new Error('active messages changed during archive');
      }
      return history.id;
    });
  }

  async close(): Promise<void> {
    await this.prisma?.$disconnect?.();
  }
}
