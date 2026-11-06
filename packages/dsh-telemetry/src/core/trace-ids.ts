import type { IdGenerator } from '@opentelemetry/sdk-trace-node';

/** The SDK generates root IDs synchronously; scope requested IDs without inventing a parent. */
export function createTraceIdGenerator(random: IdGenerator) {
  let requested: string | undefined;
  return {
    generateSpanId: () => random.generateSpanId(),
    generateTraceId: () => requested ?? random.generateTraceId(),
    withTraceId<T>(traceId: string | undefined, create: () => T): T {
      const previous = requested;
      requested =
        traceId && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId) ? traceId : undefined;
      try {
        return create();
      } finally {
        requested = previous;
      }
    },
  };
}
