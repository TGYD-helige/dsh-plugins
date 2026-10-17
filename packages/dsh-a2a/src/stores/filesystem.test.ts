import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { expect, it } from 'vitest';
import { FilesystemTaskStore } from './filesystem.js';

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
