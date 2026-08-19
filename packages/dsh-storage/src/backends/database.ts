/**
 * MySQL/PostgreSQL backend via Prisma, using prisma/schema.prisma in this
 * package (dsh_messages / dsh_chat_histories). `@prisma/client` is an
 * optional peer dependency — generate it against the bundled schema first:
 *
 *   npx prisma generate --schema node_modules/dsh-storage/prisma/schema.prisma
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MessageRow, SessionRow, StorageBackend } from '../types.js'

export interface DatabaseBackendConfig {
  /** Full connection URL, e.g. mysql://user:pass@host:3306/dbname */
  url: string
}

export class DatabaseBackend implements StorageBackend {
  readonly name = 'database'
  private prisma: any = null

  constructor(private config: DatabaseBackendConfig) {}

  async init(): Promise<void> {
    const mod = await import('@prisma/client')
    this.prisma = new (mod as any).PrismaClient({
      datasources: { db: { url: this.config.url } },
    })
    await this.prisma.$connect()
  }

  private toDbData(row: MessageRow): Record<string, unknown> {
    return {
      type: row.type,
      content: row.content,
      thoughts: row.thoughts ?? undefined,
      model: row.model ?? undefined,
      tokens: row.tokens ?? undefined,
      toolCalls: row.toolCalls ?? undefined,
      agentId: row.agentId ?? undefined,
      metadata: { id: row.id, ...(row.metadata ?? {}) },
      createdAt: row.createdAt,
    }
  }

  async upsertMessage(row: MessageRow): Promise<void> {
    if (!this.prisma) return
    const data = this.toDbData(row)
    // Match the source project's convention: the logical message id rides in
    // metadata.id; the DB primary key is a cuid assigned on first insert.
    const existing = await this.prisma.dshMessage.findFirst({
      where: { sessionId: row.sessionId, metadata: { path: ['id'], equals: row.id } },
      select: { id: true },
    })
    if (existing) {
      await this.prisma.dshMessage.update({ where: { id: existing.id }, data })
    } else {
      await this.prisma.dshMessage.create({
        data: {
          sessionId: row.sessionId,
          userId: row.userId,
          historyId: row.historyId,
          ...data,
        },
      })
    }
  }

  async upsertSession(row: SessionRow): Promise<void> {
    if (!this.prisma) return
    const existing = await this.prisma.dshChatHistory.findFirst({
      where: { sessionId: row.sessionId, deletedAt: null },
      select: { id: true },
    })
    const data = {
      sessionId: row.sessionId,
      userId: row.userId,
      title: row.title ?? undefined,
      summary: row.summary ?? undefined,
      messageCount: row.messageCount,
      totalTokens: BigInt(row.totalTokens),
      firstMessageAt: row.firstMessageAt ?? undefined,
      lastMessageAt: row.lastMessageAt ?? undefined,
      metadata: row.metadata ?? undefined,
    }
    if (existing) {
      await this.prisma.dshChatHistory.update({ where: { id: existing.id }, data })
    } else {
      await this.prisma.dshChatHistory.create({ data })
    }
  }

  async close(): Promise<void> {
    await this.prisma?.$disconnect?.()
  }
}
