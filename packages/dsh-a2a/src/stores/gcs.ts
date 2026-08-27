/**
 * GCS TaskStore for @a2a-js/sdk. `@google-cloud/storage` is an optional peer.
 *
 * Ported from the source project's packages/a2a-server/src/persistence/gcs.ts:
 *   tasks/{taskId}/metadata.json.gz  — gzipped task state (pre-sanitized by
 *                                      SanitizedTaskStore: no history)
 *   tasks/{taskId}/workspace.tar.gz  — tar of the task's workspace directory
 *
 * The workspace archive is written explicitly via `archiveWorkspace()` (not
 * wired to any lifecycle event yet — A2A tasks share one configured cwd, so a
 * per-task snapshot needs a per-task workspace story first).
 */

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Task } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';

export interface GcsTaskStoreConfig {
  bucket: string;
  /** Object key prefix, default 'tasks' (matches the source layout). */
  prefix?: string;
  /** Path to a service-account key file; omit to use ADC. */
  keyFilename?: string;
}

export class GcsTaskStore implements TaskStore {
  private bucket: any = null;
  private prefix: string;

  constructor(private config: GcsTaskStoreConfig) {
    this.prefix = config.prefix ?? 'tasks';
  }

  async init(): Promise<void> {
    const mod = await import('@google-cloud/storage');
    const storage = new (mod as any).Storage(
      this.config.keyFilename ? { keyFilename: this.config.keyFilename } : undefined,
    );
    this.bucket = storage.bucket(this.config.bucket);
  }

  async save(task: Task): Promise<void> {
    if (!this.bucket) return;
    await this.bucket
      .file(`${this.prefix}/${task.id}/metadata.json.gz`)
      .save(gzipSync(JSON.stringify(task)), { contentType: 'application/gzip', resumable: false });
  }

  async load(taskId: string): Promise<Task | undefined> {
    if (!this.bucket) return undefined;
    const file = this.bucket.file(`${this.prefix}/${taskId}/metadata.json.gz`);
    const [exists] = await file.exists();
    if (!exists) return undefined;
    const [buf] = await file.download();
    return JSON.parse(gunzipSync(buf).toString('utf8')) as Task;
  }

  /**
   * Tar + gzip the workspace directory to `tasks/{taskId}/workspace.tar.gz`.
   * TODO: replace the tar subprocess with a streaming tar library (e.g. `tar`)
   * to control inclusion and avoid shelling out.
   */
  async archiveWorkspace(taskId: string, cwd: string): Promise<void> {
    if (!this.bucket) return;
    const dir = await mkdtemp(join(tmpdir(), 'dsh-a2a-archive-'));
    const tarball = join(dir, 'workspace.tar.gz');
    try {
      await promisify(execFile)('tar', ['-czf', tarball, '-C', cwd, '.']);
      const dest = this.bucket.file(`${this.prefix}/${taskId}/workspace.tar.gz`);
      await pipeline(createReadStream(tarball), dest.createWriteStream());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
