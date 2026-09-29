/**
 * Redis TaskStore for @a2a-js/sdk. `ioredis` is an optional peer dependency.
 *
 * Ported from the source project's packages/a2a-server/src/persistence/redis.ts:
 * task state JSON under `a2a:tasks:{scope}:{taskId}` with a TTL. Task
 * snapshots arrive from SanitizedTaskStore at state transitions;
 * dsh-storage separately owns the full conversation log (ai_messages).
 */

import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import { listShells, type ManagedTaskStore, taskScopeKey } from '../task-store.js';

export interface RedisTaskStoreConfig {
  url: string;
  keyPrefix?: string;
  ttlSeconds?: number;
}

export class RedisTaskStore implements ManagedTaskStore {
  private redis: any = null;
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(private readonly config: RedisTaskStoreConfig) {
    this.prefix = config.keyPrefix ?? 'a2a';
    this.ttl = config.ttlSeconds ?? 86_400;
  }

  async init(): Promise<void> {
    const mod = await import('ioredis');
    this.redis = new (mod as any).Redis(this.config.url);
  }

  private taskKey(taskId: string, context: ServerCallContext): string {
    return `${this.prefix}:tasks:${taskScopeKey(context)}:${taskId}`;
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(this.taskKey(task.id, context), JSON.stringify(task), 'EX', this.ttl);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    if (!this.redis) return undefined;
    const raw: string | null = await this.redis.get(this.taskKey(taskId, context));
    return raw ? (JSON.parse(raw) as Task) : undefined;
  }

  async delete(taskId: string, context: ServerCallContext): Promise<void> {
    await this.redis?.del(this.taskKey(taskId, context));
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    if (!this.redis) return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
    // Task shells are few and TTL-bound — a paged SCAN over the prefix is ample.
    const shells: Task[] = [];
    let cursor = '0';
    do {
      const [next, keys]: [string, string[]] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.prefix}:tasks:${taskScopeKey(context)}:*`,
        'COUNT',
        100,
      );
      cursor = next;
      for (const key of keys) {
        const raw: string | null = await this.redis.get(key);
        if (raw) shells.push(JSON.parse(raw) as Task);
      }
    } while (cursor !== '0');
    return listShells(shells, params);
  }

  async close(): Promise<void> {
    await this.redis?.quit?.();
  }
}
