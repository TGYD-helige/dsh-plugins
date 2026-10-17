/** Local task snapshots, retained alongside the DSH session log. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type ListTasksRequest, type ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import { listShells, type ManagedTaskStore, taskScopeKey } from '../task-store.js';

export class FilesystemTaskStore implements ManagedTaskStore {
  private readonly root: string;
  constructor(config: { root: string }) {
    if (!config.root) throw new Error('[dsh-a2a] filesystem.root is required.');
    this.root = resolve(config.root);
  }
  private directory(context: ServerCallContext): string {
    return join(this.root, taskScopeKey(context));
  }
  private path(id: string, context: ServerCallContext): string {
    return join(this.directory(context), `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const directory = this.directory(context);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(Task.toJSON(task)));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path(task.id, context));
      // Windows cannot open directory handles through fs.open.
      if (process.platform !== 'win32') {
        const dir = await open(directory, 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async load(id: string, context: ServerCallContext): Promise<Task | undefined> {
    try {
      return Task.fromJSON(JSON.parse(await readFile(this.path(id, context), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  async delete(id: string, context: ServerCallContext): Promise<void> {
    await rm(this.path(id, context), { force: true });
  }
  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    let files: string[];
    try {
      files = await readdir(this.directory(context));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files = [];
    }
    const tasks: Task[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      try {
        tasks.push(
          Task.fromJSON(JSON.parse(await readFile(join(this.directory(context), file), 'utf8'))),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return listShells(tasks, params);
  }
}
