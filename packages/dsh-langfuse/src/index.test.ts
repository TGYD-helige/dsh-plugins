import { Context, type Events } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { GenerateOptions, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools';
import type { LangfuseGeneration, LangfuseSpan } from '@langfuse/tracing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangfuseReporter, usageOf } from './client.js';
import { apply, inject, name } from './index.js';

// The shared Langfuse SDK mock: the v5 SDK surface is three modules —
// @langfuse/tracing (startObservation + setLangfuseTracerProvider),
// @langfuse/otel (LangfuseSpanProcessor) and @opentelemetry/sdk-trace-node
// (NodeTracerProvider) — all dynamically imported by the reporter and all
// intercepted here (vi.mock covers dynamic import()). Mock observations form
// the same explicit handle tree the plugin builds: roots captured by the
// module-level startObservation, children by parent.startObservation.
// Vitest isolates this file, so the captured state is per-suite; beforeEach
// resets it.
const mocks = vi.hoisted(() => {
  const state = { throwOnProcessor: false, failCreate: false };
  const processors: MockSpanProcessor[] = [];
  const providers: MockNodeTracerProvider[] = [];
  const roots: MockObservation[] = [];
  /** Every setLangfuseTracerProvider argument, in order (null = released). */
  const isolatedProviders: unknown[] = [];

  class MockObservation {
    name: string;
    /** The parentSpanContext a root was created with (the NO_PARENT check). */
    parentContext: unknown;
    readonly updates: Array<Record<string, unknown>> = [];
    ended = 0;
    readonly spans: MockObservation[] = [];
    readonly generations: MockObservation[] = [];
    /** Raw OTEL attributes stamped on the span (e.g. the session.id key). */
    readonly attributes: Record<string, unknown> = {};
    readonly otelSpan = {
      setAttribute: (key: string, value: unknown) => {
        this.attributes[key] = value;
      },
      updateName: (name: string) => {
        this.name = name;
      },
    };

    constructor(
      name: string,
      readonly body: Record<string, unknown>,
      readonly asType: string,
    ) {
      this.name = name;
    }

    update(attrs: Record<string, unknown>) {
      this.updates.push(attrs);
    }

    /** The real SDK serializes non-strings; the mock keeps the raw value. */
    setTraceIO(io: { input?: unknown; output?: unknown }) {
      if (io.input !== undefined) this.attributes['langfuse.trace.input'] = io.input;
      if (io.output !== undefined) this.attributes['langfuse.trace.output'] = io.output;
    }

    end() {
      this.ended += 1;
    }

    startObservation(name: string, attrs?: Record<string, unknown>, opts?: { asType?: string }) {
      if (state.failCreate) throw new Error('ingestion down');
      const child = new MockObservation(name, attrs ?? {}, opts?.asType ?? 'span');
      (child.asType === 'generation' ? this.generations : this.spans).push(child);
      return child;
    }
  }

  class MockSpanProcessor {
    constructor(readonly config: unknown) {
      if (state.throwOnProcessor) throw new Error('bad keys');
      processors.push(this);
    }
  }

  class MockNodeTracerProvider {
    readonly forceFlush = vi.fn(async () => {});
    readonly shutdown = vi.fn(async () => {});
    constructor(readonly config: { spanProcessors: MockSpanProcessor[] }) {
      providers.push(this);
    }
  }

  return {
    state,
    processors,
    providers,
    roots,
    isolatedProviders,
    MockObservation,
    MockSpanProcessor,
    MockNodeTracerProvider,
  };
});

vi.mock('@langfuse/tracing', () => ({
  startObservation: (
    name: string,
    attrs?: Record<string, unknown>,
    opts?: { asType?: string; parentSpanContext?: unknown },
  ) => {
    if (mocks.state.failCreate) throw new Error('ingestion down');
    const root = new mocks.MockObservation(name, attrs ?? {}, opts?.asType ?? 'span');
    root.parentContext = opts?.parentSpanContext;
    mocks.roots.push(root);
    return root;
  },
  setLangfuseTracerProvider: (provider: unknown) => {
    mocks.isolatedProviders.push(provider);
  },
}));
vi.mock('@langfuse/otel', () => ({ LangfuseSpanProcessor: mocks.MockSpanProcessor }));
vi.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: mocks.MockNodeTracerProvider,
}));

type MockObservation = InstanceType<typeof mocks.MockObservation>;
/** The reporter/plugin speak langfuse wrapper types; the objects behind them
 * are the mocks. Intersections keep handles mock-readable and passable back
 * into reporter methods without per-call casts. */
const fakeObs = (value: unknown): MockObservation => value as MockObservation;
const fakeSpan = (value: unknown): MockObservation & LangfuseSpan =>
  value as MockObservation & LangfuseSpan;
const fakeGen = (value: unknown): MockObservation & LangfuseGeneration =>
  value as MockObservation & LangfuseGeneration;

beforeEach(() => {
  mocks.processors.length = 0;
  mocks.providers.length = 0;
  mocks.roots.length = 0;
  mocks.isolatedProviders.length = 0;
  mocks.state.failCreate = false;
  mocks.state.throwOnProcessor = false;
});

const enabledConfig = {
  enabled: true,
  publicKey: 'pk',
  secretKey: 'sk',
  baseUrl: 'https://langfuse.example',
  traceName: 'dsh-turn',
  captureContent: true,
};

function hookNames(ctx: Context): string[] {
  return Object.keys((ctx.events as never as { _hooks: object })._hooks);
}

// ---------------------------------------------------------------- fixtures

let seq = 0;
const ev = (type: string, data: unknown): SessionEvent =>
  ({ type, seq: ++seq, time: 1700000000000, data }) as unknown as SessionEvent;

const sessionOf = (id: string, header: Record<string, unknown> = {}): Session =>
  ({ id, header: { id, ...header } }) as unknown as Session;
const agentOf = (id: string): Agent => ({ id }) as unknown as Agent;

const childSessionOf = (id: string, parentSessionId: string, depth = 1): Session =>
  sessionOf(id, { parentSession: parentSessionId, origin: 'subagent', delegationDepth: depth });

type SubagentRunInfo = Parameters<Events['subagent/start']>[0];
type SubagentRunEndInfo = Parameters<Events['subagent/end']>[0];
const subagentStart = (id: string): SubagentRunInfo =>
  ({ runId: `run-${id}`, provider: 'spawn', id, local: true }) as unknown as SubagentRunInfo;
const subagentEnd = (id: string, stopReason: string): SubagentRunEndInfo =>
  ({ ...subagentStart(id), stopReason }) as unknown as SubagentRunEndInfo;

const turnStart = (turn: number) => ev('turn/start', { turn });
const turnEnd = (turn: number) => ev('turn/end', { turn, reason: { kind: 'completed' } });
const userMessage = (text: string) =>
  ev('user/message', {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
const assistantMessage = (text: string) =>
  ev('assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'test', model: 'm' },
    },
  });

const optionsOf = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'test',
  model: 'deepseek-chat',
  messages: [],
  sessionId: 's1' as unknown as GenerateOptions['sessionId'],
  ...over,
});

async function* streamOf(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks;
}

const textDelta = (text: string, index = 0): StreamChunk => ({ type: 'text-delta', index, text });
const blockStart = (): StreamChunk => ({ type: 'block-start', index: 0, blockType: 'text' });
const usageChunk = (usage: TokenUsage): StreamChunk => ({ type: 'usage', usage });
const finishStop = (): StreamChunk => ({ type: 'finish', reason: { kind: 'stop' } });
const finishError = (message: string): StreamChunk => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message, code: 'BOOM' } },
});
const finishAborted = (message: string): StreamChunk => ({
  type: 'finish',
  reason: { kind: 'aborted', failure: { message, code: 'CANCELLED' } },
});
const toolCallEnd = (toolName: string, args = '{}'): StreamChunk => ({
  type: 'block-end',
  index: 0,
  block: { type: 'tool-call', id: 'c1' as ToolCallId, name: toolName, arguments: args },
});

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const received: StreamChunk[] = [];
  for await (const chunk of stream) received.push(chunk);
  return received;
}

const execOf = (over: Partial<ToolDispatchExecution> = {}): ToolDispatchExecution => ({
  callId: 'c1' as ToolCallId,
  rootCallId: 'c1' as ToolCallId,
  name: 'write_file',
  arguments: { path: 'a.ts' },
  token: Symbol('exec') as unknown as ToolExecutionToken,
  signal: new AbortController().signal,
  agent: agentOf('s1'),
  ...over,
});

const okResult = (): ToolExecutionResult => ({
  isError: false,
  value: null,
  content: [{ type: 'text', text: 'wrote' }],
});
const errResult = (message: string, code?: string): ToolExecutionResult => ({
  isError: true,
  error: { message, ...(code ? { info: { name: 'ToolError', code } } : {}) },
  content: [{ type: 'text', text: message }],
});

/** The most recent update recorded on an observation (v5 closes via update+end). */
const lastUpdate = (obs: MockObservation): Record<string, unknown> => obs.updates.at(-1) ?? {};

// ------------------------------------------------------------------ tests

describe('dsh-langfuse plugin', () => {
  let ctx: Context;

  /** apply + await the initialization promise it returns. */
  async function setup(config = enabledConfig): Promise<void> {
    await apply(ctx, config);
  }

  beforeEach(() => {
    seq = 0;
    ctx = new Context();
  });

  it('exposes the plugin name and no hard injects', () => {
    expect(name).toBe('dsh-langfuse');
    expect(inject).toEqual([]);
  });

  it('registers no listeners when disabled or keyless', () => {
    const before = hookNames(ctx);
    apply(ctx, { ...enabledConfig, enabled: false });
    apply(ctx, { ...enabledConfig, publicKey: '' });
    expect(hookNames(ctx)).toEqual(before);
    expect(mocks.processors).toHaveLength(0);
  });

  it('returns the initialization promise, so plugin readiness covers the lazy import', async () => {
    const pending = apply(ctx, enabledConfig);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(mocks.processors).toHaveLength(1);
  });

  it('wires the seams at load and lazily constructs the export pipeline', async () => {
    await setup();
    expect(hookNames(ctx)).toEqual(
      expect.arrayContaining([
        'session/created',
        'session/event',
        'session/disposed',
        'session/flush',
        'llm/stream',
        'tools/execute',
        'subagent/start',
        'subagent/end',
      ]),
    );
    expect(mocks.processors[0].config).toEqual({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://langfuse.example',
    });
    // The processor is wired into an isolated provider (never the global one).
    expect(mocks.providers[0].config.spanProcessors).toEqual([mocks.processors[0]]);
    expect(mocks.isolatedProviders).toEqual([mocks.providers[0]]);
  });

  describe('trace lifecycle', () => {
    it('opens a root span per turn, feeds it the first user message, ends it on turn/end', async () => {
      await setup();

      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      expect(mocks.roots).toHaveLength(1);
      const root = fakeObs(mocks.roots[0]);
      expect(root.name).toBe('dsh-turn');
      expect(root.body).toEqual({ metadata: { turn: 0 } });
      // v5 correlating attributes ride every observation: the session id and
      // the trace name (older Langfuse servers derive the trace row from any
      // span carrying them — a root-only stamp can lose to child events).
      expect(root.attributes['session.id']).toBe('s1');
      expect(root.attributes['langfuse.trace.name']).toBe('dsh-turn');

      ctx.emit('session/event', sessionOf('s1'), userMessage('fix the bug'));
      ctx.emit('session/event', sessionOf('s1'), userMessage('ignored second'));
      expect(root.updates).toEqual([{ input: 'fix the bug' }]);
      // The trace-level input also rides the deprecated langfuse.trace.* keys
      // (older servers derive the trace row's IO from exactly those).
      expect(root.attributes['langfuse.trace.input']).toBe('fix the bug');

      // The turn's final answer becomes the trace's output at turn/end, and
      // ending the root is what exports the trace.
      ctx.emit('session/event', sessionOf('s1'), assistantMessage('done, the bug is fixed'));
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));
      expect(lastUpdate(root)).toEqual({
        output: 'done, the bug is fixed',
        metadata: { turn: 0, endReason: 'completed' },
      });
      expect(root.attributes['langfuse.trace.output']).toBe('done, the bug is fixed');
      expect(root.ended).toBe(1);

      // The next turn opens a fresh trace.
      ctx.emit('session/event', sessionOf('s1'), turnStart(1));
      expect(mocks.roots).toHaveLength(2);
      expect(fakeObs(mocks.roots[1]).body).toEqual({ metadata: { turn: 1 } });
    });

    it('forces a fresh trace root instead of adopting an ambient OTEL parent', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      // OTEL's canonical invalid span context: the SDK starts a new traceId.
      expect(fakeObs(mocks.roots[0]).parentContext).toEqual({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: 0,
      });
    });

    it('redacts the trace input and output when captureContent is off', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/event', sessionOf('s1'), userMessage('secret'));
      ctx.emit('session/event', sessionOf('s1'), assistantMessage('secret answer'));
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));
      const root = fakeObs(mocks.roots[0]);
      expect(root.updates).toEqual([
        { output: undefined, metadata: { turn: 0, endReason: 'completed' } },
      ]);
      expect(JSON.stringify(root.updates)).not.toContain('secret');
      // The trace-level IO keys (langfuse.trace.*) live in attributes, not
      // updates — they must stay empty under redaction too.
      expect(root.attributes['langfuse.trace.input']).toBeUndefined();
      expect(root.attributes['langfuse.trace.output']).toBeUndefined();
    });

    it('ends the abandoned root on session/disposed (un-ended spans never export)', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      const root = fakeObs(mocks.roots[0]);
      ctx.emit('session/disposed', sessionOf('s1'));
      expect(root.ended).toBe(1);
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      // No turn trace survived the dispose, so the call opened a fresh one.
      expect(mocks.roots).toHaveLength(2);
    });

    it('ends a stale root when the next turn replaces it', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      const stale = fakeObs(mocks.roots[0]);
      ctx.emit('session/event', sessionOf('s1'), turnStart(1));
      expect(stale.ended).toBe(1);
      expect(mocks.roots).toHaveLength(2);
    });
  });

  describe('llm/stream', () => {
    it('returns an AsyncIterable synchronously (the waterfall contract)', async () => {
      await setup();
      const stream = ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop()));
      expect(stream).not.toBeInstanceOf(Promise);
      expect(stream[Symbol.asyncIterator]).toBeTypeOf('function');
    });

    it('tees chunks unchanged and closes the generation with content and usage', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      const sent = [
        textDelta('he'),
        textDelta('llo'),
        usageChunk({ inputTokens: 10, outputTokens: 5 }),
        finishStop(),
      ];
      const stream = ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...sent));
      expect(await drain(stream)).toEqual(sent);

      const root = fakeObs(mocks.roots[0]);
      expect(root.generations).toHaveLength(1);
      const generation = root.generations[0];
      expect(generation.name).toBe('llm-call [hello]'); // renamed to the reply's first line at close
      expect(generation.body).toMatchObject({
        model: 'deepseek-chat',
        input: { messages: [], system: undefined, tools: undefined },
      });
      expect(lastUpdate(generation)).toMatchObject({
        output: 'hello',
        usageDetails: { input: 10, output: 5, total: 15 },
        level: 'DEFAULT',
        metadata: { finishReason: 'stop' },
      });
      expect(generation.ended).toBe(1);
      // The session id propagates down the explicit handle tree.
      expect(generation.attributes['session.id']).toBe('s1');
      expect(generation.attributes['langfuse.trace.name']).toBe('dsh-turn');
    });

    it('nests a purpose call under the turn trace with a purpose-tagged name', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      await drain(
        ctx.waterfall('llm/stream', optionsOf({ purpose: 'compaction' }), () =>
          streamOf(finishStop()),
        ),
      );
      const root = fakeObs(mocks.roots[0]);
      expect(mocks.roots).toHaveLength(1);
      expect(root.generations[0].name).toBe('llm-call [compaction]');
      expect(root.generations[0].body).toMatchObject({ metadata: { purpose: 'compaction' } });
    });

    it('captures tool calls from block-end chunks into the output', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(toolCallEnd('write_file', '{"path":"a.ts"}'), finishStop()),
        ),
      );
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(lastUpdate(generation)).toMatchObject({
        output: { text: '', toolCalls: [{ name: 'write_file', arguments: '{"path":"a.ts"}' }] },
        metadata: { finishReason: 'stop', toolCallCount: 1 },
      });
    });

    it('sends the request parameters as modelParameters (stop list serialized)', async () => {
      await setup();
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ stop: ['END-OF-SECRET'], temperature: 0.5, maxTokens: 100 }),
          () => streamOf(finishStop()),
        ),
      );
      expect(fakeObs(mocks.roots[0]).generations[0].body).toMatchObject({
        // v5 modelParameters values are string|number — the stop list serializes.
        modelParameters: { stop: '["END-OF-SECRET"]', temperature: 0.5, maxTokens: 100 },
      });
    });

    it('records the loop-built request as a nested llm-request span', async () => {
      await setup();
      const sent = [textDelta('hi'), finishStop()];
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...sent)));
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(generation.spans).toHaveLength(1);
      const requestSpan = generation.spans[0];
      expect(requestSpan.name).toBe('llm-request');
      expect(requestSpan.body).toMatchObject({
        input: { provider: 'test', model: 'deepseek-chat', messages: [], sessionId: 's1' },
        metadata: { provider: 'test' },
      });
      // The AbortSignal is not JSON-safe and must not cross to Langfuse.
      expect((requestSpan.body as { input: Record<string, unknown> }).input.signal).toBeUndefined();
      // The span's output is the collected chunk stream (the raw response).
      expect(lastUpdate(requestSpan)).toMatchObject({
        output: sent,
        level: 'DEFAULT',
        metadata: { chunkCount: 2 },
      });
      expect(requestSpan.ended).toBe(1);
      expect(requestSpan.attributes['session.id']).toBe('s1');
    });

    it('sets completionStartTime at the first token delta, not at block boundaries', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(blockStart(), textDelta('hi'), finishStop()),
        ),
      );
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        completionStartTime: expect.any(Date),
      });
    });

    it('leaves completionStartTime unset for a token-less response', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(
            blockStart(),
            textDelta(''), // empty heartbeat delta is not a token
            usageChunk({ inputTokens: 1, outputTokens: 0 }),
            finishStop(),
          ),
        ),
      );
      expect(
        lastUpdate(fakeObs(mocks.roots[0]).generations[0]).completionStartTime,
      ).toBeUndefined();
    });

    it('logs metadata only when captureContent is off', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(
            textDelta('secret'),
            usageChunk({ inputTokens: 1, outputTokens: 1 }),
            finishStop(),
          ),
        ),
      );
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(generation.body).toMatchObject({ input: { messageCount: 0 } });
      expect(lastUpdate(generation)).toMatchObject({
        output: undefined,
        usageDetails: { input: 1, output: 1, total: 2 },
      });
    });

    it('marks a terminal error finish chunk as ERROR', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('partial'), finishError('provider exploded')),
        ),
      );
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: 'provider exploded',
        metadata: { finishReason: 'error', errorCode: 'BOOM' },
      });
    });

    it('marks an aborted finish as WARNING', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishAborted('user cancelled'))),
      );
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        level: 'WARNING',
        statusMessage: 'user cancelled',
      });
    });

    it('reports and rethrows mid-stream iteration failures, keeping partial progress', async () => {
      await setup();
      const partial = [textDelta('partial'), usageChunk({ inputTokens: 10, outputTokens: 5 })];
      const stream = ctx.waterfall('llm/stream', optionsOf(), async function* () {
        yield* partial;
        throw new Error('adapter boom');
      });
      await expect(drain(stream)).rejects.toThrow('adapter boom');
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(generation.name).toBe('llm-call [partial]');
      expect(lastUpdate(generation)).toMatchObject({
        output: 'partial',
        usageDetails: { input: 10, output: 5, total: 15 },
        level: 'ERROR',
        statusMessage: 'adapter boom',
      });
      // The request span keeps the chunks streamed before the throw too.
      expect(lastUpdate(generation.spans[0])).toMatchObject({
        output: partial,
        level: 'ERROR',
        metadata: { chunkCount: 2 },
      });
    });

    it('marks the generation incomplete (WARNING) when the stream ends without finish', async () => {
      await setup();
      const stream = ctx.waterfall('llm/stream', optionsOf(), () =>
        streamOf(textDelta('a'), textDelta('b'), finishStop()),
      );
      for await (const chunk of stream) {
        void chunk;
        break;
      }
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        output: 'a',
        level: 'WARNING',
        statusMessage: 'stream closed before the terminal finish chunk',
        metadata: { finishReason: undefined, incomplete: true },
      });
    });

    it('reports and propagates a synchronous next() failure', async () => {
      await setup();
      expect(() =>
        ctx.waterfall('llm/stream', optionsOf(), () => {
          throw new Error('route boom');
        }),
      ).toThrow('route boom');
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: 'route boom',
      });
    });

    it('opens a fresh trace per call without a session or open turn', async () => {
      await setup();
      // Session-less hand-built call: one-off trace without a session id —
      // and with no session lifecycle to close it, the call itself ends it
      // (un-ended spans never export in v5).
      const { sessionId, ...noSession } = optionsOf();
      await drain(ctx.waterfall('llm/stream', noSession, () => streamOf(finishStop())));
      expect(fakeObs(mocks.roots[0]).attributes['session.id']).toBeUndefined();
      expect(fakeObs(mocks.roots[0]).ended).toBe(1);

      // Between-turns maintenance calls SHARE one cached one-off trace (no
      // per-call fragmentation), and a later turn/start still opens its own.
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      expect(fakeObs(mocks.roots[1]).attributes['session.id']).toBe('s1');
      expect(mocks.roots).toHaveLength(2);
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      expect(mocks.roots).toHaveLength(3);
    });

    it('degrades to an untraced stream when Langfuse fails, logging with the prefix', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setup();
      mocks.state.failCreate = true;

      const stream = ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop()));
      expect(await drain(stream)).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[dsh-langfuse] trace creation failed:',
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe('redaction (captureContent: false)', () => {
    const redacted = { ...enabledConfig, captureContent: false };

    it('withholds stop sequences, keeping only their count', async () => {
      await setup(redacted);
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ stop: ['SECRET-STOP-A', 'SECRET-STOP-B'], temperature: 0.5 }),
          () => streamOf(finishStop()),
        ),
      );
      const body = fakeObs(mocks.roots[0]).generations[0].body as {
        modelParameters?: Record<string, unknown>;
      };
      expect(body.modelParameters).toEqual({ temperature: 0.5, stopCount: 2 });
    });

    it('redacts the nested request span body to counts', async () => {
      await setup(redacted);
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      const requestSpan = fakeObs(mocks.roots[0]).generations[0].spans[0];
      expect(requestSpan.name).toBe('llm-request');
      expect(requestSpan.body).toMatchObject({
        input: { messageCount: 0, hasSystem: false },
        metadata: { provider: 'test' },
      });
      // Chunks are content too: only the structural count crosses.
      expect(lastUpdate(requestSpan)).toMatchObject({
        output: undefined,
        metadata: { chunkCount: 1 },
      });
    });

    it('withholds finish failure text, keeping level and error code', async () => {
      await setup(redacted);
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(finishError('401 invalid key sk-live-secret')),
        ),
      );
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: undefined,
        metadata: { finishReason: 'error', errorCode: 'BOOM' },
      });
    });

    it('withholds thrown LLM error text', async () => {
      await setup(redacted);
      const stream = ctx.waterfall('llm/stream', optionsOf(), async function* () {
        yield textDelta('partial');
        throw new Error('read EACCES /home/user/.ssh/id_rsa');
      });
      await expect(drain(stream)).rejects.toThrow('EACCES');
      expect(lastUpdate(fakeObs(mocks.roots[0]).generations[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: undefined,
      });
    });

    it('withholds tool failure text, keeping level and error code', async () => {
      await setup(redacted);
      await ctx.waterfall('tools/execute', execOf(), async () =>
        errResult('cat: /etc/shadow: permission denied', 'E_PERM'),
      );
      const span = fakeObs(mocks.roots[0]).spans[0];
      // Argument summaries are content too: no [path] suffix when redacted.
      expect(span.name).toBe('tool:write_file');
      expect(lastUpdate(span)).toMatchObject({
        level: 'ERROR',
        statusMessage: undefined,
        metadata: { errorCode: 'E_PERM' },
      });
    });

    it('withholds thrown tool error text', async () => {
      await setup(redacted);
      await expect(
        ctx.waterfall('tools/execute', execOf(), async () => {
          throw new Error('connect to postgres://user:pass@db failed');
        }),
      ).rejects.toThrow('postgres://');
      expect(lastUpdate(fakeObs(mocks.roots[0]).spans[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: undefined,
      });
    });
  });

  describe('tools/execute', () => {
    it("spans one tool dispatch under the agent's session trace", async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));

      const result = await ctx.waterfall('tools/execute', execOf(), async () => okResult());
      expect(result).toEqual(okResult());

      const root = fakeObs(mocks.roots[0]);
      expect(root.spans).toHaveLength(1);
      expect(root.spans[0].name).toBe('tool:write_file [a.ts]');
      expect(root.spans[0].body).toMatchObject({
        input: { path: 'a.ts' },
        metadata: { callId: 'c1', toolName: 'write_file' },
      });
      expect(lastUpdate(root.spans[0])).toMatchObject({
        output: [{ type: 'text', text: 'wrote' }],
        level: 'DEFAULT',
      });
      expect(root.spans[0].ended).toBe(1);
      expect(root.spans[0].attributes['session.id']).toBe('s1');
    });

    it('marks an isError result as ERROR with the failure message', async () => {
      await setup();
      const result = await ctx.waterfall('tools/execute', execOf(), async () => errResult('nope'));
      expect(result.isError).toBe(true);
      expect(lastUpdate(fakeObs(mocks.roots[0]).spans[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: 'nope',
      });
    });

    it('reports and rethrows a dispatch failure', async () => {
      await setup();
      await expect(
        ctx.waterfall('tools/execute', execOf(), async () => {
          throw new Error('dispatch boom');
        }),
      ).rejects.toThrow('dispatch boom');
      expect(lastUpdate(fakeObs(mocks.roots[0]).spans[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: 'dispatch boom',
      });
    });

    it('falls back to a session-less trace when the exec carries no agent', async () => {
      await setup();
      await ctx.waterfall('tools/execute', execOf({ agent: undefined }), async () => okResult());
      const root = fakeObs(mocks.roots[0]);
      expect(root.attributes['session.id']).toBeUndefined();
      expect(root.spans).toHaveLength(1);
      // No session lifecycle will close a session-less root — the dispatch
      // itself ends it (un-ended spans never export in v5).
      expect(root.ended).toBe(1);
    });
  });

  describe('subagent tracing', () => {
    const optionsFor = (sessionId: string) =>
      optionsOf({ sessionId: sessionId as unknown as GenerateOptions['sessionId'] });

    it('nests a subagent run under the enclosing delegation tool span', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));

      await ctx.waterfall(
        'tools/execute',
        execOf({ name: 'subagent', arguments: { description: 'read marker', prompt: 'go' } }),
        async () => {
          // Inside the foreground delegation dispatch: the child session
          // appears, reports, runs its LLM call, and settles.
          ctx.emit('session/created', childSessionOf('c1', 's1'));
          ctx.emit('subagent/start', subagentStart('c1'));
          await drain(
            ctx.waterfall('llm/stream', optionsFor('c1'), () =>
              streamOf(textDelta('child answer'), finishStop()),
            ),
          );
          ctx.emit('subagent/end', subagentEnd('c1', 'completed'));
          return okResult();
        },
      );

      expect(mocks.roots).toHaveLength(1);
      const root = fakeObs(mocks.roots[0]);
      expect(root.generations).toHaveLength(0);

      const delegationSpan = root.spans[0];
      expect(delegationSpan.name).toBe('tool:subagent [read marker]');
      expect(delegationSpan.spans).toHaveLength(1);

      const subSpan = delegationSpan.spans[0];
      expect(subSpan.name).toBe('subagent');
      expect(subSpan.body).toMatchObject({
        metadata: { childSessionId: 'c1', delegationDepth: 1 },
      });
      // subagent/start enriches with provider facts.
      expect(subSpan.updates).toContainEqual({ metadata: { provider: 'spawn', local: true } });
      // The child's generation nests under the subagent span, not the trace.
      expect(subSpan.generations).toHaveLength(1);
      expect(subSpan.generations[0].name).toBe('llm-call [child answer]');
      // The session id propagates down the whole delegation chain.
      expect(subSpan.attributes['session.id']).toBe('s1');
      expect(subSpan.attributes['langfuse.trace.name']).toBe('dsh-turn');
      expect(subSpan.generations[0].attributes['session.id']).toBe('s1');
      expect(lastUpdate(subSpan)).toMatchObject({
        output: { stopReason: 'completed' },
        level: 'DEFAULT',
      });
      expect(subSpan.ended).toBe(1);
      expect(delegationSpan.ended).toBe(1);
    });

    it('gives child sessions no turn trace and feeds the prompt to the span', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));

      // The child's whole turn lifecycle must not open a trace of its own.
      ctx.emit('session/event', sessionOf('c1'), turnStart(0));
      ctx.emit('session/event', sessionOf('c1'), userMessage('read the marker file'));
      ctx.emit('session/event', sessionOf('c1'), turnEnd(0));

      expect(mocks.roots).toHaveLength(1);
      const root = fakeObs(mocks.roots[0]);
      // No open delegation span: the subagent span parents at the trace root.
      const subSpan = root.spans[0];
      expect(subSpan.name).toBe('subagent');
      expect(subSpan.updates).toContainEqual({ input: 'read the marker file' });
      // The subagent span is not a trace root: it carries the trace name but
      // never the trace-level IO keys.
      expect(subSpan.attributes['langfuse.trace.name']).toBe('dsh-turn');
      expect(subSpan.attributes['langfuse.trace.input']).toBeUndefined();
      expect(subSpan.attributes['langfuse.trace.output']).toBeUndefined();
    });

    it('enriches the span name from the subagent/descriptor event', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit(
        'session/event',
        sessionOf('c1'),
        ev('subagent/descriptor', {
          version: 2,
          mode: 'one-shot',
          provider: 'spawn',
          label: 'read marker',
        }),
      );
      const subSpan = fakeObs(mocks.roots[0]).spans[0];
      // v5 has no name attribute — renames ride otelSpan.updateName.
      expect(subSpan.name).toBe('subagent: read marker');
      expect(subSpan.updates).toContainEqual({
        metadata: { mode: 'one-shot', provider: 'spawn' },
      });
    });

    it('marks a failed subagent run as ERROR', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('subagent/end', subagentEnd('c1', 'error'));
      const subSpan = fakeObs(mocks.roots[0]).spans[0];
      expect(lastUpdate(subSpan)).toMatchObject({
        level: 'ERROR',
        output: { stopReason: 'error' },
      });
      expect(subSpan.ended).toBe(1);
    });

    it('withholds the final assistant message when captureContent is off', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit(
        'session/event',
        sessionOf('c1'),
        ev('subagent/descriptor', {
          version: 2,
          mode: 'one-shot',
          provider: 'spawn',
          label: 'secret delegation label',
        }),
      );
      ctx.emit('subagent/end', subagentEnd('c1', 'error'));
      const subSpan = fakeObs(mocks.roots[0]).spans[0];
      expect(lastUpdate(subSpan)).toMatchObject({ output: { stopReason: 'error' } });
      expect(lastUpdate(subSpan).output).not.toHaveProperty('lastAssistantMessage');
      // The descriptor label is model-authored content — the span keeps the
      // bare name when redacted.
      expect(subSpan.name).toBe('subagent');
      for (const update of subSpan.updates) {
        expect(JSON.stringify(update)).not.toContain('secret delegation label');
      }
    });

    it('keeps the child span open on session/disposed so subagent/end can close it', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      const subSpan = fakeObs(mocks.roots[0]).spans[0];

      // Background/continuable children dispose their session before
      // subagent/end fires — the dispose must NOT close the span.
      ctx.emit('session/disposed', sessionOf('c1'));
      expect(subSpan.ended).toBe(0);

      ctx.emit('subagent/end', subagentEnd('c1', 'completed'));
      expect(lastUpdate(subSpan)).toMatchObject({
        output: { stopReason: 'completed' },
        level: 'DEFAULT',
      });
      expect(subSpan.ended).toBe(1);
    });

    it('resolves nested (depth-2) delegations to the root trace', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('session/created', childSessionOf('c2', 'c1', 2));

      const root = fakeObs(mocks.roots[0]);
      const c1Span = root.spans[0];
      const c2Span = c1Span.spans[0];
      expect(c2Span.body).toMatchObject({
        metadata: { childSessionId: 'c2', delegationDepth: 2 },
      });

      await drain(ctx.waterfall('llm/stream', optionsFor('c2'), () => streamOf(finishStop())));
      expect(mocks.roots).toHaveLength(1);
      expect(c2Span.generations).toHaveLength(1);
      expect(c2Span.generations[0].attributes['session.id']).toBe('s1');
    });

    it('nests the child session’s own tool spans under its subagent span', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));

      await ctx.waterfall(
        'tools/execute',
        execOf({ agent: agentOf('c1'), name: 'read_file', arguments: { path: 'ci-marker.txt' } }),
        async () => okResult(),
      );

      const root = fakeObs(mocks.roots[0]);
      const subSpan = root.spans[0];
      expect(subSpan.spans).toHaveLength(1);
      expect(subSpan.spans[0].name).toBe('tool:read_file [ci-marker.txt]');
      expect(subSpan.spans[0].body).toMatchObject({ input: { path: 'ci-marker.txt' } });
      expect(root.spans).toHaveLength(1);
    });
  });

  describe('durability', () => {
    it('flushes the exporter at the session/flush checkpoint', async () => {
      await setup();
      await ctx.parallel('session/flush', sessionOf('s1'));
      expect(mocks.providers[0].forceFlush).toHaveBeenCalledTimes(1);
    });

    it('shuts the exporter down and releases the isolated provider when the fiber unloads', async () => {
      await setup();
      await ctx.fiber.dispose();
      expect(mocks.providers[0].shutdown).toHaveBeenCalledTimes(1);
      expect(mocks.isolatedProviders.at(-1)).toBeNull();
    });

    it('ends every still-open observation at fiber unload (un-ended spans never export)', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      const root = fakeObs(mocks.roots[0]);
      const subSpan = root.spans[0];

      await ctx.fiber.dispose();
      expect(root.ended).toBe(1);
      expect(subSpan.ended).toBe(1);
      expect(mocks.providers[0].shutdown).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// client.ts — reporter unit tests (colocated here with the plugin tests so
// the whole package shares one inlined SDK mock)
// ---------------------------------------------------------------------------

const config = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'https://langfuse.example' };

describe('usageOf', () => {
  it('keeps usageDetails buckets disjoint while totals stay the bucket sum', () => {
    expect(
      usageOf({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3 }),
    ).toEqual({
      input: 10,
      output: 5,
      total: 20,
      input_cache_read: 2,
      input_cache_creation: 3,
    });
  });

  it('omits absent buckets and subtracts reasoning into its own bucket', () => {
    expect(usageOf({ inputTokens: 10, outputTokens: 5, reasoningTokens: 4 })).toEqual({
      input: 10,
      output: 1,
      total: 15,
      output_reasoning: 4,
    });
  });

  it('coalesces absent primary fields instead of emitting NaN', () => {
    expect(usageOf({} as never)).toEqual({ input: 0, output: 0, total: 0 });
    expect(usageOf({ reasoningTokens: 4 } as never).output).toBe(0);
  });
});

describe('LangfuseReporter', () => {
  it('lazily constructs the export pipeline with the connection config', async () => {
    const reporter = new LangfuseReporter(config);
    expect(mocks.processors).toHaveLength(0);
    await reporter.ready;
    expect(mocks.processors[0].config).toEqual(config);
    expect(mocks.providers[0].config.spanProcessors).toEqual([mocks.processors[0]]);
    expect(mocks.isolatedProviders).toEqual([mocks.providers[0]]);
  });

  it('creates trace roots, generations and spans through the observation API', async () => {
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const root = fakeSpan(
      reporter.openTrace({ name: 'dsh-turn', sessionId: 's1', metadata: { turn: 0 } }),
    );
    expect(root.name).toBe('dsh-turn');
    expect(root.body).toEqual({ metadata: { turn: 0 } });
    expect(root.attributes['session.id']).toBe('s1');
    expect(root.attributes['langfuse.trace.name']).toBe('dsh-turn');
    expect(root.parentContext).toEqual({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 0,
    });

    reporter.updateSpan(root, { input: 'hello' });
    expect(root.updates[0]).toEqual({ input: 'hello' });
    // Trace roots also carry the deprecated langfuse.trace.* IO keys (older
    // Langfuse servers derive the trace row's IO from exactly those).
    expect(root.attributes['langfuse.trace.input']).toBe('hello');

    const generation = fakeGen(
      reporter.startGeneration(root, {
        name: 'llm-call',
        model: 'deepseek-chat',
        input: { messages: [] },
      }),
    );
    expect(generation.asType).toBe('generation');
    expect(generation.body).toMatchObject({ model: 'deepseek-chat' });
    expect(generation.attributes['session.id']).toBe('s1');
    expect(generation.attributes['langfuse.trace.name']).toBe('dsh-turn');

    reporter.endGeneration(generation, {
      name: 'llm-call [hi]',
      output: 'hi',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      level: 'DEFAULT',
    });
    expect(lastUpdate(generation)).toMatchObject({
      output: 'hi',
      usageDetails: { input: 10, output: 5, total: 17, input_cache_read: 2 },
      level: 'DEFAULT',
    });
    expect(generation.name).toBe('llm-call [hi]');
    expect(generation.ended).toBe(1);

    const span = fakeSpan(
      reporter.startSpan(root, { name: 'tool:write_file', input: { path: 'a' } }),
    );
    reporter.endSpan(span, { output: [], level: 'ERROR', statusMessage: 'nope' });
    expect(lastUpdate(span)).toMatchObject({ level: 'ERROR', statusMessage: 'nope' });
    expect(span.ended).toBe(1);

    // Observations parent nested spans (e.g. the llm-request detail span),
    // inheriting the session id down the handle tree.
    const nested = fakeSpan(reporter.startSpan(generation, { name: 'llm-request' }));
    expect(nested.attributes['session.id']).toBe('s1');
    reporter.endSpan(nested, { level: 'DEFAULT' });
    expect(generation.spans[0].name).toBe('llm-request');
    expect(nested.ended).toBe(1);
  });

  it('is a silent no-op before init settles', () => {
    const reporter = new LangfuseReporter(config);
    expect(reporter.openTrace({ name: 't' })).toBeNull();
    expect(mocks.processors).toHaveLength(0);
  });

  it('degrades to a no-op when pipeline construction fails, logging with the prefix', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.state.throwOnProcessor = true;
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
    const root = fakeSpan(reporter.openTrace({ name: 't' }));
    const generation = fakeGen(reporter.startGeneration(root, { name: 'g' }));
    const span = fakeSpan(reporter.startSpan(root, { name: 's' }));
    errorSpy.mockClear();

    const boom = () => {
      throw new Error('ingestion down');
    };
    mocks.state.failCreate = true;
    expect(reporter.openTrace({ name: 't' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] trace creation failed:',
      expect.any(Error),
    );
    expect(reporter.startGeneration(root, { name: 'g' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] generation creation failed:',
      expect.any(Error),
    );
    expect(reporter.startSpan(root, { name: 's' })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] span creation failed:',
      expect.any(Error),
    );
    mocks.state.failCreate = false;

    vi.spyOn(root, 'update').mockImplementationOnce(boom);
    // Trace roots ARE spans in v5 — the root's update/end ride the span methods.
    expect(() => reporter.updateSpan(root, { input: 'x' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] span update failed:', expect.any(Error));

    vi.spyOn(root, 'end').mockImplementationOnce(boom);
    expect(() => reporter.endSpan(root)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] span end failed:', expect.any(Error));

    vi.spyOn(generation, 'update').mockImplementationOnce(boom);
    expect(() => reporter.endGeneration(generation, { level: 'DEFAULT' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      '[dsh-langfuse] generation end failed:',
      expect.any(Error),
    );

    vi.spyOn(span, 'update').mockImplementationOnce(boom);
    expect(() => reporter.updateSpan(span, { name: 'x' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] span update failed:', expect.any(Error));

    vi.spyOn(span, 'update').mockImplementationOnce(boom);
    expect(() => reporter.endSpan(span, { level: 'DEFAULT' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] span end failed:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('flushes and shuts the exporter down, swallowing failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const provider = mocks.providers[0];

    await reporter.flush();
    expect(provider.forceFlush).toHaveBeenCalledTimes(1);

    provider.forceFlush.mockRejectedValueOnce(new Error('flush boom'));
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] flush failed:', expect.any(Error));

    provider.shutdown.mockRejectedValueOnce(new Error('shutdown boom'));
    await expect(reporter.shutdown()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] shutdown failed:', expect.any(Error));

    // After shutdown the reporter is inert.
    expect(reporter.openTrace({ name: 't' })).toBeNull();
    errorSpy.mockRestore();
  });

  it('chains flush and shutdown behind the lazy init', async () => {
    // Called synchronously after construction — before `ready` can have
    // settled — both must still wait for the pipeline to exist.
    const flushing = new LangfuseReporter(config);
    await flushing.flush();
    expect(mocks.providers[0].forceFlush).toHaveBeenCalledTimes(1);

    const shuttingDown = new LangfuseReporter(config);
    await shuttingDown.shutdown();
    expect(mocks.providers[1].shutdown).toHaveBeenCalledTimes(1);
  });
});
