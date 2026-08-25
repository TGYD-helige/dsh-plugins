import type { LangfuseGenerationClient, LangfuseSpanClient, LangfuseTraceClient } from 'langfuse';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangfuseReporter, usageOf } from './client.js';

const mocks = vi.hoisted(() => {
  const instances: FakeLangfuse[] = [];
  const state = { throwOnConstruct: false };
  class FakeObservation {
    updates: unknown[] = [];
    ends: unknown[] = [];
    constructor(
      readonly kind: string,
      readonly body: unknown,
    ) {}
    update(body: unknown) {
      this.updates.push(body);
      return this;
    }
    end(body?: unknown) {
      this.ends.push(body ?? {});
      return this;
    }
  }
  class FakeTrace extends FakeObservation {
    generations: FakeObservation[] = [];
    spans: FakeObservation[] = [];
    generation(body: unknown) {
      const generation = new FakeObservation('generation', body);
      this.generations.push(generation);
      return generation;
    }
    span(body: unknown) {
      const span = new FakeObservation('span', body);
      this.spans.push(span);
      return span;
    }
  }
  class FakeLangfuse {
    traces: FakeTrace[] = [];
    flushAsync = vi.fn(async () => {});
    shutdownAsync = vi.fn(async () => {});
    constructor(readonly config: unknown) {
      if (state.throwOnConstruct) throw new Error('bad keys');
      instances.push(this);
    }
    trace(body?: unknown) {
      const trace = new FakeTrace('trace', body ?? {});
      this.traces.push(trace);
      return trace;
    }
  }
  return { instances, state, FakeLangfuse, FakeTrace, FakeObservation };
});

vi.mock('langfuse', () => ({ Langfuse: mocks.FakeLangfuse }));

type FakeTrace = InstanceType<typeof mocks.FakeTrace>;
type FakeObservation = InstanceType<typeof mocks.FakeObservation>;
/** The reporter speaks langfuse client types; the objects behind them are the
 * fakes. Intersections keep the handles both mock-readable and passable back
 * into reporter methods. */
const fakeTrace = (value: unknown): FakeTrace & LangfuseTraceClient => value as never;
const fakeGen = (value: unknown): FakeObservation & LangfuseGenerationClient => value as never;
const fakeSpan = (value: unknown): FakeObservation & LangfuseSpanClient => value as never;

const config = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'https://langfuse.example' };

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.state.throwOnConstruct = false;
});

describe('usageOf', () => {
  it('keeps usageDetails buckets disjoint while usage carries billed totals', () => {
    expect(
      usageOf({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }),
    ).toEqual({
      usage: { input: 15, output: 5, total: 20 },
      usageDetails: {
        input: 10,
        output: 5,
        total: 20,
        input_cache_read: 2,
        input_cache_creation: 3,
      },
    });
  });

  it('omits absent buckets and subtracts reasoning into its own bucket', () => {
    expect(usageOf({ inputTokens: 10, outputTokens: 5, reasoningTokens: 4 })).toEqual({
      usage: { input: 10, output: 5, total: 15 },
      usageDetails: { input: 10, output: 1, total: 15, output_reasoning: 4 },
    });
  });
});

describe('LangfuseReporter', () => {
  it('lazily constructs the SDK client with the connection config', async () => {
    const reporter = new LangfuseReporter(config);
    expect(mocks.instances).toHaveLength(0);
    await reporter.ready;
    expect(mocks.instances[0].config).toEqual(config);
  });

  it('creates traces, generations and spans through the stateful API', async () => {
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const trace = fakeTrace(
      reporter.openTrace({ name: 'dsh-turn', sessionId: 's1', metadata: { turn: 0 } }),
    );
    expect(mocks.instances[0].traces[0].body).toEqual({
      name: 'dsh-turn',
      sessionId: 's1',
      input: undefined,
      metadata: { turn: 0 },
    });

    reporter.updateTrace(trace, { input: 'hello' });
    expect(trace.updates[0]).toEqual({ input: 'hello', metadata: undefined });

    const generation = fakeGen(
      reporter.startGeneration(trace, {
        name: 'llm-call',
        model: 'deepseek-chat',
        input: { messages: [] },
      }),
    );
    expect(trace.generations[0].body).toMatchObject({ name: 'llm-call', model: 'deepseek-chat' });

    reporter.endGeneration(generation, {
      output: 'hi',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      level: 'DEFAULT',
    });
    expect(generation.ends[0]).toMatchObject({
      output: 'hi',
      usage: { input: 12, output: 5, total: 17 },
      usageDetails: { input: 10, output: 5, total: 17, input_cache_read: 2 },
      level: 'DEFAULT',
    });

    const span = fakeSpan(
      reporter.startSpan(trace, { name: 'tool:write_file', input: { path: 'a' } }),
    );
    reporter.endSpan(span, { output: [], level: 'ERROR', statusMessage: 'nope' });
    expect(span.ends[0]).toMatchObject({ level: 'ERROR', statusMessage: 'nope' });
  });

  it('is a silent no-op before init settles', () => {
    const reporter = new LangfuseReporter(config);
    expect(reporter.openTrace({ name: 't' })).toBeNull();
    expect(mocks.instances).toHaveLength(0);
  });

  it('degrades to a no-op when client construction fails, logging with the prefix', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.state.throwOnConstruct = true;
    const reporter = new LangfuseReporter(config);
    await reporter.ready;

    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] client init failed:', expect.any(Error));
    const trace = reporter.openTrace({ name: 't' });
    expect(trace).toBeNull();
    expect(reporter.startGeneration(trace, { name: 'g' })).toBeNull();
    expect(reporter.startSpan(trace, { name: 's' })).toBeNull();
    await expect(reporter.flush()).resolves.toBeUndefined();
    await expect(reporter.shutdown()).resolves.toBeUndefined();
    errorSpy.mockRestore();
  });

  it('swallows every SDK boundary failure with the prefixed console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const client = mocks.instances[0];
    const trace = fakeTrace(reporter.openTrace({ name: 't' }));
    const generation = fakeGen(reporter.startGeneration(trace, { name: 'g' }));
    const span = fakeSpan(reporter.startSpan(trace, { name: 's' }));
    errorSpy.mockClear();

    const boom = () => {
      throw new Error('ingestion down');
    };
    vi.spyOn(client, 'trace').mockImplementationOnce(boom);
    expect(reporter.openTrace({ name: 't' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] trace creation failed:',
      expect.any(Error),
    );

    vi.spyOn(trace, 'update').mockImplementationOnce(boom);
    expect(() => reporter.updateTrace(trace, { input: 'x' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] trace update failed:', expect.any(Error));

    vi.spyOn(trace, 'generation').mockImplementationOnce(boom);
    expect(reporter.startGeneration(trace, { name: 'g' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] generation creation failed:',
      expect.any(Error),
    );

    vi.spyOn(generation, 'end').mockImplementationOnce(boom);
    expect(() => reporter.endGeneration(generation, { level: 'DEFAULT' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] generation end failed:',
      expect.any(Error),
    );

    vi.spyOn(trace, 'span').mockImplementationOnce(boom);
    expect(reporter.startSpan(trace, { name: 's' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] span creation failed:',
      expect.any(Error),
    );

    vi.spyOn(span, 'end').mockImplementationOnce(boom);
    expect(() => reporter.endSpan(span, { level: 'DEFAULT' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] span end failed:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('flushes and shuts the SDK down, swallowing failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const client = mocks.instances[0];

    await reporter.flush();
    expect(client.flushAsync).toHaveBeenCalledTimes(1);

    client.flushAsync.mockRejectedValueOnce(new Error('flush boom'));
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] flush failed:', expect.any(Error));

    client.shutdownAsync.mockRejectedValueOnce(new Error('shutdown boom'));
    await expect(reporter.shutdown()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] shutdown failed:', expect.any(Error));

    // After shutdown the reporter is inert.
    expect(reporter.openTrace({ name: 't' })).toBeNull();
    errorSpy.mockRestore();
  });

  it('chains flush and shutdown behind the lazy init', async () => {
    // Called synchronously after construction — before `ready` can have
    // settled — both must still wait for the client to exist.
    const flushing = new LangfuseReporter(config);
    await flushing.flush();
    expect(mocks.instances[0].flushAsync).toHaveBeenCalledTimes(1);

    const shuttingDown = new LangfuseReporter(config);
    await shuttingDown.shutdown();
    expect(mocks.instances[1].shutdownAsync).toHaveBeenCalledTimes(1);
  });
});
