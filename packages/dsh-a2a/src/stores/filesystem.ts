/** Local task snapshots, retained alongside the DSH session log. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type ListTasksRequest, type ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import { type ManagedTaskStore, taskScopeKey } from '../task-store.js';
import {
  LIST_PREFIX_BYTES,
  loadTaskPage,
  serializeTaskSnapshot,
  snapshotListShell,
  taskListShell,
} from './listing.js';

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
        await file.writeFile(serializeTaskSnapshot(task, Task.toJSON(task)));
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
    const snapshots = files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
    const shells: Task[] = [];
    for (let start = 0; start < snapshots.length; start += 16) {
      const batch = await Promise.all(
        snapshots.slice(start, start + 16).map(async (file) => {
          const path = join(this.directory(context), file);
          try {
            const handle = await open(path, 'r');
            let shell: Task | undefined;
            try {
              const prefix = Buffer.alloc(LIST_PREFIX_BYTES);
              const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
              shell = snapshotListShell(prefix.toString('utf8', 0, bytesRead));
              // Read legacy or oversized headers through the same open inode.
              if (!shell)
                shell = taskListShell(Task.fromJSON(JSON.parse(await handle.readFile('utf8'))));
            } finally {
              await handle.close();
            }
            return shell;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }),
      );
      for (const shell of batch) if (shell) shells.push(shell);
    }
    return loadTaskPage(shells, params, (ids) =>
      Promise.all(ids.map((id) => this.load(id, context))),
    );
  }
}
