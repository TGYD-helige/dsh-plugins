import { once } from 'node:events';
import { Writable } from 'node:stream';
import { AgentCard, type StreamResponse, Task } from '@a2a-js/sdk';
import {
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

it.each([false, true])(
  'waits for drain and keeps consuming disconnected sends (disconnect=%s)',
  async (disconnect) => {
    let release!: () => void;
    const output = new Writable({
      objectMode: true,
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
      },
    });
    const sdk = handler();
    let persisted = 0;
    vi.spyOn(sdk, 'sendMessageStream').mockImplementation(async function* () {
      persisted++;
      yield frame('first');
      persisted++;
      yield frame('second');
    });
    const connected = connectedRequestHandler(sdk);
    const delivered: string[] = [];
    const consuming = withStreamConnection(output, async () => {
      for await (const event of connected.sendMessageStream(
        { tenant: '', message: undefined, configuration: undefined, metadata: undefined },
        new ServerCallContext(),
      )) {
        delivered.push(event.payload!.$case);
        output.write(event);
      }
    });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(persisted).toBe(1);
    if (disconnect) output.destroy();
    else {
      release();
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      release();
    }
    await consuming;
    expect(persisted).toBe(2);
    expect(delivered).toHaveLength(disconnect ? 1 : 2);
    output.destroy();
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
