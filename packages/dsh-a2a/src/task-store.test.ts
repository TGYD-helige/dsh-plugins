import type { Task } from '@a2a-js/sdk';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { SanitizedTaskStore, sanitizeTask } from './task-store.js';

const mocks = vi.hoisted(() => {
  class MockRedis {
    static instances: MockRedis[] = [];
    readonly calls = { set: [] as unknown[][], get: [] as string[], quit: 0 };
    private readonly data = new Map<string, string>();
    constructor(readonly url: string) {
      MockRedis.instances.push(this);
    }
    async set(...args: unknown[]) {
      this.calls.set.push(args);
      this.data.set(args[0] as string, args[1] as string);
      return 'OK';
    }
    async get(key: string) {
      this.calls.get.push(key);
      return this.data.get(key) ?? null;
    }
    async quit() {
      this.calls.quit += 1;
    }
  }
  return { MockRedis };
});

vi.mock('ioredis', () => ({ Redis: mocks.MockRedis, default: mocks.MockRedis }));

import { RedisTaskStore } from './stores/redis.js';

const task = (state: string, extra: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't1',
  contextId: 'c1',
  status: { state: state as Task['status']['state'], timestamp: new Date().toISOString() },
  history: [
    { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
  ],
  artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: 'blob' }] }],
  metadata: { dshAgent: { kind: 'state-change' } },
  ...extra,
});

describe('sanitizeTask', () => {
  it('keeps state and metadata, strips history and artifacts', () => {
    const clean = sanitizeTask(task('working'));
    expect(clean.history).toEqual([]);
    expect(clean.artifacts).toEqual([]);
    expect(clean.status.state).toBe('working');
    expect(clean.metadata).toEqual({ dshAgent: { kind: 'state-change' } });
  });
});

describe('SanitizedTaskStore', () => {
  let inner: {
    saved: Task[];
    save: Mock<(t: Task) => Promise<void>>;
    load: Mock<(id: string) => Promise<Task | undefined>>;
    init: Mock<() => Promise<void>>;
    close: Mock<() => Promise<void>>;
  };

  beforeEach(() => {
    inner = {
      saved: [],
      save: vi.fn(async (t: Task) => {
        inner.saved.push(t);
      }),
      load: vi.fn(async () => undefined),
      init: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
  });

  it('saves only on state transitions', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.save(task('submitted'));
    await store.save(task('working'));
    await store.save(task('working'));
    await store.save(task('working'));
    await store.save(task('input-required'));
    expect(inner.save).toHaveBeenCalledTimes(3);
    expect(inner.save.mock.calls.map(([t]) => (t as Task).status.state)).toEqual([
      'submitted',
      'working',
      'input-required',
    ]);
  });

  it('persists the sanitized shell, not the live task', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.save(task('working'));
    const saved = inner.save.mock.calls[0][0] as Task;
    expect(saved.history).toEqual([]);
    expect(saved.artifacts).toEqual([]);
  });

  it('passes init/close/load through to the inner store', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.init();
    await store.load('t1');
    await store.close();
    expect(inner.init).toHaveBeenCalledTimes(1);
    expect(inner.load).toHaveBeenCalledWith('t1');
    expect(inner.close).toHaveBeenCalledTimes(1);
  });
});

describe('RedisTaskStore', () => {
  beforeEach(() => {
    mocks.MockRedis.instances = [];
  });

  it('writes the task JSON under a2a:tasks:{id} with a TTL and reads it back', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379', ttlSeconds: 60 });
    await store.init();
    const redis = mocks.MockRedis.instances[0];
    expect(redis.url).toBe('redis://example:6379');

    const value = task('working');
    await store.save(value);
    // RedisTaskStore persists exactly what it is given — sanitizing is the
    // SanitizedTaskStore wrapper's job.
    expect(redis.calls.set[0]).toEqual(['a2a:tasks:t1', JSON.stringify(value), 'EX', 60]);

    const loaded = await store.load('t1');
    expect(loaded).toEqual(value);
    expect(await store.load('missing')).toBeUndefined();

    await store.close();
    expect(redis.calls.quit).toBe(1);
  });

  it('honors a custom key prefix', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379', keyPrefix: 'x' });
    await store.init();
    await store.save(task('working'));
    expect(mocks.MockRedis.instances[0].calls.set[0][0]).toBe('x:tasks:t1');
  });

  it('no-ops before init()', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379' });
    await store.save(task('working'));
    expect(await store.load('t1')).toBeUndefined();
  });
});
