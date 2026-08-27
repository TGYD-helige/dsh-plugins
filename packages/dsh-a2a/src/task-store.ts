/**
 * TaskStore boundary for the SDK's DefaultRequestHandler.
 *
 * The SDK's ResultManager calls `taskStore.save()` on EVERY event — including
 * each streamed text delta's status-update — and folds status messages into
 * `task.history`. Two constraints follow from this plugin's design:
 *
 * 1. A2A stores carry task STATE only (task metadata ≠ conversation history —
 *    history is dsh-storage's `ai_messages`). {@link sanitizeTask} strips
 *    `history`/`artifacts` before anything reaches a backend.
 * 2. Token-rate saves would hammer Redis and put a GCS upload in the hot path
 *    of the SSE stream (ResultManager awaits every save). {@link
 *    SanitizedTaskStore} collapses saves to task-state CHANGES, which are the
 *    only transitions a `tasks/get` reader can act on anyway.
 */

import type { Task } from '@a2a-js/sdk';
import type { TaskStore } from '@a2a-js/sdk/server';

/** The persistent shape: a metadata shell with empty history/artifacts. */
export function sanitizeTask(task: Task): Task {
  return {
    kind: 'task',
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
  private readonly lastState = new Map<string, string>();

  constructor(private readonly inner: ManagedTaskStore) {}

  async init(): Promise<void> {
    await this.inner.init?.();
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  async save(task: Task): Promise<void> {
    const state = task.status?.state ?? '';
    if (state && this.lastState.get(task.id) === state) return;
    if (state) this.lastState.set(task.id, state);
    await this.inner.save(sanitizeTask(task));
  }

  load(taskId: string): Promise<Task | undefined> {
    return this.inner.load(taskId);
  }
}
