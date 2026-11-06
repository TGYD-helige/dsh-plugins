import { Context } from '@deepseek-ai/cordis';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapters } from './adapters/index.js';
import { TelemetryReporter } from './core/otel.js';
import { apply, Config } from './index.js';

const state = vi.hoisted(() => ({
  fail: false,
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
    export(spans: typeof state.spans, callback: (result: { code: number; error?: Error }) => void) {
      state.spans.push(...spans);
      callback(
        state.fail
          ? { code: 1, error: Object.assign(new Error('private-export-response'), { code: 401 }) }
          : { code: 0 },
      );
    }
    async shutdown() {}
    async forceFlush() {}
  },
}));
afterEach(() => {
  state.spans.length = 0;
  state.fail = false;
  vi.restoreAllMocks();
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

it('swallows exporter failures and logs only a safe failure category', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const reporter = new TelemetryReporter(
    { backend: 'phoenix', captureContent: false },
    adapters.phoenix,
  );
  await reporter.ready;
  reporter.endSpan(reporter.openTrace({ name: 'failure' }));
  state.fail = true;
  await expect(reporter.flush()).resolves.toBeUndefined();
  expect(diagnostic).toHaveBeenCalledWith('[dsh-telemetry] flush failed (HTTP 401)');
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-export-response');
  await expect(reporter.shutdown()).resolves.toBeUndefined();
});

it('strips adapted content and redacts adapted JSON at the final boundary', async () => {
  const reporter = new TelemetryReporter(
    {
      backend: 'phoenix',
      apiKey: 'phoenix-secret',
      captureContent: false,
      redactFields: ['password'],
    },
    {
      ...adapters.phoenix,
      attributes: () => ({
        'input.value': 'PROMPT-BYPASS',
        metadata: '{"password":"private","token":"phoenix-secret"}',
      }),
    },
  );
  await reporter.ready;
  reporter.endSpan(reporter.openTrace({ name: 'safe' }));
  await reporter.shutdown();
  expect(state.spans[0].attributes['input.value']).toBeUndefined();
  expect(JSON.parse(String(state.spans[0].attributes.metadata))).toEqual({
    password: '[REDACTED]',
    token: '[REDACTED]',
  });
});

it.each(['phoenix', 'langfuse'] as const)(
  'preserves reasoning through the collector and %s adapter',
  async (backend) => {
    const ctx = new Context();
    await apply(
      ctx,
      Config({ enabled: true, backend, publicKey: 'pk-test', secretKey: 'sk-test' }),
    );
    const chunks = [
      { type: 'reasoning-delta', index: 0, text: 'Check ' },
      { type: 'reasoning-delta', index: 0, text: 'the file.' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    try {
      const received = [];
      for await (const chunk of ctx.waterfall(
        'llm/stream',
        { provider: 'test', model: 'test', messages: [] } as never,
        async function* () {
          yield* chunks as never[];
        },
      ))
        received.push(chunk);
      expect(received).toEqual(chunks);
    } finally {
      await ctx.fiber.dispose();
    }
    const outputKey = backend === 'phoenix' ? 'output.value' : 'langfuse.observation.output';
    const request = state.spans.find((span) => span.name === 'llm-request')!;
    const generation = state.spans.find((span) => span.name.startsWith('llm-call'))!;
    expect(JSON.parse(String(request.attributes[outputKey]))).toEqual(chunks);
    expect(JSON.parse(String(generation.attributes[outputKey]))).toEqual({
      role: 'assistant',
      content: 'answer',
      thinking: [{ type: 'thinking', content: 'Check the file.' }],
    });
    if (backend === 'phoenix')
      expect(
        generation.attributes['llm.output_messages.0.message.contents.0.message_content.text'],
      ).toBe('Check the file.');
  },
);
