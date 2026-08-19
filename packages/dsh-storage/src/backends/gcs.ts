/**
 * GCS archive backend. `@google-cloud/storage` is an optional peer dep.
 *
 * - Message/session rows are written as JSON objects under
 *   `sessions/{sessionId}/messages/{messageId}.json`.
 * - On `session/disposed`, `archiveWorkspace` tars the session's workspace
 *   directory to `sessions/{sessionId}/workspace.tar.gz`
 *   (same shape as the source project's GCSTaskStore).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { MessageRow, SessionRow, StorageBackend } from '../types.js'

export interface GcsBackendConfig {
  bucket: string
  /** Object key prefix, default 'dsh' */
  prefix?: string
  /** Path to a service-account key file; omit to use ADC. */
  keyFilename?: string
}

export class GcsBackend implements StorageBackend {
  readonly name = 'gcs'
  private bucket: any = null
  private prefix: string

  constructor(private config: GcsBackendConfig) {
    this.prefix = config.prefix ?? 'dsh'
  }

  async init(): Promise<void> {
    const mod = await import('@google-cloud/storage')
    const storage = new (mod as any).Storage(
      this.config.keyFilename ? { keyFilename: this.config.keyFilename } : undefined,
    )
    this.bucket = storage.bucket(this.config.bucket)
  }

  private async putJson(path: string, value: unknown): Promise<void> {
    if (!this.bucket) return
    await this.bucket.file(path).save(JSON.stringify(value), {
      contentType: 'application/json',
      resumable: false,
    })
  }

  async upsertMessage(row: MessageRow): Promise<void> {
    await this.putJson(`${this.prefix}/sessions/${row.sessionId}/messages/${row.id}.json`, row)
  }

  async upsertSession(row: SessionRow): Promise<void> {
    await this.putJson(`${this.prefix}/sessions/${row.sessionId}/metadata.json`, row)
  }

  /**
   * Tar + gzip the workspace directory and upload it.
   * TODO: replace the naive tar invocation with a streaming tar library
   * (e.g. `tar`) to avoid shelling out and to control file inclusion.
   */
  async archiveWorkspace(sessionId: string, cwd: string): Promise<void> {
    if (!this.bucket) return
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
    const tarball = join(dir, 'workspace.tar.gz')
    try {
      await promisify(execFile)('tar', ['-czf', tarball, '-C', cwd, '.'])
      const dest = this.bucket.file(`${this.prefix}/sessions/${sessionId}/workspace.tar.gz`)
      await pipeline(createReadStream(tarball), dest.createWriteStream())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
