import {
  type ListTasksRequest,
  type ListTasksResponse,
  Role,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { listShells, SanitizedTaskStore, sanitizeTask } from './task-store.js';

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
    async scan(_cursor: string, ...args: unknown[]) {
      const match = args[1] as string;
      const pattern = new RegExp(`^${String(match).replace(/\*/g, '.*')}$`);
      const keys = [...this.data.keys()].filter((k) => pattern.test(k));
      return ['0', keys] as [string, string[]];
    }
    async quit() {
      this.calls.quit += 1;
    }
  }
  return { MockRedis };
});

vi.mock('ioredis', () => ({ Redis: mocks.MockRedis, default: mocks.MockRedis }));

import { RedisTaskStore } from './stores/redis.js';

const ctx = new ServerCallContext();

const task = (state: TaskState, extra: Partial<Task> = {}): Task => ({
  id: 't1',
  contextId: 'c1',
  status: { state, message: undefined, timestamp: new Date().toISOString() },
  history: [
    {
      messageId: 'm1',
      contextId: 'c1',
      taskId: 't1',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'text', value: 'hi' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
  ],
  artifacts: [
    {
      artifactId: 'a1',
      name: '',
      description: '',
      parts: [
        {
          content: { $case: 'text', value: 'blob' },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        },
      ],
      metadata: undefined,
      extensions: [],
    },
  ],
  metadata: { dshAgent: { kind: 'state-change' } },
  ...extra,
});

const listParams = (extra: Partial<ListTasksRequest> = {}): ListTasksRequest => ({
  tenant: '',
  contextId: '',
  status: TaskState.TASK_STATE_UNSPECIFIED,
  pageToken: '',
  statusTimestampAfter: undefined,
  ...extra,
});

describe('sanitizeTask', () => {
  it('keeps state and metadata, strips history and artifacts', () => {
    const clean = sanitizeTask(task(TaskState.TASK_STATE_WORKING));
    expect(clean.history).toEqual([]);
    expect(clean.artifacts).toEqual([]);
    expect(clean.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(clean.metadata).toEqual({ dshAgent: { kind: 'state-change' } });
  });
});

describe('listShells', () => {
  const shells = [
    task(TaskState.TASK_STATE_WORKING, {
      id: 'a',
      contextId: 'c1',
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: undefined,
        timestamp: '2026-01-01T00:00:01Z',
      },
    }),
    task(TaskState.TASK_STATE_INPUT_REQUIRED, {
      id: 'b',
      contextId: 'c1',
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: undefined,
        timestamp: '2026-01-01T00:00:03Z',
      },
    }),
    task(TaskState.TASK_STATE_CANCELED, {
      id: 'c',
      contextId: 'c2',
      status: {
        state: TaskState.TASK_STATE_CANCELED,
        message: undefined,
        timestamp: '2026-01-01T00:00:02Z',
      },
    }),
  ];

  it('sorts newest-first and reports totals', () => {
    const page = listShells(shells, listParams());
    expect(page.tasks.map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(page.totalSize).toBe(3);
    expect(page.nextPageToken).toBe('');
  });

  it('filters by contextId and status', () => {
    expect(listShells(shells, listParams({ contextId: 'c1' })).tasks.map((t) => t.id)).toEqual([
      'b',
      'a',
    ]);
    expect(
      listShells(shells, listParams({ status: TaskState.TASK_STATE_CANCELED })).tasks.map(
        (t) => t.id,
      ),
    ).toEqual(['c']);
  });

  it('filters by statusTimestampAfter (strictly greater, mirroring the SDK)', () => {
    const page = listShells(shells, listParams({ statusTimestampAfter: '2026-01-01T00:00:02Z' }));
    expect(page.tasks.map((t) => t.id)).toEqual(['b']);
  });

  it('paginates with a cursor', () => {
    const page1 = listShells(shells, listParams({ pageSize: 2 }));
    expect(page1.tasks.map((t) => t.id)).toEqual(['b', 'c']);
    expect(page1.nextPageToken).not.toBe('');
    const page2 = listShells(shells, listParams({ pageSize: 2, pageToken: page1.nextPageToken }));
    expect(page2.tasks.map((t) => t.id)).toEqual(['a']);
    expect(page2.nextPageToken).toBe('');
  });

  it('throws on a malformed page token, returns an empty page for an unknown cursor', () => {
    expect(() =>
      listShells(shells, listParams({ pageToken: Buffer.from('no-separator').toString('base64') })),
    ).toThrow('invalid page token');
    const page = listShells(
      shells,
      listParams({ pageToken: Buffer.from('2020-01-01|ghost').toString('base64') }),
    );
    expect(page.tasks).toEqual([]);
    expect(page.totalSize).toBe(3);
  });

  it('strips artifacts unless includeArtifacts is set', () => {
    expect(listShells(shells, listParams()).tasks[0].artifacts).toEqual([]);
    expect(
      listShells(shells, listParams({ includeArtifacts: true })).tasks[0].artifacts,
    ).toHaveLength(1);
  });
});

describe('SanitizedTaskStore', () => {
  let inner: {
    saved: Task[];
    save: Mock<(t: Task, c: ServerCallContext) => Promise<void>>;
    load: Mock<(id: string, c: ServerCallContext) => Promise<Task | undefined>>;
    list: Mock<(p: ListTasksRequest, c: ServerCallContext) => Promise<ListTasksResponse>>;
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
      list: vi.fn(async () => ({ tasks: [], nextPageToken: '', pageSize: 50, totalSize: 0 })),
      init: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
  });

  it('saves only on state transitions', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.save(task(TaskState.TASK_STATE_SUBMITTED), ctx);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx);
    expect(inner.save).toHaveBeenCalledTimes(3);
    expect(inner.save.mock.calls.map(([t]) => t.status?.state)).toEqual([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_INPUT_REQUIRED,
    ]);
  });

  it('persists the sanitized shell, not the live task', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    const saved = inner.save.mock.calls[0][0];
    expect(saved.history).toEqual([]);
    expect(saved.artifacts).toEqual([]);
  });

  it('passes init/close/load through to the inner store', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.init();
    await store.load('t1', ctx);
    await store.close();
    expect(inner.init).toHaveBeenCalledTimes(1);
    expect(inner.load).toHaveBeenCalledWith('t1', ctx);
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

    const value = task(TaskState.TASK_STATE_WORKING);
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
    await store.save(task(TaskState.TASK_STATE_WORKING));
    expect(mocks.MockRedis.instances[0].calls.set[0][0]).toBe('x:tasks:t1');
  });

  it('lists shells through the shared filter/sort/paginate path', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379' });
    await store.init();
    await store.save(task(TaskState.TASK_STATE_WORKING, { id: 't1' }));
    await store.save(task(TaskState.TASK_STATE_CANCELED, { id: 't2', contextId: 'c2' }));
    const all = await store.list(listParams());
    expect(all.totalSize).toBe(2);
    const filtered = await store.list(listParams({ contextId: 'c2' }));
    expect(filtered.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('no-ops before init()', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379' });
    await store.save(task(TaskState.TASK_STATE_WORKING));
    expect(await store.load('t1')).toBeUndefined();
    expect((await store.list(listParams())).tasks).toEqual([]);
  });
});
