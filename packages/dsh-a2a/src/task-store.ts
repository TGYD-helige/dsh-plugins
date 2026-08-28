/**
 * TaskStore boundary for the SDK's DefaultRequestHandler.
 *
 * The SDK's ResultManager calls `taskStore.save()` on EVERY task/statusUpdate
 * event — including each streamed text delta — and folds status messages into
 * `task.history`. Two constraints follow from this plugin's design:
 *
 * 1. A2A stores carry task STATE only (task metadata ≠ conversation history —
 *    history is dsh-storage's `ai_messages`). {@link sanitizeTask} strips
 *    `history`/`artifacts` before anything reaches a backend.
 * 2. Token-rate saves would hammer Redis and put a GCS upload in the hot path
 *    of the SSE stream (ResultManager awaits every save). {@link
 *    SanitizedTaskStore} collapses saves to task-state CHANGES, which are the
 *    only transitions a `tasks/get` reader can act on anyway.
 *
 * A2A 1.0 added `list()` to the TaskStore contract; {@link listShells} holds
 * the shared filter/sort/paginate logic so the backends only enumerate shells.
 */

import type { ListTasksRequest, ListTasksResponse, Task, TaskState } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';

/** The persistent shape: a metadata shell with empty history/artifacts. */
export function sanitizeTask(task: Task): Task {
  return {
    id: task.id,
    contextId: task.contextId,
    status: task.status,
    metadata: task.metadata,
    history: [],
    artifacts: [],
  };
}

/** TaskStore with the optional lifecycle our backends add. */
export interface ManagedTaskStore extends TaskStore {
  init?(): Promise<void>;
  close?(): Promise<void>;
}

/** Strips history/artifacts and saves only on task-state transitions. */
export class SanitizedTaskStore implements ManagedTaskStore {
  private readonly lastState = new Map<string, TaskState>();

  constructor(private readonly inner: ManagedTaskStore) {}

  async init(): Promise<void> {
    await this.inner.init?.();
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const state = task.status?.state;
    if (state !== undefined && this.lastState.get(task.id) === state) return;
    if (state !== undefined) this.lastState.set(task.id, state);
    await this.inner.save(sanitizeTask(task), context);
  }

  load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    return this.inner.load(taskId, context);
  }

  list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    return this.inner.list(params, context);
  }
}

/**
 * Shared `listTasks` semantics for the backends: filter by contextId / status /
 * statusTimestampAfter (strictly greater), newest status first, cursor-paginated
 * (base64 "timestamp|id"; a well-formed but unknown cursor yields an empty page,
 * a malformed token throws). Follows the SDK's InMemoryTaskStore.
 */
export function listShells(shells: Task[], params: ListTasksRequest): ListTasksResponse {
  const filtered = shells.filter((task) => {
    if (params.contextId && task.contextId !== params.contextId) return false;
    if (params.status && task.status?.state !== params.status) return false;
    if (params.statusTimestampAfter) {
      const timestamp = task.status?.timestamp;
      // Strictly-greater mirrors the SDK's InMemoryTaskStore.
      if (!timestamp || Date.parse(timestamp) <= Date.parse(params.statusTimestampAfter)) {
        return false;
      }
    }
    return true;
  });
  filtered.sort((a, b) => {
    const at = a.status?.timestamp ?? '';
    const bt = b.status?.timestamp ?? '';
    return bt.localeCompare(at) || b.id.localeCompare(a.id);
  });

  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);
  let start = 0;
  if (params.pageToken) {
    const decoded = Buffer.from(params.pageToken, 'base64').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep < 0) throw new Error('invalid page token');
    const timestamp = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    // A well-formed cursor pointing at nothing (expired/rotated) is an empty page.
    const index = filtered.findIndex(
      (task) => (task.status?.timestamp ?? '') === timestamp && task.id === id,
    );
    if (index >= 0) start = index + 1;
    else return { tasks: [], nextPageToken: '', pageSize, totalSize: filtered.length };
  }
  const page = filtered.slice(start, start + pageSize);
  const last = page.at(-1);
  const hasMore = start + pageSize < filtered.length;
  return {
    tasks: page.map((task) => (params.includeArtifacts ? task : { ...task, artifacts: [] })),
    nextPageToken:
      hasMore && last
        ? Buffer.from(`${last.status?.timestamp ?? ''}|${last.id}`).toString('base64')
        : '',
    pageSize,
    totalSize: filtered.length,
  };
}
