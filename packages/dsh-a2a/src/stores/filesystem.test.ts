import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { expect, it, vi } from 'vitest';
import { FilesystemTaskStore } from './filesystem.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      vi.spyOn(handle, 'readFile');
      return handle;
    }),
    readFile: vi.fn(fs.readFile),
  };
});

it('discovers persisted candidates in one summary scan without hydrating task pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-recovery-'));
  try {
    const user = { userName: 'owner', isAuthenticated: true };
    const call = new ServerCallContext({ tenant: 'Tenant', user });
    const store = new FilesystemTaskStore({ root });
    for (let i = 0; i < 105; i++)
      await store.save(
        Task.fromJSON({
          id: `t${i}`,
          contextId: i < 100 ? 'done' : 'pending',
          status: { state: i < 100 ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_SUBMITTED' },
          metadata: { content: 'x'.repeat(100_000) },
        }),
        call,
      );
    const restored = new FilesystemTaskStore({ root });
    vi.mocked(open).mockClear();
    vi.mocked(readFile).mockClear();
    expect(await restored.recoveryCandidates(call)).toEqual(['pending']);
    expect(open).toHaveBeenCalledTimes(105);
    for (const result of vi.mocked(open).mock.results)
      expect((await result.value).readFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(
      await restored.recoveryCandidates(new ServerCallContext({ tenant: 'tenant', user })),
    ).toEqual([]);
    expect(await restored.recoveryCandidates(new ServerCallContext({ tenant: 'Tenant' }))).toEqual(
      [],
    );
    await store.delete('t104', call);
    expect(await restored.recoveryCandidates(call)).toEqual(['pending']);
    for (let i = 100; i < 104; i++) await store.delete(`t${i}`, call);
    expect(await restored.recoveryCandidates(call)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reads only page snapshots while preserving filters and cross-instance updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-list-'));
  try {
    const context = new ServerCallContext();
    const first = new FilesystemTaskStore({ root });
    for (let i = 0; i < 20; i++) {
      await first.save(
        Task.fromJSON({
          id: `t${i}`,
          contextId: i < 3 ? 'wanted' : 'other',
          status: {
            state: 'TASK_STATE_COMPLETED',
            timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
          },
          metadata: { content: 'x'.repeat(100_000) },
        }),
        context,
      );
    }
    const restored = new FilesystemTaskStore({ root });
    vi.mocked(readFile).mockClear();
    const page = await restored.list({ contextId: 'wanted', pageSize: 2 } as never, context);
    expect(page.tasks.map((task) => task.id)).toEqual(['t2', 't1']);
    expect(page.totalSize).toBe(3);
    expect(page.tasks[0].metadata?.content).toHaveLength(100_000);
    expect(readFile).toHaveBeenCalledTimes(2);
    await first.delete('t0', context);
    expect((await restored.list({ contextId: 'wanted' } as never, context)).totalSize).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('lists legacy JSON snapshots and keeps new files readable by the old JSON decoder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-legacy-'));
  try {
    const context = new ServerCallContext();
    const store = new FilesystemTaskStore({ root });
    const task = Task.fromJSON({
      id: 'legacy',
      contextId: 'old',
      status: { state: 'TASK_STATE_SUBMITTED' },
    });
    await store.save(task, context);
    const directory = join(root, (await readdir(root))[0]);
    const file = join(directory, (await readdir(directory))[0]);
    expect(Task.fromJSON(JSON.parse(await readFile(file, 'utf8')))).toEqual(task);
    await writeFile(file, JSON.stringify(Task.toJSON(task)));
    const restored = new FilesystemTaskStore({ root });
    expect((await restored.list({ contextId: 'old' } as never, context)).tasks).toEqual([task]);
    expect(await restored.recoveryCandidates(context)).toEqual(['old']);
    await writeFile(
      file,
      JSON.stringify({ _dshTaskList: 'broken', ...(Task.toJSON(task) as object) }),
    );
    expect(await restored.recoveryCandidates(context)).toEqual(['old']);
    await writeFile(file, '{broken JSON');
    await expect(restored.recoveryCandidates(context)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains scoped snapshots across store instances with listing and deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-tasks-'));
  try {
    const context = new ServerCallContext({ tenant: 'one' });
    const first = new FilesystemTaskStore({ root });
    const task = Task.fromJSON({
      id: '../../outside',
      contextId: 'conversation',
      status: { state: 'TASK_STATE_SUBMITTED' },
    });
    await first.save(task, context);
    const restored = new FilesystemTaskStore({ root });
    expect(await restored.load(task.id, context)).toEqual(task);
    expect(await restored.load(task.id, new ServerCallContext({ tenant: 'two' }))).toBeUndefined();
    expect((await restored.list({ contextId: 'conversation' } as never, context)).tasks).toEqual([
      task,
    ]);
    await restored.delete(task.id, context);
    expect(await first.load(task.id, context)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('falls back safely when a UTF-8 summary exceeds the bounded prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-large-summary-'));
  try {
    const context = new ServerCallContext();
    const task = Task.fromJSON({
      id: 'large',
      contextId: '长'.repeat(4000),
      status: { state: 'TASK_STATE_SUBMITTED' },
    });
    const store = new FilesystemTaskStore({ root });
    await store.save(task, context);
    expect(
      (
        await new FilesystemTaskStore({ root }).list(
          { contextId: task.contextId } as never,
          context,
        )
      ).tasks,
    ).toEqual([task]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
