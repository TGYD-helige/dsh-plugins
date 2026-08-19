/**
 * Redis mirror backend. `ioredis` is an optional peer dependency.
 *
 * Key layout (TTL applies to everything, default 24h):
 *   dsh:messages:{sessionId}   — Redis list of MessageRow JSON, append-only
 *   dsh:session:{sessionId}    — SessionRow JSON
 *
 * This is a mirror for quick reads / cross-process sharing, not the
 * authoritative store — dsh's own session persistence keeps that role.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MessageRow, SessionRow, StorageBackend } from '../types.js'

export interface RedisBackendConfig {
  url: string
  keyPrefix?: string
  ttlSeconds?: number
}

export class RedisBackend implements StorageBackend {
  readonly name = 'redis'
  private redis: any = null
  private prefix: string
  private ttl: number

  constructor(private config: RedisBackendConfig) {
    this.prefix = config.keyPrefix ?? 'dsh'
    this.ttl = config.ttlSeconds ?? 86_400
  }

  async init(): Promise<void> {
    const mod = await import('ioredis')
    this.redis = new (mod as any).Redis(this.config.url)
  }

  async upsertMessage(row: MessageRow): Promise<void> {
    if (!this.redis) return
    const key = `${this.prefix}:messages:${row.sessionId}`
    await this.redis
      .multi()
      .rpush(key, JSON.stringify(row))
      .expire(key, this.ttl)
      .exec()
  }

  async upsertSession(row: SessionRow): Promise<void> {
    if (!this.redis) return
    const key = `${this.prefix}:session:${row.sessionId}`
    await this.redis.set(key, JSON.stringify(row), 'EX', this.ttl)
  }

  async close(): Promise<void> {
    await this.redis?.quit?.()
  }
}
