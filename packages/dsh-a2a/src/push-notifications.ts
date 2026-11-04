import type { StreamResponse, Task } from '@a2a-js/sdk';
import type {
  PushNotificationSender,
  PushNotificationStore,
  ServerCallContext,
  TaskStore,
} from '@a2a-js/sdk/server';
import { taskScopeKey } from './task-store.js';

/** Push is a state notification; a slow receiver needs the latest snapshot, not token replay. */
export class CoalescingPushSender implements PushNotificationSender {
  private readonly pending = new Map<string, { dirty: boolean; done: Promise<void> }>();
  constructor(
    private readonly sender: PushNotificationSender,
    private readonly store: TaskStore,
    private readonly subscriptions: PushNotificationStore,
  ) {}

  async send(response: StreamResponse, context: ServerCallContext, _task?: Task): Promise<void> {
    const payload = response.payload;
    const taskId = payload?.$case === 'task' ? payload.value.id : payload?.value.taskId;
    if (!taskId) return;
    const key = JSON.stringify([taskScopeKey(context), taskId]);
    const previous = this.pending.get(key);
    if (previous) {
      previous.dirty = true;
      return;
    }
    const entry = { dirty: true, done: Promise.resolve() };
    this.pending.set(key, entry);
    entry.done = (async () => {
      try {
        while (entry.dirty) {
          entry.dirty = false;
          try {
            if (!(await this.subscriptions.load(taskId, context)).length) continue;
            const task = await this.store.load(taskId, context);
            if (task)
              await this.sender.send({ payload: { $case: 'task', value: task } }, context, task);
          } catch (error) {
            console.error('[dsh-a2a] push notification failed:', error);
          }
        }
      } finally {
        this.pending.delete(key);
      }
    })();
  }

  async flush(): Promise<void> {
    while (this.pending.size)
      await Promise.all([...this.pending.values()].map((entry) => entry.done));
  }
}
