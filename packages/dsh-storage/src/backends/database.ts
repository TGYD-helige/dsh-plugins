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

  async readSession(sessionId: string): Promise<SessionRow | null> {
    if (!this.prisma) return null;
    let row = await this.prisma.aiChatHistory.findUnique({
      where: { id: pk(`session ${sessionId}`) },
    });
    // Pre-hash rows (cuid primary keys, early scaffold) don't match the PK —
    // fall back to the session id. The row's actual PK rides back in `pk`,
    // so later writes absorb it in place instead of creating a second row.
    row ??= await this.prisma.aiChatHistory.findFirst({
      where: { sessionId, deletedAt: null },
    });
    if (!row) return null;
    return {
      pk: row.id,
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
    // PK upsert like upsertMessage: the find-then-write pattern raced under
    // event bursts and produced duplicate rows for one session. A seeded
    // legacy row keeps its own PK so it is absorbed, never duplicated.
    const id = row.pk ?? pk(`session ${row.sessionId}`);
    const data = {
      title: row.title ?? undefined,
      messageCount: row.messageCount,
      totalTokens: BigInt(row.totalTokens),
      firstMessageAt: row.firstMessageAt ?? undefined,
      lastMessageAt: row.lastMessageAt ?? undefined,
      metadata: this.jsonField(row.metadata),
    };
    await this.prisma.aiChatHistory.upsert({
      where: { id },
      create: { id, sessionId: row.sessionId, ...data },
      update: data,
    });
  }

  async close(): Promise<void> {
    await this.prisma?.$disconnect?.();
  }
}
