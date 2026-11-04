import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk';
import { listShells } from '../task-store.js';

export const LIST_PREFIX_BYTES = 8192;
const HEADER = '{"_dshTaskList":';

/** Only the fields needed by listShells; never retain history or status-message content. */
export function taskListShell(task: Task): Task {
  return {
    id: task.id,
    contextId: task.contextId,
    status: task.status && {
      state: task.status.state,
      message: undefined,
      timestamp: task.status.timestamp,
    },
    history: [],
    artifacts: [],
    metadata: undefined,
  };
}

export function parseListShell(value: unknown): Task | undefined {
  if (typeof value !== 'string') return;
  try {
    const shell = JSON.parse(value);
    if (
      !shell ||
      typeof shell.id !== 'string' ||
      typeof shell.contextId !== 'string' ||
      (shell.status !== undefined &&
        (!shell.status ||
          !Number.isInteger(shell.status.state) ||
          (shell.status.timestamp !== undefined && typeof shell.status.timestamp !== 'string')))
    )
      return;
    return taskListShell(shell);
  } catch {
    return;
  }
}

/** A JSON-compatible header shares the snapshot's atomic write, including on older readers. */
export function serializeTaskSnapshot(task: Task, json: unknown = task): string {
  return `${HEADER}${JSON.stringify(taskListShell(task))},\n${JSON.stringify(json).slice(1)}`;
}

export function snapshotListShell(prefix: string): Task | undefined {
  if (!prefix.startsWith(HEADER)) return;
  const newline = prefix.indexOf('\n');
  if (newline < 0 || prefix[newline - 1] !== ',') return;
  return parseListShell(prefix.slice(HEADER.length, newline - 1));
}

/** Hydrate only the selected page, with bounded I/O and the existing artifact semantics. */
export async function loadTaskPage(
  shells: Task[],
  params: ListTasksRequest,
  load: (ids: string[]) => Promise<Array<Task | undefined>>,
): Promise<ListTasksResponse> {
  const page = listShells(shells, params);
  const tasks: Task[] = [];
  for (let start = 0; start < page.tasks.length; start += 16) {
    const batch = await load(page.tasks.slice(start, start + 16).map((task) => task.id));
    for (const task of batch) {
      // A task can expire or be deleted between enumeration and hydration.
      if (task) tasks.push(params.includeArtifacts ? task : { ...task, artifacts: [] });
    }
  }
  return { ...page, tasks };
}
