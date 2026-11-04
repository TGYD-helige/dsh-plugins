import { StreamResponse, Task, TaskPushNotificationConfig, TaskState } from '@a2a-js/sdk';
import { InMemoryPushNotificationStore, ServerCallContext } from '@a2a-js/sdk/server';
import { expect, it, vi } from 'vitest';
import { CoalescingPushSender } from './push-notifications.js';
import { MemoryTaskStore, taskScopeKey } from './task-store.js';

const update = StreamResponse.fromJSON({
  statusUpdate: { taskId: 'task', contextId: 'ctx', status: { state: 'TASK_STATE_WORKING' } },
});
const task = (state = TaskState.TASK_STATE_WORKING) =>
  Task.fromJSON({
    id: 'task',
    contextId: 'ctx',
    status: { state },
    history: [{ messageId: 'reply', role: 'ROLE_AGENT', parts: [{ text: 'complete reply' }] }],
  });

it('bounds slow push delivery to one in flight and the latest full snapshot', async () => {
  const store = new MemoryTaskStore();
  const context = new ServerCallContext();
  const subscriptions = new InMemoryPushNotificationStore();
  await subscriptions.save(
    'task',
    context,
    TaskPushNotificationConfig.fromJSON({ url: 'https://example.com/hook' }),
  );
  await store.save(task(), context);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(
    async (_response: StreamResponse, _context: ServerCallContext, _task?: Task) => {
      await gate;
    },
  );
  const sender = new CoalescingPushSender({ send }, store, subscriptions);
  await sender.send(update, context);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  for (let i = 0; i < 100; i++) await sender.send(update, context);
  await store.save(task(TaskState.TASK_STATE_COMPLETED), context);
  await sender.send(update, context);
  const closing = sender.flush();
  expect(send).toHaveBeenCalledOnce();
  release();
  await closing;
  expect(send).toHaveBeenCalledTimes(2);
  const delivered = send.mock.calls.at(-1)![0] as StreamResponse;
  expect(delivered.payload).toEqual({ $case: 'task', value: task(TaskState.TASK_STATE_COMPLETED) });
});

it('isolates equal task IDs by caller scope and recovers from failed dispatch', async () => {
  const store = new MemoryTaskStore();
  const a = new ServerCallContext({ tenant: 'a' });
  const b = new ServerCallContext({ tenant: 'b' });
  const subscriptions = new InMemoryPushNotificationStore();
  for (const context of [a, b])
    await subscriptions.save(
      'task',
      context,
      TaskPushNotificationConfig.fromJSON({ url: 'https://example.com/hook' }),
    );
  await store.save(task(), a);
  await store.save(task(TaskState.TASK_STATE_COMPLETED), b);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const send = vi.fn(async (_response: StreamResponse, _context: ServerCallContext) => {});
  send.mockRejectedValueOnce(new Error('backend unavailable'));
  const sender = new CoalescingPushSender({ send }, store, subscriptions);
  try {
    await Promise.all([sender.send(update, a), sender.send(update, b)]);
    await sender.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map(([, context]) => taskScopeKey(context))).size).toBe(2);
    expect(error).toHaveBeenCalledWith('[dsh-a2a] push notification failed:', expect.any(Error));
  } finally {
    error.mockRestore();
  }
});

it('does not read task storage without a subscription or send a deleted task', async () => {
  const store = new MemoryTaskStore();
  const load = vi.spyOn(store, 'load');
  const subscriptions = new InMemoryPushNotificationStore();
  const context = new ServerCallContext();
  const send = vi.fn(async () => {});
  const sender = new CoalescingPushSender({ send }, store, subscriptions);
  await sender.send(update, context);
  await sender.flush();
  expect(load).not.toHaveBeenCalled();
  await subscriptions.save(
    'task',
    context,
    TaskPushNotificationConfig.fromJSON({ url: 'https://example.com/hook' }),
  );
  await sender.send(update, context);
  await sender.flush();
  expect(load).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
