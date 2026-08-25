import { Context, type Events } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CallId, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools';
import type { LangfuseGenerationClient, LangfuseSpanClient, LangfuseTraceClient } from 'langfuse';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangfuseReporter, usageOf } from './client.js';
import { apply, inject, name } from './index.js';

// The shared Langfuse SDK mock: captures every client, trace, generation and
// span created through the mocked module (vi.mock below). Vitest isolates
// this file, so the captured state is per-suite; beforeEach resets it.
const mocks = vi.hoisted(() => {
  const instances: MockLangfuse[] = [];
  const state = { failTrace: false, throwOnConstruct: false };
  class MockObservation {
    updates: unknown[] = [];
    ends: unknown[] = [];
    generations: MockObservation[] = [];
    spans: MockObservation[] = [];
    constructor(readonly body: unknown) {}
    update(body: unknown) {
      this.updates.push(body);
      return this;
    }
    end(body?: unknown) {
      this.ends.push(body ?? {});
      return this;
    }
    generation(body: unknown) {
      const generation = new MockObservation(body);
      this.generations.push(generation);
      return generation;
    }
    span(body: unknown) {
      const span = new MockObservation(body);
      this.spans.push(span);
      return span;
    }
  }
  class MockLangfuse {
    traces: MockObservation[] = [];
    flushAsync = vi.fn(async () => {});
    shutdownAsync = vi.fn(async () => {});
    constructor(readonly config: unknown) {
      if (state.throwOnConstruct) throw new Error('bad keys');
      instances.push(this);
    }
    trace(body?: unknown) {
      if (state.failTrace) throw new Error('ingestion down');
      const trace = new MockObservation(body ?? {});
      this.traces.push(trace);
      return trace;
    }
  }
  return { instances, state, MockLangfuse, MockObservation };
});

vi.mock('langfuse', () => ({ Langfuse: mocks.MockLangfuse }));

type MockObservation = InstanceType<typeof mocks.MockObservation>;
/** The reporter/plugin speak langfuse client types; the objects behind them
 * are the mocks. Intersections keep handles mock-readable and passable back
 * into reporter methods. */
const fakeTrace = (value: unknown): MockObservation & LangfuseTraceClient => value as never;
const fakeSpan = (value: unknown): MockObservation & LangfuseSpanClient => value as never;
const fakeGen = (value: unknown): MockObservation & LangfuseGenerationClient => value as never;
const fakeObs = (value: unknown): MockObservation => value as MockObservation;

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.state.failTrace = false;
  mocks.state.throwOnConstruct = false;
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
  block: { type: 'tool-call', id: 'c1' as CallId, name: toolName, arguments: args },
});

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const received: StreamChunk[] = [];
  for await (const chunk of stream) received.push(chunk);
  return received;
}

const execOf = (over: Partial<ToolDispatchExecution> = {}): ToolDispatchExecution => ({
  callId: 'c1' as CallId,
  rootCallId: 'c1' as CallId,
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
    expect(mocks.instances).toHaveLength(0);
  });

  it('returns the initialization promise, so plugin readiness covers the lazy import', async () => {
    const pending = apply(ctx, enabledConfig);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(mocks.instances).toHaveLength(1);
  });

  it('wires the seams at load and lazily constructs the client', async () => {
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
    expect(mocks.instances[0].config).toEqual({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://langfuse.example',
    });
  });

  describe('trace lifecycle', () => {
    it('opens a trace per turn, feeds it the first user message, closes on turn/end', async () => {
      await setup();
      const client = mocks.instances[0];

      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      expect(client.traces).toHaveLength(1);
      expect(client.traces[0].body).toEqual({
        name: 'dsh-turn',
        sessionId: 's1',
        input: undefined,
        metadata: { turn: 0 },
      });

      ctx.emit('session/event', sessionOf('s1'), userMessage('fix the bug'));
      ctx.emit('session/event', sessionOf('s1'), userMessage('ignored second'));
      expect(client.traces[0].updates).toEqual([{ input: 'fix the bug', metadata: undefined }]);

      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));
      expect(client.traces[0].updates[1]).toEqual({
        input: undefined,
        metadata: { turn: 0, endReason: 'completed' },
      });

      // The next turn opens a fresh trace.
      ctx.emit('session/event', sessionOf('s1'), turnStart(1));
      expect(client.traces).toHaveLength(2);
      expect(client.traces[1].body).toMatchObject({ sessionId: 's1', metadata: { turn: 1 } });
    });

    it('redacts the trace input when captureContent is off', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/event', sessionOf('s1'), userMessage('secret'));
      expect(mocks.instances[0].traces[0].updates).toHaveLength(0);
    });

    it('drops the session state on session/disposed', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/disposed', sessionOf('s1'));
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      // No turn trace survived the dispose, so the call opened a fresh one.
      expect(mocks.instances[0].traces).toHaveLength(2);
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

      const trace = fakeTrace(mocks.instances[0].traces[0]);
      expect(trace.generations).toHaveLength(1);
      expect(trace.generations[0].body).toMatchObject({
        name: 'llm-call',
        model: 'deepseek-chat',
        input: { messages: [], system: undefined, tools: undefined },
      });
      expect(trace.generations[0].ends[0]).toMatchObject({
        output: 'hello',
        usage: { input: 10, output: 5, total: 15 },
        level: 'DEFAULT',
        metadata: { finishReason: 'stop' },
      });
    });

    it('nests a purpose call under the turn trace with a purpose-tagged name', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      await drain(
        ctx.waterfall('llm/stream', optionsOf({ purpose: 'compaction' }), () =>
          streamOf(finishStop()),
        ),
      );
      const trace = fakeTrace(mocks.instances[0].traces[0]);
      expect(mocks.instances[0].traces).toHaveLength(1);
      expect(trace.generations[0].body).toMatchObject({
        name: 'llm-call [compaction]',
        metadata: { purpose: 'compaction' },
      });
    });

    it('captures tool calls from block-end chunks into the output', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(toolCallEnd('write_file', '{"path":"a.ts"}'), finishStop()),
        ),
      );
      const generation = fakeObs(mocks.instances[0].traces[0].generations[0]);
      expect(generation.ends[0]).toMatchObject({
        output: { text: '', toolCalls: [{ name: 'write_file', arguments: '{"path":"a.ts"}' }] },
        metadata: { finishReason: 'stop', toolCallCount: 1 },
      });
    });

    it('sends the request parameters as modelParameters', async () => {
      await setup();
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ stop: ['END-OF-SECRET'], temperature: 0.5, maxTokens: 100 }),
          () => streamOf(finishStop()),
        ),
      );
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).body).toMatchObject({
        modelParameters: { stop: ['END-OF-SECRET'], temperature: 0.5, maxTokens: 100 },
      });
    });

    it('records the loop-built request as a nested llm-request span', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(textDelta('hi'), finishStop())),
      );
      const generation = fakeObs(mocks.instances[0].traces[0].generations[0]);
      expect(generation.spans).toHaveLength(1);
      const requestSpan = generation.spans[0];
      expect(requestSpan.body).toMatchObject({
        name: 'llm-request',
        input: { provider: 'test', model: 'deepseek-chat', messages: [], sessionId: 's1' },
        metadata: { provider: 'test' },
      });
      // The AbortSignal is not JSON-safe and must not cross to Langfuse.
      expect((requestSpan.body as { input: Record<string, unknown> }).input.signal).toBeUndefined();
      expect(requestSpan.ends[0]).toMatchObject({ level: 'DEFAULT' });
    });

    it('sets completionStartTime at the first token delta, not at block boundaries', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(blockStart(), textDelta('hi'), finishStop()),
        ),
      );
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
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
      const end = fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0] as {
        completionStartTime?: unknown;
      };
      expect(end.completionStartTime).toBeUndefined();
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
      const generation = fakeObs(mocks.instances[0].traces[0].generations[0]);
      expect(generation.body).toMatchObject({ input: { messageCount: 0 } });
      expect(generation.ends[0]).toMatchObject({
        output: undefined,
        usage: { input: 1, output: 1, total: 2 },
      });
    });

    it('marks a terminal error finish chunk as ERROR', async () => {
      await setup();
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('partial'), finishError('provider exploded')),
        ),
      );
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
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
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
        level: 'WARNING',
        statusMessage: 'user cancelled',
      });
    });

    it('reports and rethrows mid-stream iteration failures, keeping partial progress', async () => {
      await setup();
      const stream = ctx.waterfall('llm/stream', optionsOf(), async function* () {
        yield textDelta('partial');
        yield usageChunk({ inputTokens: 10, outputTokens: 5 });
        throw new Error('adapter boom');
      });
      await expect(drain(stream)).rejects.toThrow('adapter boom');
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
        output: 'partial',
        usage: { input: 10, output: 5, total: 15 },
        level: 'ERROR',
        statusMessage: 'adapter boom',
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
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
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
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
        level: 'ERROR',
        statusMessage: 'route boom',
      });
    });

    it('opens a fresh trace per call without a session or open turn', async () => {
      await setup();
      // Session-less hand-built call: one-off trace without a sessionId.
      const { sessionId, ...noSession } = optionsOf();
      await drain(ctx.waterfall('llm/stream', noSession, () => streamOf(finishStop())));
      expect(mocks.instances[0].traces[0].body).toMatchObject({ sessionId: undefined });

      // Between-turns maintenance calls SHARE one cached one-off trace (no
      // per-call fragmentation), and a later turn/start still opens its own.
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      expect(mocks.instances[0].traces[1].body).toMatchObject({ sessionId: 's1' });
      expect(mocks.instances[0].traces).toHaveLength(2);
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      expect(mocks.instances[0].traces).toHaveLength(3);
    });

    it('degrades to an untraced stream when Langfuse fails, logging with the prefix', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await setup();
      mocks.state.failTrace = true;

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
      const body = fakeObs(mocks.instances[0].traces[0].generations[0]).body as {
        modelParameters?: Record<string, unknown>;
      };
      expect(body.modelParameters).toEqual({ temperature: 0.5, stopCount: 2 });
    });

    it('redacts the nested request span body to counts', async () => {
      await setup(redacted);
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      const requestSpan = fakeObs(mocks.instances[0].traces[0].generations[0]).spans[0];
      expect(requestSpan.body).toMatchObject({
        name: 'llm-request',
        input: { messageCount: 0, hasSystem: false },
        metadata: { provider: 'test' },
      });
    });

    it('withholds finish failure text, keeping level and error code', async () => {
      await setup(redacted);
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(finishError('401 invalid key sk-live-secret')),
        ),
      );
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
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
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
        level: 'ERROR',
        statusMessage: undefined,
      });
    });

    it('withholds tool failure text, keeping level and error code', async () => {
      await setup(redacted);
      await ctx.waterfall('tools/execute', execOf(), async () =>
        errResult('cat: /etc/shadow: permission denied', 'E_PERM'),
      );
      expect(fakeObs(mocks.instances[0].traces[0].spans[0]).ends[0]).toMatchObject({
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
      expect(fakeObs(mocks.instances[0].traces[0].spans[0]).ends[0]).toMatchObject({
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

      const trace = fakeTrace(mocks.instances[0].traces[0]);
      expect(trace.spans).toHaveLength(1);
      expect(trace.spans[0].body).toMatchObject({
        name: 'tool:write_file',
        input: { path: 'a.ts' },
        metadata: { callId: 'c1', toolName: 'write_file' },
      });
      expect(trace.spans[0].ends[0]).toMatchObject({
        output: [{ type: 'text', text: 'wrote' }],
        level: 'DEFAULT',
      });
    });

    it('marks an isError result as ERROR with the failure message', async () => {
      await setup();
      const result = await ctx.waterfall('tools/execute', execOf(), async () => errResult('nope'));
      expect(result.isError).toBe(true);
      expect(fakeObs(mocks.instances[0].traces[0].spans[0]).ends[0]).toMatchObject({
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
      expect(fakeObs(mocks.instances[0].traces[0].spans[0]).ends[0]).toMatchObject({
        level: 'ERROR',
        statusMessage: 'dispatch boom',
      });
    });

    it('falls back to a session-less trace when the exec carries no agent', async () => {
      await setup();
      await ctx.waterfall('tools/execute', execOf({ agent: undefined }), async () => okResult());
      const trace = fakeTrace(mocks.instances[0].traces[0]);
      expect(trace.body).toMatchObject({ sessionId: undefined });
      expect(trace.spans).toHaveLength(1);
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

      expect(mocks.instances[0].traces).toHaveLength(1);
      const trace = fakeTrace(mocks.instances[0].traces[0]);
      expect(trace.generations).toHaveLength(0);

      const delegationSpan = fakeObs(trace.spans[0]);
      expect(delegationSpan.body).toMatchObject({ name: 'tool:subagent' });
      expect(delegationSpan.spans).toHaveLength(1);

      const subSpan = fakeObs(delegationSpan.spans[0]);
      expect(subSpan.body).toMatchObject({
        name: 'subagent',
        metadata: { childSessionId: 'c1', delegationDepth: 1 },
      });
      // subagent/start enriches with provider facts.
      expect(subSpan.updates).toContainEqual({ metadata: { provider: 'spawn', local: true } });
      // The child's generation nests under the subagent span, not the trace.
      expect(subSpan.generations).toHaveLength(1);
      expect(subSpan.generations[0].body).toMatchObject({ name: 'llm-call' });
      expect(subSpan.ends[0]).toMatchObject({
        output: { stopReason: 'completed' },
        level: 'DEFAULT',
      });
      expect(delegationSpan.ends).toHaveLength(1);
    });

    it('gives child sessions no turn trace and feeds the prompt to the span', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));

      // The child's whole turn lifecycle must not open a trace of its own.
      ctx.emit('session/event', sessionOf('c1'), turnStart(0));
      ctx.emit('session/event', sessionOf('c1'), userMessage('read the marker file'));
      ctx.emit('session/event', sessionOf('c1'), turnEnd(0));

      expect(mocks.instances[0].traces).toHaveLength(1);
      const trace = fakeTrace(mocks.instances[0].traces[0]);
      // No open delegation span: the subagent span parents at the trace root.
      const subSpan = fakeObs(trace.spans[0]);
      expect(subSpan.body).toMatchObject({ name: 'subagent' });
      expect(subSpan.updates).toContainEqual({ input: 'read the marker file' });
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
      const subSpan = fakeObs(mocks.instances[0].traces[0]).spans[0];
      expect(subSpan.updates).toContainEqual({
        name: 'subagent: read marker',
        metadata: { mode: 'one-shot', provider: 'spawn' },
      });
    });

    it('marks a failed subagent run as ERROR', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('subagent/end', subagentEnd('c1', 'error'));
      const subSpan = fakeObs(mocks.instances[0].traces[0]).spans[0];
      expect(subSpan.ends[0]).toMatchObject({ level: 'ERROR', output: { stopReason: 'error' } });
    });

    it('withholds the final assistant message when captureContent is off', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('subagent/end', subagentEnd('c1', 'error'));
      const subSpan = fakeObs(mocks.instances[0].traces[0]).spans[0];
      expect(subSpan.ends[0]).toMatchObject({ output: { stopReason: 'error' } });
      expect((subSpan.ends[0] as { output: Record<string, unknown> }).output).not.toHaveProperty(
        'lastAssistantMessage',
      );
    });

    it('closes a dangling child span on session/disposed', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('session/disposed', sessionOf('c1'));
      const subSpan = fakeObs(mocks.instances[0].traces[0]).spans[0];
      expect(subSpan.ends[0]).toMatchObject({
        level: 'WARNING',
        statusMessage: 'session disposed before subagent/end',
      });
    });

    it('resolves nested (depth-2) delegations to the root trace', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('session/created', childSessionOf('c2', 'c1', 2));

      const trace = fakeTrace(mocks.instances[0].traces[0]);
      const c1Span = fakeObs(trace.spans[0]);
      const c2Span = fakeObs(c1Span.spans[0]);
      expect(c2Span.body).toMatchObject({
        name: 'subagent',
        metadata: { childSessionId: 'c2', delegationDepth: 2 },
      });

      await drain(ctx.waterfall('llm/stream', optionsFor('c2'), () => streamOf(finishStop())));
      expect(mocks.instances[0].traces).toHaveLength(1);
      expect(c2Span.generations).toHaveLength(1);
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

      const trace = fakeTrace(mocks.instances[0].traces[0]);
      const subSpan = fakeObs(trace.spans[0]);
      expect(subSpan.spans).toHaveLength(1);
      expect(subSpan.spans[0].body).toMatchObject({
        name: 'tool:read_file',
        input: { path: 'ci-marker.txt' },
      });
      expect(trace.spans).toHaveLength(1);
    });
  });

  describe('durability', () => {
    it('flushes the SDK at the session/flush checkpoint', async () => {
      await setup();
      await ctx.parallel('session/flush', sessionOf('s1'));
      expect(mocks.instances[0].flushAsync).toHaveBeenCalledTimes(1);
    });

    it('flushes and shuts the SDK down when the fiber unloads', async () => {
      await setup();
      await ctx.fiber.dispose();
      expect(mocks.instances[0].flushAsync).toHaveBeenCalled();
      expect(mocks.instances[0].shutdownAsync).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// client.ts — reporter unit tests (colocated here with the plugin tests so
// the whole package shares one inlined SDK mock)
// ---------------------------------------------------------------------------

const config = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'https://langfuse.example' };

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

  it('coalesces absent primary fields instead of emitting NaN', () => {
    expect(usageOf({} as never)).toEqual({
      usage: { input: 0, output: 0, total: 0 },
      usageDetails: { input: 0, output: 0, total: 0 },
    });
    expect(usageOf({ reasoningTokens: 4 } as never).usageDetails.output).toBe(0);
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

    // Observations parent nested spans (e.g. the llm-request detail span).
    const nested = fakeSpan(reporter.startSpan(generation, { name: 'llm-request' }));
    reporter.endSpan(nested, { level: 'DEFAULT' });
    expect(generation.spans[0].body).toMatchObject({ name: 'llm-request' });
    expect(nested.ends).toHaveLength(1);
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

    vi.spyOn(span, 'update').mockImplementationOnce(boom);
    expect(() => reporter.updateSpan(span, { name: 'x' })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-langfuse] span update failed:', expect.any(Error));
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
