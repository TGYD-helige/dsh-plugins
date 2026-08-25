import { Context, type Events } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CallId, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type {
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name } from './index.js';

const mocks = vi.hoisted(() => {
  const instances: FakeLangfuse[] = [];
  const state = { failTrace: false };
  class FakeObservation {
    updates: unknown[] = [];
    ends: unknown[] = [];
    generations: FakeObservation[] = [];
    spans: FakeObservation[] = [];
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
  class FakeTrace extends FakeObservation {}
  class FakeLangfuse {
    traces: FakeTrace[] = [];
    flushAsync = vi.fn(async () => {});
    shutdownAsync = vi.fn(async () => {});
    constructor(readonly config: unknown) {
      instances.push(this);
    }
    trace(body?: unknown) {
      if (state.failTrace) throw new Error('ingestion down');
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
const fakeTrace = (value: unknown): FakeTrace => value as FakeTrace;
const fakeObs = (value: unknown): FakeObservation => value as FakeObservation;

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
    mocks.instances.length = 0;
    mocks.state.failTrace = false;
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
        'session/event',
        'session/disposed',
        'session/flush',
        'llm/stream',
        'tools/execute',
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

    it('reports and rethrows mid-stream iteration failures', async () => {
      await setup();
      const stream = ctx.waterfall('llm/stream', optionsOf(), async function* () {
        yield textDelta('a');
        throw new Error('adapter boom');
      });
      await expect(drain(stream)).rejects.toThrow('adapter boom');
      expect(fakeObs(mocks.instances[0].traces[0].generations[0]).ends[0]).toMatchObject({
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

      // Between-turns maintenance call: fresh trace with the sessionId, and a
      // later turn/start still opens its own trace.
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      expect(mocks.instances[0].traces[1].body).toMatchObject({ sessionId: 's1' });
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
        ev('subagent/descriptor', { version: 2, mode: 'one-shot', provider: 'spawn', label: 'read marker' }),
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

      await drain(
        ctx.waterfall('llm/stream', optionsFor('c2'), () => streamOf(finishStop())),
      );
      expect(mocks.instances[0].traces).toHaveLength(1);
      expect(c2Span.generations).toHaveLength(1);
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
