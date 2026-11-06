import { Context } from '@deepseek-ai/cordis';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapters } from './adapters/index.js';
import { TelemetryReporter } from './core/otel.js';
import { apply, Config } from './index.js';

const state = vi.hoisted(() => ({
  spans: [] as Array<{
    name: string;
    attributes: Record<string, unknown>;
    parentSpanContext?: { spanId: string };
    spanContext(): { traceId: string; spanId: string };
    status: { code: number };
    startTime: number[];
    endTime: number[];
  }>,
}));
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    export(spans: typeof state.spans, callback: (result: { code: number }) => void) {
      state.spans.push(...spans);
      callback({ code: 0 });
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));
afterEach(() => {
  state.spans.length = 0;
});
describe('shared isolated OTel pipeline', () => {
  it.each(['phoenix', 'langfuse'] as const)(
    'preserves parent ownership, clocks and status on %s',
    async (backend) => {
      const global = trace.getTracerProvider();
      const reporter = new TelemetryReporter(
        {
          backend,
          publicKey: 'pk',
          secretKey: 'sk',
          captureContent: true,
        },
        adapters[backend],
      );
      await reporter.ready;
      const root = reporter.openTrace({
        name: 'turn',
        sessionId: 's',
        startTime: new Date('2026-01-01T00:00:00Z'),
        context: {
          traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
          metadata: { customer: 'a' },
        },
      });
      const llm = reporter.startGeneration(root, {
        name: 'llm',
        model: 'test',
        input: { messages: [] },
      });
      reporter.endGeneration(llm, { output: 'result', usage: { inputTokens: 2, outputTokens: 3 } });
      reporter.endSpan(
        root,
        { output: 'answer', level: 'ERROR' },
        new Date('2026-01-01T00:00:01Z'),
      );
      await reporter.flush();
      expect(trace.getTracerProvider()).toBe(global);
      expect(state.spans).toHaveLength(2);
      const [child, parent] = state.spans;
      expect(parent.spanContext().traceId).toBe('11111111111111111111111111111111');
      expect(parent.parentSpanContext?.spanId).toBe('2222222222222222');
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(parent.startTime).toEqual([1767225600, 0]);
      expect(parent.endTime).toEqual([1767225601, 0]);
      expect(parent.status.code).toBe(2);
      expect(parent.attributes['langfuse.trace.output']).toBeUndefined();
      await reporter.shutdown();
    },
  );
  it('applies final content and credential safeguards after backend mapping', async () => {
    const reporter = new TelemetryReporter(
      {
        backend: 'phoenix',
        apiKey: 'phoenix-secret',
        captureContent: false,
        maxPayloadBytes: 128,
        redactFields: ['password'],
      },
      adapters.phoenix,
    );
    await reporter.ready;
    const root = reporter.openTrace({
      name: 'phoenix-secret',
      context: { metadata: { password: 'private', token: 'phoenix-secret' } },
    });
    const child = reporter.startGeneration(root, {
      name: 'llm',
      input: { messages: [{ role: 'user', content: 'PROMPT' }] },
    });
    reporter.endGeneration(child, { output: 'REPLY', statusMessage: 'FAILURE-CONTENT' });
    reporter.endSpan(root);
    await reporter.shutdown();
    const wire = JSON.stringify(
      state.spans.map((s) => ({ name: s.name, attributes: s.attributes })),
    );
    for (const secret of ['phoenix-secret', 'private', 'PROMPT', 'REPLY', 'FAILURE-CONTENT'])
      expect(wire).not.toContain(secret);
    expect(wire).toContain('[REDACTED]');
  });
});

it('collects concurrent sessions without changing stream chunks and drains on fiber unload', async () => {
  const ctx = new Context();
  await apply(ctx, Config({ enabled: true, backend: 'phoenix' }));
  const session = (id: string) => ({ id, header: { id } }) as never;
  let seq = 0;
  const event = (id: string, type: string, data: unknown) =>
    ctx.emit('session/event', session(id), { type, seq: ++seq, time: Date.now(), data } as never);
  ctx.emit('telemetry/context', 'one', {
    metadata: { tenant: 'one' },
    traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
  });
  ctx.emit('telemetry/context', 'two', { metadata: { tenant: 'two' } });
  for (const id of ['one', 'two']) {
    event(id, 'turn/start', { turn: 0 });
    event(id, 'user/message', { role: 'user', content: [{ type: 'text', text: id }] });
  }
  const chunks = [
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const received = [];
  for await (const chunk of ctx.waterfall(
    'llm/stream',
    { provider: 'test', model: 'test', messages: [], sessionId: 'one' } as never,
    async function* () {
      yield* chunks as never[];
    },
  ))
    received.push(chunk);
  expect(received).toEqual(chunks);
  event('one', 'turn/end', { turn: 0, reason: { kind: 'completed' } });
  await ctx.parallel('session/flush', session('one'));
  expect(state.spans.filter((s) => s.attributes['openinference.span.kind'] === 'LLM')).toHaveLength(
    1,
  );
  const llm = state.spans.find((s) => s.attributes['openinference.span.kind'] === 'LLM')!;
  expect(llm.spanContext().traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect(llm.attributes.metadata).toContain('"tenant":"one"');
  await ctx.fiber.dispose();
  const other = state.spans.find((s) => s.attributes['session.id'] === 'two')!;
  expect(other.spanContext().traceId).not.toBe(llm.spanContext().traceId);
  expect(other.endTime).toBeDefined();
});
