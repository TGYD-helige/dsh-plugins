import {
  type ListTasksRequest,
  type ListTasksResponse,
  Role,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { listShells, MemoryTaskStore, SanitizedTaskStore, sanitizeTask } from './task-store.js';

const mocks = vi.hoisted(() => {
  class MockRedis {
    static instances: MockRedis[] = [];
    readonly calls = {
      set: [] as unknown[][],
      get: [] as string[],
      mget: 0,
      del: [] as string[],
      quit: 0,
    };
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
    async mget(...keys: string[]) {
      this.calls.mget += 1;
      return keys.map((key) => this.data.get(key) ?? null);
    }
    async del(key: string) {
      this.calls.del.push(key);
      return Number(this.data.delete(key));
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

const gcs = vi.hoisted(() => {
  const files = new Map<string, Buffer>();
  const activity = { active: 0, maxActive: 0 };
  const file = (name: string) => ({
    name,
    save: async (value: Buffer) => {
      files.set(name, value);
    },
    exists: async () => [files.has(name)],
    download: async () => {
      activity.active += 1;
      activity.maxActive = Math.max(activity.maxActive, activity.active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activity.active -= 1;
      return [files.get(name)];
    },
    delete: async () => {
      files.delete(name);
    },
  });
  class Storage {
    bucket() {
      return {
        file,
        getFiles: async ({ prefix }: { prefix: string }) => [
          [...files.keys()].filter((name) => name.startsWith(prefix)).map(file),
        ],
      };
    }
  }
  return { files, activity, Storage };
});
vi.mock('@google-cloud/storage', () => ({ Storage: gcs.Storage }));

import { GcsTaskStore } from './stores/gcs.js';
import { RedisTaskStore } from './stores/redis.js';

const ctx = new ServerCallContext();
afterEach(() => vi.useRealTimers());

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
  it('keeps task history and artifacts at state changes', () => {
    const clean = sanitizeTask(task(TaskState.TASK_STATE_WORKING));
    expect(clean.history.map((message) => message.messageId)).toEqual(['m1']);
    expect(clean.artifacts).toHaveLength(1);
    expect(clean.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(clean.metadata).toEqual({ dshAgent: { kind: 'state-change' } });
  });
});

it('keeps memory task shells scoped to their A2A tenant', async () => {
  const store = new MemoryTaskStore();
  const a = new ServerCallContext({ tenant: 'a' });
  const b = new ServerCallContext({ tenant: 'b' });
  await store.save(task(TaskState.TASK_STATE_WORKING), a);
  expect(await store.load('t1', b)).toBeUndefined();
  expect((await store.list(listParams(), a)).totalSize).toBe(1);
  await store.delete('t1', a);
  expect(await store.load('t1', a)).toBeUndefined();
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
    delete: Mock<(id: string, c: ServerCallContext) => Promise<void>>;
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
      delete: vi.fn(async () => {}),
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

  it('persists task history at a state change', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    const saved = inner.save.mock.calls[0][0];
    expect(saved.history.map((message) => message.messageId)).toEqual(['m1']);
    expect(saved.artifacts).toHaveLength(1);
  });

  it('persists queued admission checkpoints without a state transition', async () => {
    const backend = new MemoryTaskStore();
    const store = new SanitizedTaskStore(backend);
    const submitted = task(TaskState.TASK_STATE_SUBMITTED);
    await store.save(submitted, ctx);
    const second = { ...submitted.history[0], messageId: 'queued-second' };
    await store.checkpoint({ ...submitted, history: [...submitted.history, second] }, ctx);
    const restored = new SanitizedTaskStore(backend);
    expect((await restored.load('t1', ctx))?.history.map((message) => message.messageId)).toEqual([
      'm1',
      'queued-second',
    ]);
  });

  it('returns running history to a resubscriber', async () => {
    const store = new SanitizedTaskStore(new MemoryTaskStore());
    await store.save(task(TaskState.TASK_STATE_SUBMITTED), ctx);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    const resumed = await store.load('t1', ctx);
    expect(resumed?.history?.map((message) => message.messageId)).toEqual(['m1']);
    expect(
      (await store.list(listParams(), ctx)).tasks[0].history.map((message) => message.messageId),
    ).toEqual(['m1']);
  });

  it('shows the complete text so far when polling a working task', async () => {
    const store = new SanitizedTaskStore(new MemoryTaskStore());
    const running = task(TaskState.TASK_STATE_WORKING);
    const first = {
      ...running.history[0],
      messageId: 'answer',
      role: Role.ROLE_AGENT,
      parts: [{ ...running.history[0].parts[0], content: { $case: 'text' as const, value: 'A' } }],
    };
    running.history.push(first);
    running.status!.message = first;
    await store.save(running, ctx);
    const second = (await store.load('t1', ctx))!;
    second.status!.message = {
      ...first,
      parts: [{ ...first.parts[0], content: { $case: 'text', value: 'B' } }],
    };
    await store.save(second, ctx);
    const polled = await store.load('t1', ctx);
    expect(
      polled?.history.find((message) => message.messageId === 'answer')?.parts[0].content,
    ).toEqual({ $case: 'text', value: 'AB' });
  });

  it('recovers a settled reply through a fresh store wrapper', async () => {
    const inner = new MemoryTaskStore();
    const first = new SanitizedTaskStore(inner);
    const settled = task(TaskState.TASK_STATE_INPUT_REQUIRED);
    settled.status!.message = {
      ...settled.history[0],
      messageId: 'answer',
      role: Role.ROLE_AGENT,
      parts: [
        {
          ...settled.history[0].parts[0],
          content: { $case: 'text', value: 'complete answer' },
        },
      ],
    };
    await first.save(settled, ctx);
    const second = new SanitizedTaskStore(inner);
    expect((await second.load('t1', ctx))?.history?.map((message) => message.messageId)).toEqual([
      'm1',
      'answer',
    ]);
  });

  it('accepts an omitted context from direct backend callers', async () => {
    const store = new SanitizedTaskStore(inner);
    const missing = undefined as unknown as ServerCallContext;
    await store.save(task(TaskState.TASK_STATE_WORKING), missing);
    inner.load.mockResolvedValue(inner.saved[0]);
    expect((await store.load('t1', missing))?.history?.map((message) => message.messageId)).toEqual(
      ['m1'],
    );
  });

  it('does not let late SDK saves reopen a terminal task', async () => {
    const store = new SanitizedTaskStore(inner);
    await store.checkpoint(task(TaskState.TASK_STATE_CANCELED), ctx);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    await store.save(task(TaskState.TASK_STATE_COMPLETED), ctx);
    expect(inner.saved.map((entry) => entry.status?.state)).toEqual([
      TaskState.TASK_STATE_CANCELED,
    ]);
  });

  it('expires terminal reopen guards instead of retaining them forever', async () => {
    vi.useFakeTimers();
    const store = new SanitizedTaskStore(inner);
    await store.checkpoint(task(TaskState.TASK_STATE_CANCELED), ctx);
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    expect(inner.saved.map((entry) => entry.status?.state)).toEqual([
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_WORKING,
    ]);
  });

  it('refreshes repeated terminal guards in expiry order', async () => {
    vi.useFakeTimers();
    const hour = 60 * 60 * 1000;
    const store = new SanitizedTaskStore(inner);
    const first = task(TaskState.TASK_STATE_CANCELED, { id: 'first' });
    await store.checkpoint(first, ctx);
    await vi.advanceTimersByTimeAsync(hour);
    await store.checkpoint(task(TaskState.TASK_STATE_FAILED, { id: 'second' }), ctx);
    await vi.advanceTimersByTimeAsync(hour);
    await store.checkpoint(first, ctx);
    await vi.advanceTimersByTimeAsync(23 * hour);
    await store.checkpoint(task(TaskState.TASK_STATE_CANCELED, { id: 'third' }), ctx);

    await store.save(task(TaskState.TASK_STATE_WORKING, { id: 'first' }), ctx);
    await store.save(task(TaskState.TASK_STATE_WORKING, { id: 'second' }), ctx);
    expect(
      inner.saved
        .filter((entry) => entry.status?.state === TaskState.TASK_STATE_WORKING)
        .map((entry) => entry.id),
    ).toEqual(['second']);
  });

  it('keeps the later terminal write registered until backend shutdown drains it', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    inner.save
      .mockImplementationOnce(async () => firstGate)
      .mockImplementationOnce(async () => secondGate);
    const store = new SanitizedTaskStore(inner);
    const first = store.save(task(TaskState.TASK_STATE_CANCELED), ctx);
    await vi.waitFor(() => expect(inner.save).toHaveBeenCalledOnce());
    const second = store.save(task(TaskState.TASK_STATE_CANCELED), ctx);
    releaseFirst();
    await first;
    await vi.waitFor(() => expect(inner.save).toHaveBeenCalledTimes(2));
    const closed = store.close();
    try {
      await Promise.resolve();
      expect(inner.close).not.toHaveBeenCalled();
    } finally {
      releaseSecond();
      await Promise.all([second, closed]);
    }
  });

  it('drains pending writes before closing the backend', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    inner.save.mockImplementationOnce(async () => gate);
    const store = new SanitizedTaskStore(inner);
    const pending = store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    await vi.waitFor(() => expect(inner.save).toHaveBeenCalledOnce());
    const closed = store.close();
    try {
      await Promise.resolve();
      expect(inner.close).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([pending, closed]);
    }
    expect(inner.close).toHaveBeenCalledOnce();
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

  it('waits for a pending save and prevents a cleared task from reappearing', async () => {
    let finish!: () => void;
    inner.save.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const store = new SanitizedTaskStore(inner);
    const writing = store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    const deleting = store.delete('t1', ctx);
    await Promise.resolve();
    expect(inner.delete).not.toHaveBeenCalled();
    finish();
    await Promise.all([writing, deleting]);
    await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx);
    store.suppress('t2');
    await store.save(task(TaskState.TASK_STATE_FAILED, { id: 't2' }), ctx);
    expect(inner.delete).toHaveBeenCalledWith('t1', ctx);
    expect(inner.save).toHaveBeenCalledTimes(1);
  });
});

describe('RedisTaskStore', () => {
  beforeEach(() => {
    mocks.MockRedis.instances = [];
  });

  it('writes scoped task JSON with a TTL and reads it back', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379', ttlSeconds: 60 });
    await store.init();
    const redis = mocks.MockRedis.instances[0];
    expect(redis.url).toBe('redis://example:6379');

    const value = task(TaskState.TASK_STATE_WORKING);
    await store.save(value, ctx);
    // RedisTaskStore persists exactly what it is given — sanitizing is the
    // SanitizedTaskStore wrapper's job.
    const key = redis.calls.set[0][0] as string;
    expect(key).toMatch(/^a2a:tasks:[a-f0-9]{64}:t1$/);
    expect(redis.calls.set[0]).toEqual([key, JSON.stringify(value), 'EX', 60]);

    const loaded = await store.load('t1', ctx);
    expect(loaded).toEqual(value);
    expect(await store.load('missing', ctx)).toBeUndefined();
    await store.delete('t1', ctx);
    expect(redis.calls.del).toEqual([key]);
    expect(await store.load('t1', ctx)).toBeUndefined();

    await store.close();
    expect(redis.calls.quit).toBe(1);
  });

  it('honors a custom key prefix', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379', keyPrefix: 'x' });
    await store.init();
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    expect(mocks.MockRedis.instances[0].calls.set[0][0]).toMatch(/^x:tasks:[a-f0-9]{64}:t1$/);
  });

  it('lists shells through the shared filter/sort/paginate path', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379' });
    await store.init();
    await store.save(task(TaskState.TASK_STATE_WORKING, { id: 't1' }), ctx);
    await store.save(task(TaskState.TASK_STATE_CANCELED, { id: 't2', contextId: 'c2' }), ctx);
    const all = await store.list(listParams(), ctx);
    expect(all.totalSize).toBe(2);
    const filtered = await store.list(listParams({ contextId: 'c2' }), ctx);
    expect(filtered.tasks.map((t) => t.id)).toEqual(['t2']);
    const redis = mocks.MockRedis.instances[0];
    expect(redis.calls.mget).toBeGreaterThan(0);
    expect(redis.calls.get).toHaveLength(0);
  });

  it('does not expose stored history across tenants', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379' });
    await store.init();
    const other = new ServerCallContext({ tenant: 'other' });
    await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx);
    expect(await store.load('t1', other)).toBeUndefined();
    expect((await store.list(listParams(), other)).tasks).toEqual([]);
    expect((await store.list(listParams(), ctx)).tasks).toHaveLength(1);
  });

  it('no-ops before init()', async () => {
    const store = new RedisTaskStore({ url: 'redis://example:6379' });
    await store.save(task(TaskState.TASK_STATE_WORKING), ctx);
    expect(await store.load('t1', ctx)).toBeUndefined();
    expect((await store.list(listParams(), ctx)).tasks).toEqual([]);
  });
});

describe('GcsTaskStore', () => {
  it('keeps stored task history in the caller scope', async () => {
    gcs.files.clear();
    const store = new GcsTaskStore({ bucket: 'test' });
    await store.init();
    const other = new ServerCallContext({ tenant: 'other' });
    await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED), ctx);
    expect(await store.load('t1', other)).toBeUndefined();
    expect((await store.list(listParams(), other)).tasks).toEqual([]);
    expect((await store.load('t1', ctx))?.history[0].messageId).toBe('m1');
  });

  it('downloads list snapshots with bounded concurrency', async () => {
    gcs.files.clear();
    gcs.activity.maxActive = 0;
    const store = new GcsTaskStore({ bucket: 'test' });
    await store.init();
    for (let index = 0; index < 20; index++)
      await store.save(task(TaskState.TASK_STATE_INPUT_REQUIRED, { id: `t${index}` }), ctx);
    expect((await store.list(listParams(), ctx)).totalSize).toBe(20);
    expect(gcs.activity.maxActive).toBeGreaterThan(1);
    expect(gcs.activity.maxActive).toBeLessThanOrEqual(16);
  });
});
