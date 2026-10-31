import { once } from 'node:events';
import { Writable } from 'node:stream';
import { AgentCard, Message, type StreamResponse, Task, TaskState } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { expect, it, vi } from 'vitest';
import {
  connectedRequestHandler,
  subscriptionBus,
  withStreamConnection,
} from './stream-connection.js';

const frame = (id: string): StreamResponse => ({
  payload: { $case: 'task', value: Task.fromJSON({ id }) },
});
const handler = () =>
  new DefaultRequestHandler(AgentCard.fromJSON({}), new InMemoryTaskStore(), {
    execute: async () => {},
    cancelTask: async () => {},
  });

it('persists completion while the sending client is stalled', async () => {
  const store = new InMemoryTaskStore();
  const context = new ServerCallContext();
  let taskId = '';
  const sdk = new DefaultRequestHandler(
    AgentCard.fromJSON({ capabilities: { streaming: true } }),
    store,
    {
      execute: async (request, bus) => {
        taskId = request.taskId;
        bus.publish(
          AgentEvent.task(
            Task.fromJSON({
              id: taskId,
              contextId: request.contextId,
              status: { state: 'TASK_STATE_WORKING' },
            }),
          ),
        );
        bus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId: request.contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: undefined,
            },
            metadata: undefined,
          }),
        );
        bus.finished();
      },
      cancelTask: async () => {},
    },
  );
  const output = new Writable({ objectMode: true, highWaterMark: 1, write() {} });
  const consuming = withStreamConnection(output, async () => {
    for await (const event of connectedRequestHandler(sdk).sendMessageStream(
      {
        tenant: '',
        message: Message.fromJSON({
          messageId: 'slow',
          role: 'ROLE_USER',
          parts: [{ text: 'test' }],
        }),
        configuration: undefined,
        metadata: undefined,
      },
      context,
    ))
      output.write(event);
  });
  try {
    await vi.waitFor(async () =>
      expect((await store.load(taskId, context))?.status?.state).toBe(
        TaskState.TASK_STATE_COMPLETED,
      ),
    );
  } finally {
    output.destroy();
    await consuming;
  }
});

it.each([false, true])(
  'bounds slow writer backlog and drains the task (objectMode=%s)',
  async (objectMode) => {
    const output = new Writable({ objectMode, highWaterMark: 1, write() {} });
    const sdk = handler();
    let consumed = 0;
    vi.spyOn(sdk, 'sendMessageStream').mockImplementation(async function* () {
      for (let index = 0; index < 100; index++) {
        consumed++;
        yield frame(String(index));
      }
    });
    const connected = connectedRequestHandler(sdk);
    let delivered = 0;
    await withStreamConnection(output, async () => {
      for await (const event of connected.sendMessageStream(
        { tenant: '', message: undefined, configuration: undefined, metadata: undefined },
        new ServerCallContext(),
      )) {
        delivered++;
        output.write(objectMode ? event : Buffer.alloc(64 * 1024));
      }
    });
    expect(consumed).toBe(100);
    expect(delivered).toBeGreaterThan(1);
    expect(delivered).toBeLessThanOrEqual(18);
    expect(output.destroyed).toBe(true);
    expect(output.listenerCount('drain')).toBe(0);
  },
);

it('does not attach a subscription queue when its connection already closed', async () => {
  const output = new Writable({
    objectMode: true,
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const source = new DefaultExecutionEventBus();
  const sdk = handler();
  vi.spyOn(sdk, 'resubscribe').mockImplementation(async function* () {
    expect(subscriptionBus(source)).toBeUndefined();
    yield frame('snapshot');
  });
  const connected = connectedRequestHandler(sdk);
  await withStreamConnection(output, async () => {
    const closed = once(output, 'close');
    output.destroy();
    await closed;
    const stream = connected.resubscribe({ tenant: '', id: 'task' }, new ServerCallContext());
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });
});
