/**
 * Redis TaskStore for @a2a-js/sdk. `ioredis` is an optional peer dependency.
 *
 * Ported from the source project's packages/a2a-server/src/persistence/redis.ts:
 * task metadata JSON under `a2a:tasks:{taskId}` with a TTL, plus a
 * `contextId → taskId` index key for contextId-based lookups.
 *
 * Note: A2A history/artifacts are NOT stored here — conversation history is
 * dsh-storage's job (ai_messages). This store carries task state only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Task } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';

export interface RedisTaskStoreConfig {
  url: string;
  keyPrefix?: string;
  ttlSeconds?: number;
}

export class RedisTaskStore implements TaskStore {
  private redis: any = null;
  private prefix: string;
  private ttl: number;

  constructor(private config: RedisTaskStoreConfig) {
    this.prefix = config.keyPrefix ?? 'a2a';
    this.ttl = config.ttlSeconds ?? 86_400;
  }

  async init(): Promise<void> {
    const mod = await import('ioredis');
    this.redis = new (mod as any).Redis(this.config.url);
  }

  private taskKey(taskId: string): string {
    return `${this.prefix}:tasks:${taskId}`;
  }

  private contextKey(contextId: string): string {
    return `${this.prefix}:contexts:${contextId}`;
  }

  async save(task: Task): Promise<void> {
    if (!this.redis) return;
    const multi = this.redis
      .multi()
      .set(this.taskKey(task.id), JSON.stringify(task), 'EX', this.ttl);
    if (task.contextId) {
      multi.set(this.contextKey(task.contextId), task.id, 'EX', this.ttl);
    }
    await multi.exec();
  }

  async load(taskId: string): Promise<Task | undefined> {
    if (!this.redis) return undefined;
    const raw: string | null = await this.redis.get(this.taskKey(taskId));
    return raw ? (JSON.parse(raw) as Task) : undefined;
  }

  async loadByContextId(contextId: string): Promise<Task | undefined> {
    if (!this.redis) return undefined;
    const taskId: string | null = await this.redis.get(this.contextKey(contextId));
    return taskId ? this.load(taskId) : undefined;
  }

  async close(): Promise<void> {
    await this.redis?.quit?.();
  }
}
