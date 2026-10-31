import { AsyncLocalStorage } from 'node:async_hooks';
import type { Writable } from 'node:stream';
import type { StreamResponse } from '@a2a-js/sdk';
import { DefaultExecutionEventBus, type DefaultRequestHandler } from '@a2a-js/sdk/server';

interface Connection {
  signal: AbortSignal;
  subscription: boolean;
}

const connections = new AsyncLocalStorage<Connection>();

/** SDK transports do not end their pending iterators on connection close. */
export function withStreamConnection<T>(output: Writable, run: () => T): T {
  const controller = new AbortController();
  const connection: Connection = { signal: controller.signal, subscription: false };
  let backlogLimit: number | undefined;
  const drained = () => {
    backlogLimit = undefined;
  };
  const close = () => {
    controller.abort();
    output.off('close', close).off('finish', close).off('cancelled', close).off('drain', drained);
  };
  output.once('close', close).once('finish', close).once('cancelled', close);
  const write = output.write;
  output.write = ((...args: Parameters<Writable['write']>) => {
    const accepted = write.apply(output, args);
    if (!accepted && !controller.signal.aborted) {
      if (backlogLimit === undefined) {
        // Allow one large frame, then at most 1 MiB or 16 additional gRPC messages.
        backlogLimit = output.writableLength + (output.writableObjectMode ? 16 : 1024 * 1024);
        output.once('drain', drained);
      } else if (output.writableLength >= backlogLimit) {
        close();
        output.destroy();
      }
    }
    return accepted;
  }) as Writable['write'];
  return connections.run(connection, run);
}

/** A disconnected subscriber stops only its SDK queue, never the task bus. */
export function subscriptionBus(source: DefaultExecutionEventBus | undefined) {
  const connection = connections.getStore();
  if (!source || !connection?.subscription) return source;
  if (connection.signal.aborted) return undefined;
  const mirror = new DefaultExecutionEventBus();
  const forward = (event: Parameters<DefaultExecutionEventBus['publish']>[0]) =>
    mirror.publish(event);
  const finish = () => {
    source.off('event', forward).off('finished', finish);
    connection.signal.removeEventListener('abort', finish);
    mirror.finished();
  };
  source.on('event', forward).on('finished', finish);
  connection.signal.addEventListener('abort', finish, { once: true });
  return mirror;
}

async function* connectedStream(
  stream: AsyncGenerator<StreamResponse, void, undefined>,
  subscription: boolean,
) {
  const connection = connections.getStore();
  if (connection) connection.subscription = subscription;
  for await (const event of stream) {
    // Disconnected sends still drain the SDK ResultManager for persistence.
    if (!connection?.signal.aborted) yield event;
  }
}

/** Keep SDK parsing, serialization and errors; adapt only stream consumption. */
export function connectedRequestHandler(handler: DefaultRequestHandler): DefaultRequestHandler {
  return new Proxy(handler, {
    get(target, key) {
      if (key === 'sendMessageStream')
        return (...args: Parameters<DefaultRequestHandler['sendMessageStream']>) =>
          connectedStream(target.sendMessageStream(...args), false);
      if (key === 'resubscribe')
        return (...args: Parameters<DefaultRequestHandler['resubscribe']>) =>
          connectedStream(target.resubscribe(...args), true);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
