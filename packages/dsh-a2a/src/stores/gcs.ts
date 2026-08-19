/**
 * GCS TaskStore for @a2a-js/sdk. `@google-cloud/storage` is an optional peer.
 *
 * Ported from the source project's packages/a2a-server/src/persistence/gcs.ts:
 *   tasks/{taskId}/metadata.json.gz  — gzipped task metadata
 *   tasks/{taskId}/workspace.tar.gz  — tar of the task's workspace directory
 *
 * The workspace archive is written explicitly via `archiveWorkspace()` (e.g.
 * on task completion), not on every save — the source project wrapped this
 * store in a NoOpTaskStore so SDK-driven saves skip the re-upload; do the
 * same or call archiveWorkspace from the terminal-event path.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { Task, TaskStore } from '@a2a-js/sdk/server'

export interface GcsTaskStoreConfig {
  bucket: string
  /** Object key prefix, default 'tasks' (matches the source layout). */
  prefix?: string
  /** Path to a service-account key file; omit to use ADC. */
  keyFilename?: string
}

export class GcsTaskStore implements TaskStore {
  private bucket: any = null
  private prefix: string

  constructor(private config: GcsTaskStoreConfig) {
    this.prefix = config.prefix ?? 'tasks'
  }

  async init(): Promise<void> {
    const mod = await import('@google-cloud/storage')
    const storage = new (mod as any).Storage(
      this.config.keyFilename ? { keyFilename: this.config.keyFilename } : undefined,
    )
    this.bucket = storage.bucket(this.config.bucket)
  }

  async save(task: Task): Promise<void> {
    if (!this.bucket) return
    const { gzipSync } = await import('node:zlib')
    await this.bucket
      .file(`${this.prefix}/${task.id}/metadata.json.gz`)
      .save(gzipSync(JSON.stringify(task)), { contentType: 'application/gzip', resumable: false })
  }

  async load(taskId: string): Promise<Task | undefined> {
    if (!this.bucket) return undefined
    const file = this.bucket.file(`${this.prefix}/${taskId}/metadata.json.gz`)
    const [exists] = await file.exists()
    if (!exists) return undefined
    const [buf] = await file.download()
    const { gunzipSync } = await import('node:zlib')
    return JSON.parse(gunzipSync(buf).toString('utf8')) as Task
  }

  /**
   * Tar + gzip the workspace directory to `tasks/{taskId}/workspace.tar.gz`.
   * TODO: replace the tar subprocess with a streaming tar library (e.g. `tar`)
   * to control inclusion and avoid shelling out.
   */
  async archiveWorkspace(taskId: string, cwd: string): Promise<void> {
    if (!this.bucket) return
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'dsh-a2a-archive-'))
    const tarball = join(dir, 'workspace.tar.gz')
    try {
      await promisify(execFile)('tar', ['-czf', tarball, '-C', cwd, '.'])
      const dest = this.bucket.file(`${this.prefix}/${taskId}/workspace.tar.gz`)
      await pipeline(createReadStream(tarball), dest.createWriteStream())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
