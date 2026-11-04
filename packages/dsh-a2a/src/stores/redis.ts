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
import { type ManagedTaskStore, recoveryContextIds, taskScopeKey } from '../task-store.js';
import {
  LIST_PREFIX_BYTES,
  loadTaskPage,
  serializeTaskSnapshot,
  snapshotListShell,
  taskListShell,
} from './listing.js';

function parseSnapshot(raw: string): Task {
  const { _dshTaskList: _, ...task } = JSON.parse(raw);
  return task as Task;
}

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
    await this.redis.set(
      this.taskKey(task.id, context),
      serializeTaskSnapshot(task),
      'EX',
      this.ttl,
    );
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    if (!this.redis) return undefined;
    const raw: string | null = await this.redis.get(this.taskKey(taskId, context));
    return raw ? parseSnapshot(raw) : undefined;
  }

  async delete(taskId: string, context: ServerCallContext): Promise<void> {
    await this.redis?.del(this.taskKey(taskId, context));
  }

  private async shells(context: ServerCallContext): Promise<Task[]> {
    if (!this.redis) return [];
    // SCAN only names; bounded prefixes supply the lightweight list summaries.
    const shells: Task[] = [];
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const [next, scanned]: [string, string[]] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.prefix}:tasks:${taskScopeKey(context)}:*`,
        'COUNT',
        100,
      );
      cursor = next;
      // SCAN may repeat keys during rehashing, including within one batch.
      const keys = scanned.filter((key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (keys.length) {
        const prefixes: Array<[Error | null, string]> = await this.redis
          .pipeline(keys.map((key) => ['getrange', key, 0, LIST_PREFIX_BYTES - 1]))
          .exec();
        const legacy: string[] = [];
        prefixes.forEach(([error, prefix], index) => {
          if (error) throw error;
          if (!prefix) return; // Expired since SCAN.
          const shell = snapshotListShell(prefix);
          if (shell) shells.push(shell);
          else legacy.push(keys[index]);
        });
        if (legacy.length) {
          const raws: Array<string | null> = await this.redis.mget(...legacy);
          for (const raw of raws) if (raw) shells.push(taskListShell(parseSnapshot(raw)));
        }
      }
    } while (cursor !== '0');
    return shells;
  }

  async recoveryCandidates(context: ServerCallContext): Promise<string[]> {
    if (!this.redis) throw new Error('[dsh-a2a] Redis TaskStore is not initialized.');
    return recoveryContextIds(await this.shells(context));
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    if (!this.redis) return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
    return loadTaskPage(await this.shells(context), params, async (ids) => {
      const raws: Array<string | null> = await this.redis.mget(
        ...ids.map((id) => this.taskKey(id, context)),
      );
      return raws.map((raw) => (raw ? parseSnapshot(raw) : undefined));
    });
  }

  async close(): Promise<void> {
    await this.redis?.quit?.();
  }
}
