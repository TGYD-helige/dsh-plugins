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

const ARCHIVE_IN_PROGRESS = 'dsh-storage:archive-in-progress';

function metadataOf(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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

  private client(): any {
    if (!this.prisma) throw new Error('dsh-storage database is not initialized');
    return this.prisma;
  }

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
    const prisma = new PrismaClient({ adapter });
    try {
      await prisma.$connect();
      this.prisma = prisma;
    } catch (error) {
      await prisma.$disconnect?.().catch(() => {});
      throw error;
    }
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

  private async writeMessage(client: any, row: MessageRow): Promise<void> {
    // NUL-separated: a space-joined pair would be ambiguous ('a b','c' ≡ 'a','b c').
    const id = pk(`message ${row.sessionId}\0${row.id}`);
    const data = this.toDbData(row);
    await client.aiMessage.upsert({
      where: { id },
      create: { id, sessionId: row.sessionId, historyId: row.historyId, ...data },
      update: data,
    });
  }

  async upsertMessage(row: MessageRow): Promise<void> {
    await this.writeMessage(this.client(), row);
  }

  async readMessages(sessionId: string, messageId: string): Promise<MessageRow[]> {
    return this.readRows({
      sessionId,
      deletedAt: null,
      id: pk(`message ${sessionId}\0${messageId}`),
    });
  }

  async readToolCallMessages(sessionId: string, callId: string): Promise<MessageRow[]> {
    const prisma = this.client();
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
      const page = await prisma.$queryRawUnsafe(sql, ...params);
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

  private async readRows(where: Record<string, unknown>): Promise<MessageRow[]> {
    const rows = await this.client().aiMessage.findMany({
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
    const row = await this.client().aiChatHistory.findFirst({
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

  private async writeSession(client: any, row: SessionRow): Promise<void> {
    // Find-then-write is race-free because the plugin serializes event
    // processing per session (see the per-session chain in index.ts). The
    // cuid primary key matches the source project and early-scaffold rows,
    // so existing data is continued, never duplicated.
    const existing = await client.aiChatHistory.findFirst({
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
      await client.aiChatHistory.update({ where: { id: existing.id }, data });
    } else {
      await client.aiChatHistory.create({ data });
    }
  }

  async upsertSession(row: SessionRow): Promise<void> {
    await this.writeSession(this.client(), row);
  }

  async upsertEvent(message: MessageRow | null, session: SessionRow): Promise<void> {
    await this.client().$transaction(async (tx: any) => {
      if (message) await this.writeMessage(tx, message);
      await this.writeSession(tx, session);
    });
  }

  async archiveSession(sessionId: string): Promise<string | null> {
    const client = this.client();
    const { expected, historyId } = await client.$transaction(async (tx: any) => {
      const where = { sessionId, historyId: null, deletedAt: null };
      const stats = await tx.aiMessage.aggregate({
        where,
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      });
      const expected = stats._count._all as number;
      // A previous batch may have attached messages already. Resume that marked
      // history before considering a newer active rollup or an empty finalization.
      const interrupted = await tx.aiMessage.findFirst({
        where: { sessionId, historyId: { not: null }, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { historyId: true },
      });
      if (interrupted?.historyId) {
        const candidate = await tx.aiChatHistory.findFirst({
          where: { id: interrupted.historyId },
          select: { metadata: true },
        });
        if (metadataOf(candidate?.metadata)[ARCHIVE_IN_PROGRESS] === true)
          return { expected, historyId: interrupted.historyId };
      }
      if (expected === 0) return { expected, historyId: null };

      const rollup = {
        messageCount: expected,
        firstMessageAt: stats._min.createdAt,
        lastMessageAt: stats._max.createdAt,
      };

      // Active rollups have no attached messages; an archive gains them below.
      const active = await tx.aiChatHistory.findFirst({
        where: { sessionId, deletedAt: null, messages: { none: {} } },
        select: { id: true, metadata: true },
      });
      if (active) {
        await tx.aiChatHistory.update({
          where: { id: active.id },
          data: {
            ...rollup,
            metadata: this.jsonField({
              ...metadataOf(active.metadata),
              [ARCHIVE_IN_PROGRESS]: true,
            }),
          },
        });
        return { expected, historyId: active.id };
      }

      const history = await tx.aiChatHistory.create({
        data: {
          sessionId,
          ...rollup,
          totalTokens: 0n,
          metadata: this.jsonField({ [ARCHIVE_IN_PROGRESS]: true }),
        },
        select: { id: true },
      });
      return { expected, historyId: history.id };
    });
    if (!historyId) return null;

    // Keep each write batch short instead of holding one transaction over the
    // entire active segment. The final aggregate is the correctness barrier.
    let updated = 0;
    while (updated < expected) {
      const candidates = await client.aiMessage.findMany({
        where: { sessionId, historyId: null, deletedAt: null },
        select: { id: true },
        take: 100,
      });
      if (candidates.length === 0) break;
      const batch = await client.aiMessage.updateMany({
        where: { id: { in: candidates.map((row: any) => row.id) } },
        data: { historyId },
      });
      if (batch.count === 0) break;
      updated += batch.count;
    }
    if (updated !== expected) throw new Error('active messages changed during archive');

    await client.$transaction(async (tx: any) => {
      const stats = await tx.aiMessage.aggregate({
        where: { historyId, deletedAt: null },
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      });
      const current = await tx.aiChatHistory.findFirst({
        where: { id: historyId },
        select: { metadata: true },
      });
      const metadata = { ...metadataOf(current?.metadata) };
      delete metadata[ARCHIVE_IN_PROGRESS];
      await tx.aiChatHistory.update({
        where: { id: historyId },
        data: {
          messageCount: stats._count._all,
          firstMessageAt: stats._min.createdAt,
          lastMessageAt: stats._max.createdAt,
          metadata: this.jsonField(metadata),
        },
      });
      // A recovery may have created a second active rollup during the failed
      // batches. Do not let its pre-archive counts seed the next live segment.
      await tx.aiChatHistory.updateMany({
        where: { sessionId, id: { not: historyId }, deletedAt: null, messages: { none: {} } },
        data: { messageCount: 0, totalTokens: 0n, firstMessageAt: null, lastMessageAt: null },
      });
    });
    return historyId;
  }

  async close(): Promise<void> {
    await this.prisma?.$disconnect?.();
  }
}
