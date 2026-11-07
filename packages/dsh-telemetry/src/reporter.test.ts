import { Context } from '@deepseek-ai/cordis';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { adapters } from './adapters/index.js';
import { TelemetryReporter } from './core/otel.js';
import { apply, Config } from './index.js';

const state = vi.hoisted(() => ({
  fail: false,
  hold: false,
  pending: [] as Array<(result: { code: number; error?: Error }) => void>,
  batches: [] as number[],
  spans: [] as Array<{
    name: string;
    attributes: Record<string, unknown>;
    parentSpanContext?: { spanId: string };
    spanContext(): { traceId: string; spanId: string };
    status: { code: number };
    events: Array<{ name: string; time: number[] }>;
    startTime: number[];
    endTime: number[];
  }>,
}));
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    export(spans: typeof state.spans, callback: (result: { code: number; error?: Error }) => void) {
      state.spans.push(...spans);
      state.batches.push(spans.length);
      if (state.hold) {
        state.pending.push(callback);
        return;
      }
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
  state.hold = false;
  for (const callback of state.pending.splice(0)) callback({ code: 0 });
  state.batches.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
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
        traceId: 'abcdefabcdefabcdefabcdefabcdefab',
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

it.each([256, 16_384])(
  'bounds capture work across %i chunks in concurrent sessions',
  async (count) => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    await apply(ctx, Config({ enabled: true, backend: 'phoenix', maxPayloadBytes: 1024 }));
    const delta = { type: 'text-delta', index: 0, text: 'x'.repeat(64) };
    const stringify = vi.spyOn(JSON, 'stringify');
    const mask = vi.spyOn(TelemetryReporter.prototype, 'mask');
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const session = { id: `load-${index}`, header: { id: `load-${index}` } } as never;
        const event = (type: string) =>
          ctx.emit('session/event', session, {
            type,
            seq: 1,
            time: Date.now(),
            data: { turn: 0, reason: { kind: 'completed' } },
          } as never);
        event('turn/start');
        let received = 0;
        for await (const chunk of ctx.waterfall(
          'llm/stream',
          {
            provider: 'test',
            model: 'test',
            messages: [],
            sessionId: `load-${index}`,
          } as never,
          async function* () {
            for (let i = 0; i < count; i++) yield delta as never;
            yield { type: 'finish', reason: { kind: 'stop' } } as never;
          },
        )) {
          if (received < count) expect(chunk).toBe(delta);
          received++;
        }
        expect(received).toBe(count + 1);
        event('turn/end');
        await ctx.parallel('session/flush', session);
      }),
    );
    // Once capture fills, later chunks must not trigger serialization or masking.
    expect(stringify.mock.calls.filter(([value]) => value === delta).length).toBeLessThanOrEqual(
      80,
    );
    expect(mask.mock.calls.length).toBeLessThanOrEqual(1024);
    stringify.mockRestore();
    expect(state.spans).toHaveLength(24);
    for (const span of state.spans.filter((item) => item.name === 'llm-request')) {
      expect(JSON.parse(String(span.attributes.metadata))).toMatchObject({
        chunkCount: count + 1,
        truncated: true,
      });
      expect(Buffer.byteLength(String(span.attributes['output.value']))).toBeLessThanOrEqual(1024);
    }
  },
);

it.each(['phoenix', 'langfuse'] as const)(
  'redacts fragmented credentials in large requests and streams on %s',
  async (backend) => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    const secret = 'perf-credential-value';
    await apply(
      ctx,
      Config({
        enabled: true,
        backend,
        apiKey: secret,
        publicKey: 'pk-fixture',
        secretKey: secret,
        maxPayloadBytes: 1024,
        redactFields: ['password'],
      }),
    );
    const pieces = ['perf-', 'credential-', 'value'];
    const input = {
      provider: 'test',
      model: 'test',
      messages: Array.from({ length: 1000 }, () => ({
        role: 'user',
        content: [
          { type: 'text', text: JSON.stringify({ password: 'private-field', token: secret }) },
        ],
      })),
      tools: Array.from({ length: 100 }, (_, index) => ({
        name: `tool-${index}`,
        description: secret,
        parameters: { type: 'object' },
      })),
    };
    let received = 0;
    for await (const _ of ctx.waterfall('llm/stream', input as never, async function* () {
      for (let repeat = 0; repeat < 32; repeat++)
        for (const text of pieces) yield { type: 'text-delta', index: 0, text } as never;
      yield { type: 'finish', reason: { kind: 'stop' } } as never;
    }))
      received++;
    expect(received).toBe(97);
    await ctx.fiber.dispose();
    const wire = JSON.stringify(state.spans.map((span) => span.attributes));
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain('private-field');
    expect(wire).toContain('[REDACTED]');
    const generation = state.spans.find(
      (span) =>
        span.attributes['openinference.span.kind'] === 'LLM' ||
        span.attributes['langfuse.observation.type'] === 'generation',
    );
    expect(generation).toBeDefined();
    for (const span of state.spans)
      for (const key of [
        'input.value',
        'output.value',
        'langfuse.observation.input',
        'langfuse.observation.output',
      ]) {
        const value = span.attributes[key];
        if (value !== undefined) expect(Buffer.byteLength(String(value))).toBeLessThanOrEqual(1024);
      }
    expect(input.messages[0].content[0].text).toContain(secret);
  },
);

it('releases timers and event listeners across repeated plugin lifecycles', async () => {
  vi.useFakeTimers();
  for (let cycle = 0; cycle < 32; cycle++) {
    const ctx = new Context();
    await apply(ctx, Config({ enabled: true, backend: 'phoenix' }));
    try {
      for (let index = 0; index < 32; index++) {
        const session = { id: `session-${index}`, header: { id: `session-${index}` } } as never;
        ctx.emit('telemetry/context', `session-${index}`, { metadata: { cycle } });
        ctx.emit('session/event', session, {
          type: 'turn/start',
          seq: 1,
          time: Date.now(),
          data: { turn: 0 },
        } as never);
        ctx.emit('session/event', session, {
          type: 'user/message',
          seq: 2,
          time: Date.now(),
          data: { role: 'user', content: [{ type: 'text', text: 'lifecycle' }] },
        } as never);
        ctx.emit('session/disposed', session);
      }
    } finally {
      await ctx.fiber.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    const before = state.spans.length;
    ctx.emit(
      'session/event',
      { id: 'late' } as never,
      {
        type: 'turn/start',
        seq: 1,
        time: Date.now(),
        data: { turn: 0 },
      } as never,
    );
    ctx.emit(
      'session/event',
      { id: 'late' } as never,
      {
        type: 'user/message',
        seq: 2,
        time: Date.now(),
        data: { role: 'user', content: [{ type: 'text', text: 'late' }] },
      } as never,
    );
    await ctx.parallel('session/flush', { id: 'late' } as never);
    expect(state.spans).toHaveLength(before);
  }
  expect(state.spans).toHaveLength(1024);
  expect(new Set(state.spans.map((span) => span.spanContext().spanId)).size).toBe(1024);
});

it.each(['release', 'failure', 'timeout'])(
  'bounds exporter backlog and keeps streaming during %s',
  async (outcome) => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = new Context();
    await apply(ctx, Config({ enabled: true, backend: 'phoenix', captureContent: false }));
    state.hold = true;
    try {
      let received = 0;
      for (let call = 0; call < 1000; call++) {
        for await (const chunk of ctx.waterfall(
          'llm/stream',
          { provider: 'test', model: 'test', messages: [] } as never,
          async function* () {
            yield { type: 'text-delta', index: 0, text: 'answer' } as never;
            yield { type: 'finish', reason: { kind: 'stop' } } as never;
          },
        )) {
          expect(chunk).toBeDefined();
          received++;
        }
      }
      expect(received).toBe(2000);
      expect(state.pending).toHaveLength(1);
      expect(state.batches).toEqual([512]);
      let disposed = false;
      const disposal = ctx.fiber.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(false);
      // Pinned OTel defaults: one 512-span export plus at most 2,048 queued spans.
      expect(state.spans).toHaveLength(2560);
      expect(state.batches.every((size) => size <= 512)).toBe(true);
      state.hold = false;
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(30_001);
      else
        for (const callback of state.pending.splice(0))
          callback(
            outcome === 'release' ? { code: 0 } : { code: 1, error: new Error('ETIMEDOUT') },
          );
      await disposal;
      expect(disposed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome !== 'release')
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[dsh-telemetry\]/));
    } finally {
      state.hold = false;
      for (const callback of state.pending.splice(0)) callback({ code: 0 });
      await ctx.fiber.dispose();
    }
  },
);

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

it.each(['phoenix', 'langfuse'] as const)(
  'exports a parentless task with its requested trace ID on %s',
  async (backend) => {
    const reporter = new TelemetryReporter(
      { backend, publicKey: 'pk-test', secretKey: 'sk-test', captureContent: true },
      adapters[backend],
    );
    await reporter.ready;
    const task = reporter.openTrace({
      name: 'a2a-task',
      sessionId: 'task-session',
      traceId: 'abcdefabcdefabcdefabcdefabcdefab',
    });
    const turn = reporter.startSpan(task, { name: 'agent:turn', asType: 'agent' });
    reporter.endSpan(turn);
    reporter.endSpan(task, { input: 'first user input', output: 'last assistant output' });
    reporter.endSpan(reporter.openTrace({ name: 'ordinary-turn', sessionId: 'other-session' }));
    await reporter.shutdown();
    const root = state.spans.find((span) => span.name === 'a2a-task')!;
    const child = state.spans.find((span) => span.name === 'agent:turn')!;
    expect(root.spanContext().traceId).toBe('abcdefabcdefabcdefabcdefabcdefab');
    expect(root.parentSpanContext).toBeUndefined();
    expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(
      state.spans.find((span) => span.name === 'ordinary-turn')!.spanContext().traceId,
    ).not.toBe(root.spanContext().traceId);
    const sessionRoot = state.spans.find(
      (span) => !span.parentSpanContext && span.attributes['session.id'] === 'task-session',
    );
    const prefix = backend === 'phoenix' ? '' : 'langfuse.observation.';
    expect(sessionRoot?.attributes[backend === 'phoenix' ? 'input.value' : `${prefix}input`]).toBe(
      'first user input',
    );
    expect(
      sessionRoot?.attributes[backend === 'phoenix' ? 'output.value' : `${prefix}output`],
    ).toBe('last assistant output');
  },
);

it('exports the first token as a timed event once, even without content capture', async () => {
  const reporter = new TelemetryReporter(
    { backend: 'phoenix', captureContent: false },
    adapters.phoenix,
  );
  await reporter.ready;
  const root = reporter.openTrace({ name: 'turn' });
  const generation = reporter.startGeneration(root, {
    name: 'llm',
    startTime: new Date('2026-01-01T00:00:00Z'),
  });
  reporter.endGeneration(
    generation,
    { completionStartTime: new Date('2026-01-01T00:00:00.250Z') },
    new Date('2026-01-01T00:00:01Z'),
  );
  reporter.endGeneration(generation, { completionStartTime: new Date() });
  reporter.endSpan(root);
  await reporter.shutdown();
  expect(state.spans[0].attributes).toMatchObject({
    'llm.time_to_first_token_ms': 250,
    'llm.time_to_first_token_seconds': 0.25,
  });
  expect(state.spans[1].attributes['llm.time_to_first_token_ms']).toBeUndefined();
  expect(state.spans[0].events).toEqual([
    {
      name: 'first_token',
      attributes: { time_to_first_token_ms: 250, time_to_first_token_seconds: 0.25 },
      time: [1767225600, 250000000],
      droppedAttributesCount: 0,
    },
  ]);
});

it.each(['superseded', 'session_disposed', 'plugin_unloaded'])(
  'labels an abandoned turn as %s',
  async (reason) => {
    const ctx = new Context();
    await apply(ctx, Config({ enabled: true, backend: 'phoenix' }));
    const session = { id: 'abandoned', header: { id: 'abandoned' } } as never;
    const event = (type: string, data: unknown) =>
      ctx.emit('session/event', session, { type, seq: 1, time: Date.now(), data } as never);
    event('turn/start', { turn: 0 });
    event('user/message', { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    if (reason === 'superseded') event('turn/start', { turn: 1 });
    if (reason === 'session_disposed') ctx.emit('session/disposed', session);
    await ctx.fiber.dispose();
    expect(JSON.parse(String(state.spans[0].attributes.metadata))).toMatchObject({
      terminatedBy: reason,
    });
    expect(state.spans[0].status.code).toBe(0);
  },
);

it.each([true, false])(
  'records bounded provider response facts with captureContent=%s',
  async (captureContent) => {
    const ctx = new Context();
    await apply(
      ctx,
      Config({
        enabled: true,
        backend: 'phoenix',
        captureContent,
        apiKey: 'secret-value',
        maxPayloadBytes: 512,
      }),
    );
    for await (const _ of ctx.waterfall(
      'llm/stream',
      { provider: 'route', model: 'requested', messages: [] } as never,
      async function* () {
        yield {
          type: 'finish',
          reason: { kind: 'max-tokens' },
          replayState: {
            response: {
              id: 'response-1',
              model: 'served',
              stop_reason: 'length',
              credential: 'secret-value',
            },
          },
        } as never;
      },
    )) {
    }
    await ctx.fiber.dispose();
    const llm = state.spans.find((s) => s.attributes['openinference.span.kind'] === 'LLM')!;
    const metadata = JSON.parse(String(llm.attributes.metadata));
    expect(metadata).toMatchObject({
      requestedModel: 'requested',
      requestedProvider: 'route',
      finishReason: 'max-tokens',
    });
    if (captureContent)
      expect(metadata.providerResponse).toEqual({
        id: 'response-1',
        model: 'served',
        stop_reason: 'length',
        credential: '[REDACTED]',
      });
    else expect(metadata.providerResponse).toBeUndefined();
  },
);

it.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true],
])(
  'records compaction lifecycle without double-counting llmStreamCall=%s child=%s',
  async (llmStreamCall, child) => {
    const ctx = new Context();
    await apply(ctx, Config({ enabled: true, backend: 'phoenix', captureContent: true }));
    const session = {
      id: 'summary-session',
      header: {
        id: 'summary-session',
        ...(child ? { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 } : {}),
      },
    } as never;
    if (child) {
      ctx.emit('session/created', session);
      ctx.emit('subagent/start', {
        runId: 'run-summary',
        provider: 'spawn',
        id: 'summary-session',
        local: true,
      } as never);
    }
    let seq = 0;
    const event = (type: string, data: unknown) =>
      ctx.emit('session/event', session, { type, seq: ++seq, time: Date.now(), data } as never);
    event('compaction/start', { compactionId: 'compact-1', turn: null });
    if (llmStreamCall) {
      for await (const _ of ctx.waterfall(
        'llm/stream',
        {
          provider: 'summary-provider',
          model: 'summary-model',
          messages: [],
          sessionId: 'summary-session',
          purpose: 'compaction',
        } as never,
        async function* () {
          yield { type: 'text-delta', index: 0, text: 'summary' } as never;
          yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } as never;
          yield { type: 'finish', reason: { kind: 'stop' } } as never;
        },
      )) {
      }
    }
    event('compaction/summary', {
      compactionId: 'compact-1',
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 1, end: 5 },
      shadowedSeqs: [1, 3, 5],
      shadowedTokenCount: 100,
      provider: 'summary-provider',
      model: 'summary-model',
      usage: { inputTokens: 7, outputTokens: 3 },
      ...(llmStreamCall
        ? { llmStreamCall: true, rawOutput: [{ type: 'text', text: 'summary' }] }
        : {}),
    });
    event('compaction/end', { compactionId: 'compact-1', turn: null });
    await ctx.parallel('session/flush', session);
    const generations = state.spans.filter(
      (s) => s.attributes['openinference.span.kind'] === 'LLM',
    );
    expect(generations).toHaveLength(1);
    expect(generations[0].attributes['llm.token_count.total']).toBe(10);
    expect(generations[0].attributes['llm.model_name']).toBe('summary-model');
    const compaction = state.spans.find((s) => s.name === 'compaction')!;
    expect(compaction.attributes['output.value']).toContain('summary');
    expect(JSON.parse(String(compaction.attributes.metadata))).toMatchObject({
      compactionId: 'compact-1',
      shadowedTokenCount: 100,
    });
    expect(generations[0].parentSpanContext?.spanId).toBe(compaction.spanContext().spanId);
    await ctx.fiber.dispose();
  },
);

it.each(['session_disposed', 'plugin_unloaded'])(
  'closes unfinished compaction with %s and no content leak',
  async (reason) => {
    const ctx = new Context();
    await apply(ctx, Config({ enabled: true, backend: 'phoenix', captureContent: false }));
    const session = { id: 'compact-abandoned', header: { id: 'compact-abandoned' } } as never;
    ctx.emit('session/event', session, {
      type: 'compaction/start',
      seq: 1,
      time: Date.now(),
      data: { compactionId: 'compact-1', turn: null },
    } as never);
    if (reason === 'session_disposed') ctx.emit('session/disposed', session);
    await ctx.fiber.dispose();
    const compact = state.spans.find((s) => s.name === 'compaction')!;
    expect(JSON.parse(String(compact.attributes.metadata))).toMatchObject({ terminatedBy: reason });
    expect(compact.status.code).toBe(0);
  },
);

it.each([undefined, new Date('invalid'), new Date('2025-12-31T23:59:59Z')])(
  'does not invent a first-token duration for unavailable or invalid timestamps: %s',
  async (completionStartTime) => {
    const reporter = new TelemetryReporter(
      { backend: 'phoenix', captureContent: false },
      adapters.phoenix,
    );
    await reporter.ready;
    const root = reporter.openTrace({ name: 'turn' });
    const generation = reporter.startGeneration(root, {
      name: 'llm',
      startTime: new Date('2026-01-01T00:00:00Z'),
    });
    reporter.endGeneration(generation, { completionStartTime });
    reporter.endSpan(root);
    await reporter.shutdown();
    expect(state.spans[0].attributes['llm.time_to_first_token_seconds']).toBeUndefined();
    expect(state.spans[0].events).toEqual([]);
  },
);
