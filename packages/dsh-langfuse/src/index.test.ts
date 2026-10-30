import { Context, type Events } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type {
  ContentBlock,
  GenerateOptions,
  StreamChunk,
  TokenUsage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { type Session, type SessionEvent, SessionStore } from '@deepseek-ai/dsh-session';
import type {
  ToolDispatchExecution,
  ToolExecutionResult,
  ToolExecutionToken,
} from '@deepseek-ai/dsh-tools';
import type { LangfuseGeneration, LangfuseSpan } from '@langfuse/tracing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LangfuseReporter, usageOf } from './client.js';
import { appendHookEvent, apply, inject, type LangfusePluginConfig, name } from './index.js';

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
    endedAt?: Date;
    readonly spans: MockObservation[] = [];
    readonly generations: MockObservation[] = [];
    /** Raw OTEL attributes stamped on the span (e.g. the session.id key). */
    readonly attributes: Record<string, unknown> = {};
    readonly otelSpan = {
      spanContext: () => this,
      addLink: vi.fn(),
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

    end(endedAt?: Date) {
      this.endedAt = endedAt;
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
    if (opts?.parentSpanContext instanceof mocks.MockObservation)
      return opts.parentSpanContext.startObservation(name, attrs, opts);
    const root = new mocks.MockObservation(name, attrs ?? {}, opts?.asType ?? 'span');
    root.attributes['langfuse.internal.is_app_root'] = true;
    root.parentContext = opts?.parentSpanContext;
    mocks.roots.push(root);
    return root;
  },
  setLangfuseTracerProvider: (provider: unknown) => {
    mocks.isolatedProviders.push(provider);
  },
  LangfuseOtelSpanAttributes: { IS_APP_ROOT: 'langfuse.internal.is_app_root' },
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
  vi.unstubAllEnvs();
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
const image: Extract<ContentBlock, { type: 'image' }> = {
  type: 'image',
  attachment: {
    attachmentId: 'image-1' as never,
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  },
};

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

// Drive the public pipeline and final result notification, including thrown dispatches.
async function dispatchTool(
  ctx: Context,
  exec: ToolDispatchExecution,
  run: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  try {
    const result = await ctx.waterfall('tools/execute', exec, run);
    ctx.emit('tools/result', exec, result);
    return result;
  } catch (error) {
    ctx.emit(
      'tools/result',
      exec,
      errResult(error instanceof Error ? error.message : String(error)),
    );
    throw error;
  }
}

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

/** Langfuse ingestion merges the object attribute with native SDK metadata,
 * with observation-specific fields taking precedence over the shared object. */
const metadataOf = (obs: MockObservation): Record<string, unknown> =>
  Object.assign(
    JSON.parse((obs.attributes['langfuse.observation.metadata'] as string | undefined) ?? '{}'),
    ...[obs.body, ...obs.updates].map((record) =>
      Object.fromEntries(
        Object.entries((record.metadata ?? {}) as Record<string, unknown>).filter(
          ([, value]) => value !== undefined && value !== null && value !== '',
        ),
      ),
    ),
  );

// ------------------------------------------------------------------ tests

describe('dsh-langfuse plugin', () => {
  let ctx: Context;

  /** apply + await the initialization promise it returns. */
  async function setup(config: LangfusePluginConfig = enabledConfig): Promise<void> {
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
        'tools/pre-execute',
        'tools/result',
        'subagent/start',
        'subagent/end',
      ]),
    );
    expect(mocks.processors[0].config).toMatchObject({
      publicKey: 'pk',
      secretKey: 'sk',
      baseUrl: 'https://langfuse.example',
    });
    // The processor is wired into an isolated provider (never the global one).
    expect(mocks.providers[0].config.spanProcessors).toEqual([mocks.processors[0]]);
    expect(mocks.isolatedProviders).toEqual([mocks.providers[0]]);
  });

  it('keeps admission, execution and terminal outcomes in one trace per native task', async () => {
    await setup({
      ...enabledConfig,
      publicKey: 'public-inbox-test',
      secretKey: 'secret-inbox-test',
    });
    const session = sessionOf('queue');
    const event = (phase: string, taskId?: string, taskIds?: string[]) =>
      ctx.emit('a2a/inbox', {
        phase,
        contextId: 'queue',
        at: 3000,
        pending: 1,
        taskId,
        taskIds,
        ...(taskId
          ? {
              messageId: `message-${taskId}`,
              nativeMessageId: `native-${taskId}`,
              input: `request-${taskId}`,
              target: 'next-turn' as const,
              queuedAt: 1000,
              selectedAt: 2000,
              turn: 1,
              step: 1,
            }
          : {}),
      });
    event('resolved');
    event('admitted', 'run');
    event('admitted', 'cancel');
    event('canceled', 'cancel');
    ctx.emit('session/event', session, turnStart(1));
    event('selected', 'run');
    event('prepared', 'run');
    ctx.emit('session/event', session, userMessage('request-run'));
    ctx.emit('session/event', session, turnEnd(1));
    const running = mocks.roots.find(
      (root) => root.attributes['langfuse.trace.input'] === 'request-run',
    )!;
    const canceled = mocks.roots.find(
      (root) => root.attributes['langfuse.trace.input'] === 'request-cancel',
    )!;
    expect(mocks.roots).toHaveLength(2);
    expect(running.ended).toBe(0);
    expect(canceled.ended).toBe(1);
    expect(canceled.spans.map((span) => span.name)).toEqual(['inbox:admitted', 'inbox:canceled']);
    expect(running.spans.map((span) => span.name)).toEqual(['inbox:admitted', 'agent:turn']);
    expect(running.spans.at(-1)?.spans[0].name).toBe('inbox:prepare');
    ctx.emit('session/event', session, turnStart(2));
    event('selected', 'run');
    event('prepared', 'run');
    event('completed', 'run');
    expect(running.ended).toBe(0);
    ctx.emit('session/event', session, turnEnd(2));
    expect(running.spans.filter((span) => span.name === 'agent:turn')).toHaveLength(2);
    expect(running.ended).toBe(1);
    event('completed', 'run');
    expect(mocks.roots).toHaveLength(2);
    expect(running.ended).toBe(1);
    expect(running.updates).toContainEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ taskState: 'completed' }) }),
    );
  });

  it('binds native inbox trace context after selection and before its first input', async () => {
    await setup({
      ...enabledConfig,
      publicKey: 'public-inbox-test',
      secretKey: 'secret-inbox-test',
    });
    const session = sessionOf('native');
    const inbox = (phase: string) =>
      ctx.emit('a2a/inbox', {
        phase,
        contextId: 'native',
        taskId: 'task-a',
        messageId: 'input-a',
        nativeMessageId: 'native-a',
        at: 3000,
        queuedAt: 1000,
        selectedAt: 2000,
        pending: 0,
        turn: 1,
        step: 1,
      });
    inbox('resolved');
    ctx.emit('session/event', session, turnStart(1));
    expect(mocks.roots).toHaveLength(0);
    inbox('selected');
    const traceparent = '00-11111111111111111111111111111111-2222222222222222-01';
    ctx.emit('langfuse/context', 'native', { traceparent, userId: 'alice' });
    inbox('prepared');
    ctx.emit('session/event', session, userMessage('hello'));
    ctx.emit('session/event', session, turnEnd(1));
    const execution = mocks.roots[0];
    expect(execution.otelSpan.addLink).toHaveBeenCalledWith({
      context: expect.objectContaining({
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
      }),
    });
    expect(execution.attributes['user.id']).toBe('alice');
    expect(execution.body.metadata).toMatchObject({ taskId: 'task-a' });
    expect(
      execution.spans
        .find((span) => span.name === 'agent:turn')
        ?.spans.find((span) => span.name === 'inbox:prepare')?.ended,
    ).toBe(1);
    expect(execution.ended).toBe(0);
    inbox('completed');
    expect(execution.ended).toBe(1);
    expect(mocks.roots.some((root) => root.name === 'inbox:wait')).toBe(false);
    expect(execution.updates).toContainEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ waitMs: 1000 }) }),
    );
  });

  it.each([true, false])(
    'reports readable inbox input/outcome with captureContent=%s',
    async (captureContent) => {
      await setup({
        ...enabledConfig,
        publicKey: 'public-inbox-test',
        secretKey: 'secret-inbox-test',
        captureContent,
      });
      const detail = {
        contextId: 'queue',
        taskId: 'task-1',
        messageId: 'message-1',
        nativeMessageId: 'native-1',
        at: 3000,
        queuedAt: 1000,
        selectedAt: 3000,
        pending: 2,
        target: 'next-turn' as const,
        position: 2,
        agentStatus: 'idle',
        input: 'Summarize the queued report',
      };
      ctx.emit('a2a/inbox', { ...detail, phase: 'admitted' });
      ctx.emit('a2a/inbox', { ...detail, phase: 'selected' });
      const task = mocks.roots[0];
      const admitted = task.spans.find((span) => span.name === 'inbox:admitted')!;
      expect(mocks.roots.some((root) => root.name === 'inbox:wait')).toBe(false);
      expect(task.attributes['langfuse.trace.input']).toBe(
        captureContent ? detail.input : undefined,
      );
      expect(admitted.updates).toContainEqual(
        expect.objectContaining({
          output: expect.objectContaining({
            state: 'admitted',
            target: 'next-turn',
            position: 2,
            pending: 2,
          }),
        }),
      );
      if (!captureContent) expect(JSON.stringify(mocks.roots)).not.toContain(detail.input);
    },
  );

  it.each([true, false])(
    'nests steering under the active turn and keeps its queue wait with captureContent=%s',
    async (captureContent) => {
      await setup({
        ...enabledConfig,
        publicKey: 'public-inbox-test',
        secretKey: 'secret-inbox-test',
        captureContent,
      });
      const session = sessionOf('native');
      const original = {
        contextId: 'native',
        phase: 'resolved',
        pending: 0,
        at: 1000,
        taskId: 'task-a',
        messageId: 'first',
        nativeMessageId: 'native-first',
        target: 'next-turn' as const,
        queuedAt: 1000,
        selectedAt: 2000,
        turn: 1,
        step: 1,
        input: 'Original request',
      };
      ctx.emit('a2a/inbox', original);
      ctx.emit('session/event', session, turnStart(1));
      ctx.emit('a2a/inbox', { ...original, phase: 'selected', at: 2000 });
      ctx.emit('a2a/inbox', { ...original, phase: 'prepared', at: 2100 });
      ctx.emit('session/event', session, userMessage('Original request'));
      const steering = {
        ...original,
        target: 'next-step' as const,
        messageId: 'guide',
        nativeMessageId: 'native-guide',
        queuedAt: 2200,
        selectedAt: 3000,
        step: 2,
        input: 'Do not publish; only build and test',
      };
      ctx.emit('a2a/inbox', { ...steering, phase: 'selected', at: 3000 });
      ctx.emit('a2a/inbox', { ...steering, phase: 'prepared', at: 3100 });
      ctx.emit('session/event', session, turnEnd(1));
      expect(mocks.roots).toHaveLength(1);
      const root = mocks.roots[0];
      const turn = root.spans.find((span) => span.name === 'agent:turn')!;
      const span = turn.spans.find((span) => span.name === 'inbox:steering')!;
      expect(span.body.input).toBe(captureContent ? steering.input : undefined);
      expect(span.body.metadata).toMatchObject({
        taskId: 'task-a',
        messageId: 'guide',
        target: 'next-step',
        turn: 1,
        step: 2,
        waitMs: 800,
      });
      expect(span.ended).toBe(1);
      expect(root.updates).toContainEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({ a2aMessageIds: ['first', 'guide'] }),
        }),
      );
      expect(root.attributes['langfuse.trace.input']).toBe(
        captureContent ? 'Original request' : undefined,
      );
      if (!captureContent) expect(JSON.stringify(root)).not.toContain(steering.input);
    },
  );

  it('records native preparation failures and starts the next turn with fresh attribution', async () => {
    await setup({
      ...enabledConfig,
      publicKey: 'public-inbox-test',
      secretKey: 'secret-inbox-test',
    });
    const session = sessionOf('native');
    ctx.emit('a2a/inbox', { phase: 'resolved', contextId: 'native', at: 1000, pending: 0 });
    for (const [turn, phase] of [
      [1, 'prepare-failed'],
      [2, 'prepared'],
    ] as const) {
      ctx.emit('session/event', session, turnStart(turn));
      const detail = {
        contextId: 'native',
        at: 3000,
        selectedAt: 2000,
        queuedAt: 1000,
        pending: 0,
        turn,
        input: `request-${turn}`,
        taskId: `task-${turn}`,
        messageId: `input-${turn}`,
        nativeMessageId: `native-${turn}`,
      };
      ctx.emit('a2a/inbox', { ...detail, phase: 'selected' });
      ctx.emit('a2a/inbox', { ...detail, phase });
      ctx.emit('session/event', session, turnEnd(turn));
      ctx.emit('a2a/inbox', { ...detail, phase: turn === 1 ? 'failed' : 'completed' });
    }
    const roots = mocks.roots.filter((root) => root.name === 'a2a-task');
    expect(roots).toHaveLength(2);
    expect(roots[0].attributes['langfuse.trace.input']).toBe('request-1');
    expect(
      roots[0].spans.find((span) => span.name === 'agent:turn')!.spans[0].updates,
    ).toContainEqual(expect.objectContaining({ level: 'ERROR' }));
    expect(roots[1].updates).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          a2aMessageIds: ['input-2'],
          nativeMessageIds: ['native-2'],
        }),
      }),
    );
    expect(roots.every((root) => root.ended === 1)).toBe(true);
  });

  describe('trace lifecycle', () => {
    it('redacts credential property names as well as values, retaining original field matching', async () => {
      await setup({
        ...enabledConfig,
        secretKey: 'configured-credential',
        redactFields: ['password'],
      });
      await dispatchTool(
        ctx,
        execOf({
          arguments: {
            'configured-credential': 'value',
            'sk-lf-dictionary': 'another',
            password: 'private-value',
          },
        }),
        async () => okResult(),
      );
      const input = mocks.roots[0].spans[0].body.input;
      expect(JSON.stringify(input)).not.toMatch(
        /configured-credential|sk-lf-dictionary|private-value/,
      );
      expect(input).toMatchObject({ password: '[REDACTED]' });
    });

    it.each([undefined, agentOf('s1')])(
      'closes unresolved tools at unload, including one-off roots',
      async (agent) => {
        const readImage = vi.fn();
        ctx.provide('attachments', { readImage } as unknown as AttachmentStore);
        await setup({ ...enabledConfig, captureMedia: true });
        let release!: (value: ToolExecutionResult) => void;
        const resultPromise = new Promise<ToolExecutionResult>((resolve) => {
          release = resolve;
        });
        const operation = dispatchTool(ctx, execOf({ agent }), () => resultPromise);
        const root = mocks.roots[0];
        const tool = root.spans[0];
        let endedAtShutdown: number[] = [];
        mocks.providers[0].shutdown.mockImplementationOnce(async () => {
          endedAtShutdown = [root.ended, tool.ended];
        });
        await ctx.fiber.dispose();
        expect(endedAtShutdown).toEqual([1, 1]);
        expect(lastUpdate(tool).level).toBe('WARNING');
        const result = { ...okResult(), content: [image] };
        release(result);
        expect(await operation).toBe(result);
        expect(tool.ended).toBe(1);
        expect(root.ended).toBe(1);
        expect(readImage).not.toHaveBeenCalled();
      },
    );

    it('exports paused model calls at unload and keeps forwarding their stream without duplicate ends', async () => {
      await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* source(): AsyncIterable<StreamChunk> {
        yield textDelta('partial');
        yield usageChunk({ inputTokens: 10, outputTokens: 3 });
        await gate;
        yield finishStop();
      }
      const stream = ctx.waterfall('llm/stream', optionsOf(), source)[Symbol.asyncIterator]();
      await stream.next();
      await stream.next();
      const generation = mocks.roots[0].generations[0];
      const request = generation.spans[0];
      let endedAtShutdown: number[] = [];
      mocks.providers[0].shutdown.mockImplementationOnce(async () => {
        endedAtShutdown = [generation.ended, request.ended];
      });
      await ctx.fiber.dispose();
      expect(endedAtShutdown).toEqual([1, 1]);
      expect(lastUpdate(generation)).toMatchObject({
        output: 'partial',
        level: 'WARNING',
        usageDetails: { input: 10, output: 3, total: 13 },
        metadata: { incomplete: true },
      });
      expect(lastUpdate(request).output).toEqual([
        textDelta('partial'),
        usageChunk({ inputTokens: 10, outputTokens: 3 }),
      ]);
      release();
      expect(await stream.next()).toEqual({ done: false, value: finishStop() });
      await stream.next();
      expect(generation.ended).toBe(1);
      expect(request.ended).toBe(1);
      expect(lastUpdate(generation).level).toBe('WARNING');
    });

    it('ends a model call which is never pulled when the plugin unloads', async () => {
      await setup();
      ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop()));
      await ctx.fiber.dispose();
      const generation = mocks.roots[0].generations[0];
      expect(generation.ended).toBe(1);
      expect(generation.spans[0].ended).toBe(1);
      expect(lastUpdate(generation)).toMatchObject({
        level: 'WARNING',
        metadata: { incomplete: true },
      });
    });

    it('redacts credentials and JSON fields spanning raw delta boundaries without changing the stream', async () => {
      await setup({
        ...enabledConfig,
        secretKey: 'arbitrary-secret-value',
        redactFields: ['password'],
      });
      const chunks: StreamChunk[] = [
        textDelta('arbitrary-'),
        textDelta('secret-value'),
        {
          type: 'tool-call-delta',
          index: 1,
          id: 'c1' as ToolCallId,
          argumentsDelta: '{"password":',
        },
        {
          type: 'tool-call-delta',
          index: 1,
          id: 'c1' as ToolCallId,
          argumentsDelta: '"fragmented-private"}',
        },
        finishStop(),
      ];
      expect(
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks))),
      ).toEqual(chunks);
      const raw = lastUpdate(mocks.roots[0].generations[0].spans[0]).output as StreamChunk[];
      expect(JSON.stringify(raw)).not.toContain('arbitrary-');
      expect(JSON.stringify(raw)).not.toContain('secret-value');
      expect(JSON.stringify(raw)).not.toContain('fragmented-private');
      expect(raw.map((chunk) => chunk.type)).toEqual(chunks.map((chunk) => chunk.type));
    });

    it('redacts a fragmented secret before dropping oversized raw chunks', async () => {
      await setup({ ...enabledConfig, maxPayloadBytes: 128, redactFields: ['password'] });
      const chunks: StreamChunk[] = [
        {
          type: 'tool-call-delta',
          index: 1,
          id: 'c1' as ToolCallId,
          argumentsDelta: '{"password":"fragmented-',
        },
        {
          type: 'tool-call-delta',
          index: 1,
          id: 'c1' as ToolCallId,
          argumentsDelta: `secret-value","padding":"${'x'.repeat(200)}"}`,
        },
        finishStop(),
      ];

      expect(
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks))),
      ).toEqual(chunks);
      const request = mocks.roots[0].generations[0].spans[0];
      expect(JSON.stringify(lastUpdate(request).output)).not.toContain('fragmented-');
      expect(JSON.stringify(lastUpdate(request).output)).not.toContain('secret-value');
      expect(lastUpdate(request).metadata).toMatchObject({ truncated: true });
    });

    it('redacts assembled text before applying the final output bound', async () => {
      await setup({ ...enabledConfig, maxPayloadBytes: 96, redactFields: ['password'] });
      const chunks = [
        textDelta('{"password":"assembled-'),
        textDelta(`secret-value","padding":"${'x'.repeat(200)}"}`),
        finishStop(),
      ];

      expect(
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks))),
      ).toEqual(chunks);
      const generation = fakeObs(mocks.roots[0]).generations[0];
      const output = JSON.stringify(lastUpdate(generation).output) ?? '';
      expect(output).not.toContain('assembled-');
      expect(output).not.toContain('secret-value');
      expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
    });

    it('bounds streaming buffers while dropping fragmented secrets as a whole', async () => {
      const maskSpy = vi.spyOn(LangfuseReporter.prototype, 'mask');
      try {
        await setup({ ...enabledConfig, maxPayloadBytes: 128, redactFields: ['password'] });
        const chunks = [
          textDelta('{"password":"stream-'),
          textDelta(`secret-value","padding":"${'x'.repeat(1000)}"}`),
          ...Array.from({ length: 40 }, () => textDelta('y')),
          finishStop(),
        ];

        const received = await drain(
          ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
        );

        expect(received).toEqual(chunks);
        const generation = fakeObs(mocks.roots[0]).generations[0];
        const request = generation.spans[0];
        expect(lastUpdate(request).output).toEqual([]);
        expect(lastUpdate(generation).output).toBeUndefined();
        expect(lastUpdate(request).metadata).toMatchObject({ truncated: true });
        expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
        for (const [payload] of maskSpy.mock.calls) {
          const serialized =
            typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? '');
          expect(Buffer.byteLength(serialized)).toBeLessThan(512);
        }
      } finally {
        maskSpy.mockRestore();
      }
    });

    it('redacts excerpt sources before extracting and truncating observation names', async () => {
      const secretKey = 'LONG-CREDENTIAL-'.repeat(12);
      await setup({ ...enabledConfig, secretKey, redactFields: ['path', 'password'] });
      await dispatchTool(ctx, execOf({ arguments: { path: '/private/customer-data' } }), async () =>
        okResult(),
      );
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('{"password":"private-value"}'), finishStop()),
        ),
      );
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta(secretKey), finishStop()),
        ),
      );
      const exported = JSON.stringify(mocks.roots);
      expect(exported).not.toContain('/private/customer-data');
      expect(exported).not.toContain('private-value');
      expect(exported).not.toContain(secretKey.slice(0, 70));
    });

    it('does not delay streaming for image reads and drains their closed observations before flush', async () => {
      let release!: (value: { ref: typeof image.attachment; data: Uint8Array }) => void;
      const pending = new Promise<{ ref: typeof image.attachment; data: Uint8Array }>((resolve) => {
        release = resolve;
      });
      const readImage = vi.fn(() => pending);
      ctx.provide('attachments', { readImage } as unknown as AttachmentStore);
      await setup({ ...enabledConfig, captureMedia: true });
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      const chunks = [textDelta('answer'), finishStop()];
      expect(
        await drain(
          ctx.waterfall(
            'llm/stream',
            optionsOf({ messages: [{ role: 'user', content: [image] }] }),
            () => streamOf(...chunks),
          ),
        ),
      ).toEqual(chunks);
      const generation = mocks.roots[0].generations[0];
      expect(generation.ended).toBe(0);
      const completedAt = new Date();
      const result = { ...okResult(), content: [image] };
      expect(await dispatchTool(ctx, execOf(), async () => result)).toBe(result);
      const toolCompletedAt = new Date();
      ctx.emit('session/event', session, ev('user/message', { content: [image] }));
      ctx.emit('session/event', session, turnEnd(0));
      const turnCompletedAt = new Date();
      const flushing = ctx.parallel('session/flush', session);
      expect(mocks.providers[0].forceFlush).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release({ ref: image.attachment, data: Uint8Array.of(1, 2, 3) });
      await flushing;
      expect(generation.ended).toBe(1);
      expect(generation.endedAt?.getTime()).toBeLessThanOrEqual(completedAt.getTime());
      expect(mocks.roots[0].spans[0].endedAt?.getTime()).toBeLessThanOrEqual(
        toolCompletedAt.getTime(),
      );
      expect(mocks.roots[0].endedAt?.getTime()).toBeLessThanOrEqual(turnCompletedAt.getTime());
      expect(mocks.providers[0].forceFlush).toHaveBeenCalledTimes(1);
    });

    it.each([
      { label: 'content disabled', captureContent: false, captureMedia: true },
      { label: 'media disabled', captureContent: true, captureMedia: false },
      { label: 'size limit', captureContent: true, captureMedia: true, maxMediaBytes: 2 },
      {
        label: 'environment kill switch',
        captureContent: true,
        captureMedia: true,
        disabledEnv: true,
      },
    ])('never reads or uploads images with $label', async (settings) => {
      const readImage = vi.fn();
      ctx.provide('attachments', { readImage } as unknown as AttachmentStore);
      if ('disabledEnv' in settings) vi.stubEnv('LANGFUSE_MEDIA_UPLOAD_ENABLED', 'false');
      await setup({ ...enabledConfig, ...settings });
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ messages: [{ role: 'user', content: [image] }] }),
          () => streamOf(finishStop()),
        ),
      );
      await ctx.parallel('session/flush', sessionOf('s1'));
      expect(readImage).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.roots)).not.toContain('data:image');
    });

    it('degrades image read failures and missing attachment services to metadata', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const readImage = vi.fn(async () => {
        throw new Error('backend unavailable');
      });
      const remove = ctx.provide('attachments', { readImage } as unknown as AttachmentStore);
      await setup({ ...enabledConfig, captureMedia: true });
      const options = optionsOf({ messages: [{ role: 'user', content: [image] }] });
      await drain(ctx.waterfall('llm/stream', options, () => streamOf(finishStop())));
      await ctx.parallel('session/flush', sessionOf('s1'));
      expect(errors).toHaveBeenCalledWith(
        '[dsh-langfuse] image display failed:',
        expect.any(Error),
      );
      expect(JSON.stringify(mocks.roots)).not.toContain('data:image');
      await remove();
      await drain(ctx.waterfall('llm/stream', options, () => streamOf(finishStop())));
      await ctx.parallel('session/flush', sessionOf('s1'));
      expect(readImage).toHaveBeenCalledTimes(1);
      expect(mocks.roots[0].generations.every((generation) => generation.ended === 1)).toBe(true);
      errors.mockRestore();
    });

    it('bounds a stuck image backend and flushes even when it ignores cancellation', async () => {
      vi.useFakeTimers();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        ctx.provide('attachments', {
          readImage: vi.fn(() => new Promise(() => {})),
        } as unknown as AttachmentStore);
        await setup({ ...enabledConfig, captureMedia: true, mediaTimeoutMs: 10 });
        await drain(
          ctx.waterfall(
            'llm/stream',
            optionsOf({ messages: [{ role: 'user', content: [image] }] }),
            () => streamOf(finishStop()),
          ),
        );
        const flushed = ctx.parallel('session/flush', sessionOf('s1'));
        await vi.advanceTimersByTimeAsync(20);
        await flushed;
        expect(mocks.roots[0].generations[0].ended).toBe(1);
        expect(errors).toHaveBeenCalledWith(
          '[dsh-langfuse] image display failed:',
          expect.any(Error),
        );
      } finally {
        vi.useRealTimers();
        errors.mockRestore();
      }
    });

    it('renders prompt, generation and tool images without mutating the raw request or agent results', async () => {
      const readImage = vi.fn(async () => ({
        ref: image.attachment,
        data: Uint8Array.of(1, 2, 3),
      }));
      ctx.provide('attachments', { readImage } as unknown as AttachmentStore);
      await setup({ ...enabledConfig, captureMedia: true });
      const content = [{ type: 'text', text: 'inspect' }, image] as ContentBlock[];
      const options = optionsOf({ messages: [{ role: 'user', content }] });
      const before = JSON.stringify(options);
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      ctx.emit('session/event', session, ev('user/message', { content }));
      await drain(ctx.waterfall('llm/stream', options, () => streamOf(finishStop())));
      const result = { ...okResult(), content: [image] };
      expect(await dispatchTool(ctx, execOf(), async () => result)).toBe(result);
      ctx.emit('session/event', session, turnEnd(0));
      await ctx.parallel('session/flush', session);
      const root = mocks.roots[0];
      const displayImage = { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } };
      expect(root.attributes['langfuse.trace.input']).toEqual([
        { type: 'text', text: 'inspect' },
        displayImage,
      ]);
      const generation = root.generations[0];
      expect(
        generation.updates.some((u) =>
          JSON.stringify(u.input).includes('data:image/png;base64,AQID'),
        ),
      ).toBe(true);
      expect(generation.spans[0].body.input).toEqual({ ...options, signal: undefined });
      expect(lastUpdate(root.spans[0]).output).toEqual([displayImage]);
      expect(JSON.stringify(options)).toBe(before);
      expect(result.content).toEqual([image]);
      expect(root.ended).toBe(1);
      expect(generation.ended).toBe(1);
    });

    it('uses a fresh request budget for image enrichment after initial truncation', async () => {
      const readImage = vi.fn(async () => ({
        ref: image.attachment,
        data: Uint8Array.of(1, 2, 3),
      }));
      ctx.provide('attachments', { readImage } as unknown as AttachmentStore);
      await setup({ ...enabledConfig, captureMedia: true, maxPayloadBytes: 512 });
      const options = optionsOf({
        messages: [
          {
            role: 'user',
            content: [image, { type: 'text', text: 'p'.repeat(500) }],
          },
        ],
      });
      const before = JSON.stringify(options);
      const chunks = [textDelta('answer'), finishStop()];

      const received = await drain(ctx.waterfall('llm/stream', options, () => streamOf(...chunks)));
      await ctx.parallel('session/flush', sessionOf('s1'));

      expect(received).toEqual(chunks);
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(
        generation.updates.some((update) =>
          (JSON.stringify(update.input) ?? '').includes('data:image/png;base64,AQID'),
        ),
      ).toBe(true);
      expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
      expect(JSON.stringify(options)).toBe(before);
    });

    it('joins explicit per-session parents once, isolates concurrent sessions and inherits child context', async () => {
      await setup({ ...enabledConfig, userId: 'default', tags: ['default'] });
      const traceparent = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
      ctx.emit('langfuse/context', 's1', { traceparent, userId: 'alice', tags: ['request-a'] });
      ctx.emit('langfuse/context', 's2', {
        traceparent: '00-fedcba0987654321fedcba0987654321-fedcba0987654321-00',
        userId: 'bob',
      });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/event', sessionOf('s2'), turnStart(0));
      expect(mocks.roots[0].parentContext).toEqual({
        traceId: '1234567890abcdef1234567890abcdef',
        spanId: '1234567890abcdef',
        traceFlags: 1,
        isRemote: true,
      });
      ctx.emit('session/event', sessionOf('s1'), userMessage('incoming request'));
      expect(mocks.roots[0].attributes).not.toHaveProperty('langfuse.trace.name');
      expect(mocks.roots[0].attributes['langfuse.internal.is_app_root']).toBe(false);
      expect(mocks.roots[0].attributes).not.toHaveProperty('langfuse.trace.input');
      expect(mocks.roots[1].attributes['user.id']).toBe('bob');
      ctx.emit('session/created', childSessionOf('child', 's1'));
      expect(mocks.roots[0].spans[0].attributes['user.id']).toBe('alice');
      expect(mocks.roots[0].spans[0].attributes['langfuse.trace.tags']).toEqual(['request-a']);
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));
      ctx.emit('session/event', sessionOf('s1'), turnStart(1));
      expect(mocks.roots[2].parentContext).toEqual({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: 0,
      });
      expect(mocks.roots[2].attributes['user.id']).toBe('default');
      expect(mocks.roots[1].parentContext).toMatchObject({
        traceId: 'fedcba0987654321fedcba0987654321',
        traceFlags: 0,
      });
    });

    it('propagates request metadata through model calls, tools and subagent observations', async () => {
      await setup();
      const context = {
        userId: 'request-owner',
        metadata: {
          tenantId: 'tenant-a',
          routing: { projectId: 'project-a' },
          labels: ['request-a'],
          attempt: 2,
          interactive: true,
          empty: '',
          nullable: null,
          numericString: '007',
          booleanString: 'false',
        },
      };
      ctx.emit('langfuse/context', 's1', context);
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('delegating'), finishStop()),
        ),
      );
      await dispatchTool(ctx, execOf({ name: 'subagent' }), async () => {
        ctx.emit('session/created', childSessionOf('child', 's1'));
        ctx.emit('subagent/start', subagentStart('child'));
        await drain(
          ctx.waterfall(
            'llm/stream',
            optionsOf({ sessionId: 'child' as GenerateOptions['sessionId'] }),
            () => streamOf(textDelta('child answer'), finishStop()),
          ),
        );
        await dispatchTool(ctx, execOf({ agent: agentOf('child') }), async () => okResult());
        ctx.emit('subagent/end', subagentEnd('child', 'completed'));
        return okResult();
      });
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

      const root = mocks.roots[0];
      const generation = root.generations[0];
      const delegation = root.spans[0];
      const child = delegation.spans[0];
      const childGeneration = child.generations[0];
      expect(mocks.roots).toHaveLength(1);
      for (const observation of [
        root,
        generation,
        generation.spans[0],
        delegation,
        child,
        childGeneration,
        childGeneration.spans[0],
        child.spans[0],
      ]) {
        expect(metadataOf(observation)).toMatchObject(context.metadata);
      }
    });

    it('consumes request metadata once without leaking across concurrent sessions or turns', async () => {
      await setup();
      const first = sessionOf('s1');
      const second = sessionOf('s2');
      ctx.emit('langfuse/context', 's1', { metadata: { requestId: 'first' } });
      ctx.emit('langfuse/context', 's2', { metadata: { requestId: 'second' } });
      ctx.emit('session/event', first, turnStart(0));
      ctx.emit('session/event', second, turnStart(0));
      ctx.emit('langfuse/context', 's1', { metadata: { requestId: 'next' } });
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ sessionId: 's2' as GenerateOptions['sessionId'] }),
          () => streamOf(finishStop()),
        ),
      );
      ctx.emit('session/event', first, turnEnd(0));
      ctx.emit('session/event', first, turnStart(1));
      ctx.emit('session/event', first, turnEnd(1));
      ctx.emit('session/event', first, turnStart(2));
      ctx.emit('session/event', first, turnEnd(2));
      ctx.emit('session/event', second, turnEnd(0));

      const [firstRoot, secondRoot, nextRoot, unboundRoot] = mocks.roots;
      expect(metadataOf(firstRoot).requestId).toBe('first');
      expect(metadataOf(firstRoot.generations[0]).requestId).toBe('first');
      expect(metadataOf(secondRoot).requestId).toBe('second');
      expect(metadataOf(secondRoot.generations[0]).requestId).toBe('second');
      expect(metadataOf(nextRoot).requestId).toBe('next');
      expect(metadataOf(unboundRoot)).not.toHaveProperty('requestId');
    });

    it('snapshots request metadata at binding and redacts nested fields and credential keys', async () => {
      await setup({
        ...enabledConfig,
        publicKey: 'public-credential',
        secretKey: 'private-credential',
        redactFields: ['password'],
      });
      const metadata = {
        nested: { projectId: 'before', Password: 'private-field' },
        targets: [{ region: 'west' }],
        note: 'credential: private-credential',
        'sk-lf-metadata-key': 'visible',
        extraCredential: 'sk-lf-other-credential',
      };
      const original = structuredClone(metadata);
      ctx.emit('langfuse/context', 's1', { metadata });
      expect(metadata).toEqual(original);
      metadata.nested.projectId = 'after';
      metadata.targets[0].region = 'east';
      metadata.note = 'changed after binding';
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

      for (const observation of [mocks.roots[0], mocks.roots[0].generations[0]]) {
        expect(metadataOf(observation)).toMatchObject({
          nested: { projectId: 'before', Password: '[REDACTED]' },
          targets: [{ region: 'west' }],
          note: 'credential: [REDACTED]',
          '[REDACTED]': 'visible',
          extraCredential: '[REDACTED]',
        });
        const exported = JSON.stringify(observation.attributes);
        for (const secret of [
          'private-field',
          'private-credential',
          'sk-lf-metadata-key',
          'sk-lf-other-credential',
        ]) {
          expect(exported).not.toContain(secret);
        }
      }
      expect(metadata.nested.Password).toBe('private-field');
      expect(metadata['sk-lf-metadata-key']).toBe('visible');
    });

    it.each([
      {
        kind: 'BigInt',
        secret: 'private-request-payload',
        createMetadata: (secret: string) => ({ requestId: 'invalid-request', nonJson: 1n, secret }),
      },
      {
        kind: 'throwing getter',
        secret: 'sk-lf-getter-private',
        createMetadata: (secret: string) =>
          Object.defineProperty({ requestId: 'invalid-request', secret }, 'nonJson', {
            enumerable: true,
            get() {
              throw new Error(secret);
            },
          }),
      },
      ...[
        { kind: 'NaN', createValue: () => Number.NaN },
        { kind: 'positive Infinity', createValue: () => Number.POSITIVE_INFINITY },
        { kind: 'negative Infinity', createValue: () => Number.NEGATIVE_INFINITY },
        { kind: 'undefined', createValue: () => undefined },
        { kind: 'function', createValue: () => () => 'not JSON' },
        { kind: 'symbol', createValue: () => Symbol('not JSON') },
        { kind: 'Date', createValue: () => new Date('2026-10-20T00:00:00.000Z') },
        { kind: 'Map', createValue: () => new Map([['retained', true]]) },
        { kind: 'Set', createValue: () => new Set(['retained']) },
        { kind: 'custom toJSON', createValue: () => ({ toJSON: () => ({ coerced: true }) }) },
      ].flatMap(({ kind, createValue }) => [
        {
          kind: `${kind} in nested object`,
          secret: 'private-request-payload',
          createMetadata: (secret: string) => ({
            requestId: 'invalid-request',
            nonJson: { nested: createValue() },
            secret,
          }),
        },
        {
          kind: `${kind} in array`,
          secret: 'private-request-payload',
          createMetadata: (secret: string) => ({
            requestId: 'invalid-request',
            nonJson: [createValue()],
            secret,
          }),
        },
      ]),
      {
        kind: 'sparse array',
        secret: 'private-request-payload',
        createMetadata: (secret: string) => ({
          requestId: 'invalid-request',
          nonJson: Object.assign(new Array<unknown>(2), { 1: 'retained' }),
          secret,
        }),
      },
      {
        kind: 'array with additional properties',
        secret: 'private-request-payload',
        createMetadata: (secret: string) => ({
          requestId: 'invalid-request',
          nonJson: Object.assign(['retained'], { omitted: true }),
          secret,
        }),
      },
      {
        kind: 'symbol-keyed property',
        secret: 'private-request-payload',
        createMetadata: (secret: string) => ({
          requestId: 'invalid-request',
          nonJson: { [Symbol('omitted')]: 'retained' },
          secret,
        }),
      },
      {
        kind: 'circular object',
        secret: 'private-request-payload',
        createMetadata: (secret: string) => {
          const metadata: Record<string, unknown> = { requestId: 'invalid-request', secret };
          metadata.nonJson = metadata;
          return metadata;
        },
      },
    ])(
      'rejects non-JSON request metadata ($kind) without breaking execution or reusing stale context',
      async ({ secret, createMetadata }) => {
        await setup();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          ctx.emit('langfuse/context', 's1', {
            userId: 'previous-owner',
            metadata: { requestId: 'previous-request' },
          });
          expect(() =>
            ctx.emit('langfuse/context', 's1', {
              metadata: createMetadata(secret),
            }),
          ).not.toThrow();
          ctx.emit('session/event', sessionOf('s1'), turnStart(0));
          const chunks = [textDelta('completed'), finishStop()];
          await expect(
            drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks))),
          ).resolves.toEqual(chunks);
          const result = okResult();
          expect(await dispatchTool(ctx, execOf(), async () => result)).toBe(result);
          ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

          const root = mocks.roots[0];
          for (const observation of [root, root.generations[0], root.spans[0]]) {
            expect(metadataOf(observation)).not.toHaveProperty('requestId');
            expect(metadataOf(observation)).not.toHaveProperty('nonJson');
            expect(metadataOf(observation)).not.toHaveProperty('secret');
            expect(observation.attributes).not.toHaveProperty('user.id');
            expect(observation.ended).toBe(1);
          }
          expect(errors).toHaveBeenCalledWith(expect.stringContaining('[dsh-langfuse]'));
          expect(errors.mock.calls.flat().map(String).join('\n')).not.toContain(secret);
        } finally {
          errors.mockRestore();
        }
      },
    );

    it('accepts ordinary JSON request metadata with shared noncircular references', async () => {
      await setup();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const shared = {
          projectId: 'project-a',
          values: [null, '', '007', 'false', true, false, 0, -2.5],
          emptyObject: {},
          emptyArray: [],
          dictionary: Object.assign(Object.create(null) as Record<string, unknown>, {
            region: 'west',
          }),
        };
        const metadata = {
          requestId: 'request-a',
          first: shared,
          second: shared,
          groups: [shared, { nested: shared }],
        };
        const expected = structuredClone(metadata);
        ctx.emit('langfuse/context', 's1', {
          metadata,
          userId: undefined,
          tags: undefined,
          traceparent: undefined,
        });
        shared.projectId = 'changed-after-binding';
        shared.values.push('changed-after-binding');
        ctx.emit('session/event', sessionOf('s1'), turnStart(0));
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
        await dispatchTool(ctx, execOf(), async () => okResult());
        ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

        const root = mocks.roots[0];
        for (const observation of [root, root.generations[0], root.spans[0]]) {
          expect(metadataOf(observation)).toMatchObject(expected);
          expect(observation.ended).toBe(1);
        }
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it('accepts undefined optional request context fields', async () => {
      await setup({ ...enabledConfig, userId: 'default-owner', tags: ['default'] });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        ctx.emit('langfuse/context', 's1', {
          metadata: undefined,
          userId: undefined,
          tags: undefined,
          traceparent: undefined,
        });
        ctx.emit('session/event', sessionOf('s1'), turnStart(0));
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
        ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

        expect(mocks.roots[0].attributes['user.id']).toBe('default-owner');
        expect(mocks.roots[0].attributes['langfuse.trace.tags']).toEqual(['default']);
        expect(mocks.roots[0].generations[0].ended).toBe(1);
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it('ignores a context toJSON method that could replace validated metadata', async () => {
      await setup();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const toJSON = vi.fn(() => ({ metadata: { score: NaN } }));
      const context = {
        metadata: { requestId: 'request-a', score: 1 },
        toJSON,
      };
      try {
        expect(() => ctx.emit('langfuse/context', 's1', context)).not.toThrow();
        ctx.emit('session/event', sessionOf('s1'), turnStart(0));
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
        await dispatchTool(ctx, execOf(), async () => okResult());
        ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

        const root = mocks.roots[0];
        for (const observation of [root, root.generations[0], root.spans[0]]) {
          expect(metadataOf(observation)).toMatchObject({ requestId: 'request-a', score: 1 });
          expect(observation.ended).toBe(1);
        }
        expect(toJSON).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it('snapshots a JSON metadata getter once instead of validating and reading it twice', async () => {
      await setup();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      let reads = 0;
      const value = { projectId: 'before-binding' };
      const metadata = Object.defineProperty({ requestId: 'request-a' }, 'resolved', {
        enumerable: true,
        get() {
          reads++;
          if (reads > 1) throw new Error('sk-lf-second-read-secret');
          return value;
        },
      });
      try {
        expect(() => ctx.emit('langfuse/context', 's1', { metadata })).not.toThrow();
        value.projectId = 'after-binding';
        ctx.emit('session/event', sessionOf('s1'), turnStart(0));
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
        ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

        expect(reads).toBe(1);
        for (const observation of [mocks.roots[0], mocks.roots[0].generations[0]]) {
          expect(metadataOf(observation)).toMatchObject({
            requestId: 'request-a',
            resolved: { projectId: 'before-binding' },
          });
        }
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });

    it('discards pending request metadata when its session is disposed', async () => {
      await setup();
      const discarded = sessionOf('discarded');
      const surviving = sessionOf('surviving');
      ctx.emit('langfuse/context', discarded.id, { metadata: { requestId: 'discarded' } });
      ctx.emit('langfuse/context', surviving.id, { metadata: { requestId: 'surviving' } });
      ctx.emit('session/disposed', discarded);
      ctx.emit('session/event', discarded, turnStart(0));
      ctx.emit('session/event', surviving, turnStart(0));
      ctx.emit('session/event', discarded, turnEnd(0));
      ctx.emit('session/event', surviving, turnEnd(0));

      expect(metadataOf(mocks.roots[0])).not.toHaveProperty('requestId');
      expect(metadataOf(mocks.roots[1]).requestId).toBe('surviving');
    });

    it('keeps native runtime facts authoritative over conflicting request metadata', async () => {
      await setup();
      ctx.emit('langfuse/context', 's1', {
        metadata: {
          requestId: 'request-a',
          turn: 999,
          provider: 'custom-provider',
          callId: 'custom-call',
          toolName: 'custom-tool',
          childSessionId: 'custom-child',
          endReason: 'custom-end',
        },
      });
      ctx.emit('session/event', sessionOf('s1'), turnStart(3));
      await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop())));
      await dispatchTool(ctx, execOf(), async () => okResult());
      ctx.emit('session/created', childSessionOf('child', 's1'));
      ctx.emit('subagent/start', subagentStart('child'));
      ctx.emit('subagent/end', subagentEnd('child', 'completed'));
      ctx.emit('session/event', sessionOf('s1'), turnEnd(3));

      const root = mocks.roots[0];
      expect(metadataOf(root)).toMatchObject({
        requestId: 'request-a',
        turn: 3,
        endReason: 'completed',
      });
      expect(metadataOf(root.generations[0].spans[0])).toMatchObject({
        requestId: 'request-a',
        provider: 'test',
      });
      expect(metadataOf(root.spans[0])).toMatchObject({
        requestId: 'request-a',
        callId: 'c1',
        toolName: 'write_file',
      });
      expect(metadataOf(root.spans[1])).toMatchObject({
        requestId: 'request-a',
        childSessionId: 'child',
        provider: 'spawn',
      });
    });

    it('retains request metadata when message and tool content capture is disabled', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      ctx.emit('langfuse/context', 's1', {
        metadata: { requestId: 'request-a', routing: { projectId: 'project-a' } },
      });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/event', sessionOf('s1'), userMessage('private prompt'));
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('private output'), finishStop()),
        ),
      );
      await dispatchTool(ctx, execOf(), async () => okResult());
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));

      const root = mocks.roots[0];
      for (const observation of [root, root.generations[0], root.spans[0]]) {
        expect(metadataOf(observation)).toMatchObject({
          requestId: 'request-a',
          routing: { projectId: 'project-a' },
        });
      }
      expect(root.attributes).not.toHaveProperty('langfuse.trace.input');
      expect(root.attributes).not.toHaveProperty('langfuse.trace.output');
    });

    it('binds request metadata to an existing native inbox task before execution', async () => {
      await setup({
        ...enabledConfig,
        publicKey: 'public-inbox-test',
        secretKey: 'secret-inbox-test',
      });
      const session = sessionOf('native');
      const inbox = (phase: string, taskId = 'task-a') =>
        ctx.emit('a2a/inbox', {
          phase,
          contextId: session.id,
          taskId,
          messageId: `input-${taskId}`,
          nativeMessageId: `native-${taskId}`,
          at: 3000,
          queuedAt: 1000,
          selectedAt: 2000,
          pending: 0,
          turn: 1,
          step: 1,
        });
      inbox('resolved');
      ctx.emit('session/event', session, turnStart(1));
      inbox('selected');
      const request = { metadata: { requestId: 'request-a', taskId: 'custom-task' } };
      ctx.emit('langfuse/context', session.id, request);
      request.metadata.requestId = 'mutated-after-binding';
      inbox('prepared');
      ctx.emit('session/event', session, userMessage('run the task'));
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ sessionId: session.id as GenerateOptions['sessionId'] }),
          () => streamOf(finishStop()),
        ),
      );
      await dispatchTool(ctx, execOf({ agent: agentOf(session.id) }), async () => okResult());
      ctx.emit('session/event', session, turnEnd(1));
      inbox('completed');
      ctx.emit('session/event', session, turnStart(2));
      inbox('selected', 'task-b');
      inbox('prepared', 'task-b');
      ctx.emit('session/event', session, turnEnd(2));
      inbox('completed', 'task-b');

      const task = mocks.roots[0];
      const turn = task.spans.find((span) => span.name === 'agent:turn')!;
      for (const observation of [task, turn, turn.generations[0], turn.spans.at(-1)!]) {
        expect(metadataOf(observation)).toMatchObject({ requestId: 'request-a' });
      }
      expect(metadataOf(task)).toMatchObject({ taskId: 'task-a', taskState: 'completed' });
      expect(metadataOf(turn)).toMatchObject({ taskId: 'task-a', turn: 1 });
      expect(metadataOf(mocks.roots[1])).not.toHaveProperty('requestId');
    });

    it('rejects malformed and all-zero trace parents without breaking a turn', async () => {
      await setup();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const traceparent of [
        'bad-header',
        `00-${'0'.repeat(32)}-1234567890abcdef-01`,
        `00-1234567890abcdef1234567890abcdef-${'0'.repeat(16)}-01`,
      ]) {
        ctx.emit('langfuse/context', 's1', { traceparent });
        ctx.emit('session/event', sessionOf('s1'), turnStart(0));
        expect(mocks.roots.at(-1)?.parentContext).toMatchObject({ traceId: '0'.repeat(32) });
      }
      expect(errors).toHaveBeenCalledWith(
        '[dsh-langfuse] invalid traceparent; starting an independent trace',
      );
      errors.mockRestore();
    });

    it('uses the final turn result for root severity and records recovered errors separately', async () => {
      await setup();
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishError('transient'))),
      );
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('recovered'), finishStop()),
        ),
      );
      ctx.emit('session/event', session, turnEnd(0));
      expect(lastUpdate(mocks.roots[0])).toMatchObject({
        level: 'DEFAULT',
        metadata: { endReason: 'completed', hadErrors: true },
      });
      ctx.emit('session/event', session, turnStart(1));
      ctx.emit(
        'session/event',
        session,
        ev('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'FATAL', message: 'final failure' } },
        }),
      );
      expect(lastUpdate(mocks.roots[1])).toMatchObject({
        level: 'ERROR',
        statusMessage: 'final failure',
        metadata: { endReason: 'error', errorCode: 'FATAL' },
      });
      ctx.emit('session/event', session, turnStart(2));
      ctx.emit(
        'session/event',
        session,
        ev('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
      );
      expect(lastUpdate(mocks.roots[2])).toMatchObject({
        level: 'WARNING',
        metadata: { endReason: 'aborted' },
      });
    });

    it('shows reasoning beside text and tool calls while preserving every raw chunk', async () => {
      await setup();
      const chunks: StreamChunk[] = [
        { type: 'reasoning-delta', index: 0, text: 'Compare the options. ' },
        { type: 'reasoning-delta', index: 0, text: 'Read the file.' },
        textDelta('Checking now'),
        toolCallEnd('read_file'),
        finishStop(),
      ];
      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
      );
      expect(received).toEqual(chunks);
      const generation = mocks.roots[0].generations[0];
      expect(lastUpdate(generation).output).toEqual({
        role: 'assistant',
        content: 'Checking now',
        thinking: [{ type: 'thinking', content: 'Compare the options. Read the file.' }],
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      });
      expect(lastUpdate(generation.spans[0]).output).toEqual(chunks);
      await dispatchTool(ctx, execOf(), async () => okResult());
      expect(mocks.roots[0].spans[0].asType).toBe('tool');
    });

    it('propagates user and tags through tools, generations and subagents', async () => {
      await setup({ ...enabledConfig, userId: 'operator', tags: ['production', 'experiment'] });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('child', 's1'));
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({ sessionId: 'child' as GenerateOptions['sessionId'] }),
          () => streamOf(finishStop()),
        ),
      );
      await dispatchTool(ctx, execOf({ agent: agentOf('child') }), async () => okResult());
      const root = mocks.roots[0];
      const child = root.spans[0];
      for (const observation of [
        root,
        child,
        child.generations[0],
        child.generations[0].spans[0],
        child.spans[0],
      ]) {
        expect(observation.attributes['user.id']).toBe('operator');
        expect(observation.attributes['langfuse.trace.tags']).toEqual(['production', 'experiment']);
      }
    });

    it('accepts env-only credentials and profile environment/release with a master kill switch', async () => {
      vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-env');
      vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-env');
      vi.stubEnv('LANGFUSE_BASE_URL', 'https://env.example');
      await setup({
        ...enabledConfig,
        publicKey: '',
        secretKey: '',
        baseUrl: '',
        environment: 'staging',
        release: 'build-42',
      });
      expect(mocks.processors[0].config).toMatchObject({
        publicKey: 'pk-lf-env',
        secretKey: 'sk-lf-env',
        baseUrl: 'https://env.example',
        environment: 'staging',
        release: 'build-42',
      });
      vi.stubEnv('LANGFUSE_TRACING_ENABLED', 'false');
      await apply(new Context(), enabledConfig);
      expect(mocks.processors).toHaveLength(1);
    });

    it('redacts credentials and configured fields in all reporter payloads and names', async () => {
      await setup({
        ...enabledConfig,
        publicKey: 'pk-lf-public',
        secretKey: 'secret-value',
        redactFields: ['password'],
      });
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({
            system: 'secret-value',
            messages: [{ role: 'user', content: [{ type: 'text', text: 'sk-lf-other' }] }],
          }),
          () => streamOf(textDelta('secret-value sk-lf-other'), finishStop()),
        ),
      );
      await dispatchTool(
        ctx,
        execOf({ arguments: { password: 'hidden', path: 'secret-value' } }),
        async () => errResult('secret-value sk-lf-other'),
      );
      const exported = JSON.stringify(mocks.roots);
      expect(exported).not.toMatch(/secret-value|sk-lf-other|hidden/);
      expect(exported).toContain('[REDACTED]');
      const { mask } = mocks.processors[0].config as {
        mask: (input: { data: unknown }) => unknown;
      };
      expect(mask({ data: { password: 'hidden', nested: ['sk-lf-other'] } })).toEqual({
        password: '[REDACTED]',
        nested: ['[REDACTED]'],
      });
      expect(mask({ data: { arguments: '{"Password":"string-hidden"}' } })).toEqual({
        arguments: '{"Password":"[REDACTED]"}',
      });
    });

    it('keeps reply content out of observation names when captureContent is false', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(textDelta('PRIVATE REPLY'), finishStop()),
        ),
      );
      expect(mocks.roots[0].generations[0].name).toBe('llm-call');
      expect(JSON.stringify(mocks.roots)).not.toContain('PRIVATE REPLY');
    });

    it('captures hook context under its explicit tool across the whole pipeline', async () => {
      await setup({ ...enabledConfig, secretKey: 'sk-lf-private', redactFields: ['token'] });
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      const first = execOf({ callId: 'first' as ToolCallId });
      const second = execOf({ callId: 'second' as ToolCallId });
      await ctx.waterfall('tools/pre-execute', first, async () => ({ kind: 'allow' }));
      await ctx.waterfall('tools/pre-execute', second, async () => ({ kind: 'allow' }));
      const tool = mocks.roots[0].spans[0];
      for (const point of ['BeforeTool', 'AfterTool']) {
        const identity = { turn: 0, point, handlerId: 'h', invocationId: point, callId: 'first' };
        ctx.emit(
          'session/event',
          session,
          ev('hook/invoked', {
            ...identity,
            dialect: 'gemini',
            name: 'validate',
            input: { path: 'a.ts', token: 'PRIVATE', key: 'sk-lf-private' },
          }),
        );
        expect(tool.spans).toHaveLength(point === 'BeforeTool' ? 1 : 2);
        const hook = tool.spans.at(-1)!;
        expect(hook.name).toBe(`hook:${point}:validate`);
        expect(hook.body.input).toEqual({ path: 'a.ts', token: '[REDACTED]', key: '[REDACTED]' });
        expect(tool.ended).toBe(0);
        ctx.emit(
          'session/event',
          session,
          ev('hook/result', {
            ...identity,
            decision: 'pass',
            outcome: 'success',
            exitCode: 0,
            durationMs: 3,
            result: {
              reason: 'checked',
              additionalContext: 'context',
              continue: true,
              token: 'PRIVATE',
            },
            stdout: 'x'.repeat(5000),
            stderr: 'sk-lf-private',
          }),
        );
        expect(lastUpdate(hook)).toMatchObject({
          output: {
            decision: 'pass',
            outcome: 'success',
            exitCode: 0,
            result: {
              reason: 'checked',
              additionalContext: 'context',
              continue: true,
              token: '[REDACTED]',
            },
            stdout: 'x'.repeat(4096),
            stderr: '[REDACTED]',
          },
          metadata: { stdoutTruncated: true },
        });
        expect(hook.ended).toBe(1);
      }
      ctx.emit('tools/result', second, okResult());
      expect(tool.ended).toBe(0);
      ctx.emit('tools/result', first, okResult());
      expect(tool.ended).toBe(1);
      expect(mocks.roots[0].spans[1].spans).toHaveLength(0);
    });

    it('keeps late tool hooks on their original trace when call IDs repeat next turn', async () => {
      await setup();
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      const first = execOf();
      await ctx.waterfall('tools/pre-execute', first, async () => ({ kind: 'allow' }));
      const identity = {
        turn: 0,
        point: 'AfterTool',
        handlerId: 'h',
        invocationId: 'late',
        callId: 'c1',
      };
      ctx.emit('session/event', session, ev('hook/invoked', { ...identity, dialect: 'gemini' }));
      ctx.emit('tools/result', first, okResult());
      ctx.emit('session/event', session, turnEnd(0));
      ctx.emit('session/event', session, turnStart(1));
      const second = execOf();
      await ctx.waterfall('tools/pre-execute', second, async () => ({ kind: 'allow' }));
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          ...identity,
          decision: 'pass',
          outcome: 'failed',
          durationMs: 12,
        }),
      );
      expect(mocks.roots[0].spans[0].spans[0].ended).toBe(1);
      expect(mocks.roots[1].spans[0].spans).toHaveLength(0);
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          ...identity,
          invocationId: 'detached',
          dialect: 'gemini',
        }),
      );
      expect(mocks.roots).toHaveLength(2);
      expect(mocks.roots[0].spans[1].name).toBe('hook:AfterTool');
      expect(mocks.roots[1].spans[0].spans).toHaveLength(0);
      ctx.emit('tools/result', second, okResult());
      ctx.emit('session/event', session, turnEnd(1));
      expect(lastUpdate(mocks.roots[1]).metadata).not.toHaveProperty('hadErrors');
      await ctx.fiber.dispose();
    });

    it('starts before registered pre hooks and records denied calls without dispatch', async () => {
      const session = sessionOf('s1');
      ctx.on('tools/pre-execute', async (exec) => {
        const identity = { turn: 0, point: 'BeforeTool', handlerId: 'h', callId: exec.callId };
        ctx.emit('session/event', session, ev('hook/invoked', { ...identity, dialect: 'gemini' }));
        ctx.emit(
          'session/event',
          session,
          ev('hook/result', {
            ...identity,
            decision: 'deny',
            exitCode: 2,
            durationMs: 1,
          }),
        );
        return { kind: 'deny', reason: 'blocked' };
      });
      await setup();
      ctx.emit('session/event', session, turnStart(0));
      const exec = execOf();
      expect(
        await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' })),
      ).toEqual({ kind: 'deny', reason: 'blocked' });
      const tool = mocks.roots[0].spans[0];
      expect(tool.spans[0].ended).toBe(1);
      expect(tool.ended).toBe(0);
      ctx.emit('tools/result', exec, errResult('blocked'));
      expect(tool.ended).toBe(1);
      expect(lastUpdate(tool)).toMatchObject({ level: 'ERROR', statusMessage: 'blocked' });
    });

    it('reports a hook invocation and result as one span inside the turn trace', async () => {
      await setup();
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));

      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'PreToolUse',
          dialect: 'codex',
          matcher: 'write_file',
          handlerId: 'handler-1',
        }),
      );
      const hook = fakeObs(mocks.roots[0].spans[0]);
      expect(hook.name).toBe('hook:PreToolUse');
      expect(hook.body.metadata).toEqual({
        turn: 0,
        point: 'PreToolUse',
        dialect: 'codex',
        matcher: 'write_file',
        handlerId: 'handler-1',
      });
      expect(hook.ended).toBe(0);

      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'PreToolUse',
          handlerId: 'handler-1',
          decision: 'block',
          exitCode: 2,
          stderrSummary: 'blocked by policy',
          durationMs: 37,
        }),
      );
      expect(lastUpdate(hook)).toMatchObject({
        output: { decision: 'block', exitCode: 2, stderrSummary: 'blocked by policy' },
        level: 'WARNING',
        metadata: { durationMs: 37 },
      });
      expect(hook.ended).toBe(1);
      ctx.emit('session/event', session, turnEnd(0));
      expect(mocks.roots[0].ended).toBe(1);
    });

    it('correlates concurrent custom hook runs and records explicit process outcomes', async () => {
      await setup();
      const session = sessionOf('custom');
      ctx.emit('session/event', session, turnStart(0));
      for (const invocationId of ['first', 'second']) {
        ctx.emit(
          'session/event',
          session,
          ev('hook/invoked', {
            turn: 0,
            point: 'BeforeAgent',
            dialect: 'company-validator',
            handlerId: 'same-command',
            invocationId,
            name: 'Validate request',
          }),
        );
      }
      expect(mocks.roots[0].spans).toHaveLength(2);
      expect(mocks.roots[0].spans.every((span) => span.ended === 0)).toBe(true);
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'same-command',
          invocationId: 'second',
          decision: 'pass',
          outcome: 'timed-out',
          signal: 'SIGTERM',
          durationMs: 100,
        }),
      );
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'same-command',
          invocationId: 'first',
          decision: 'pass',
          outcome: 'success',
          exitCode: 2,
          durationMs: 7,
        }),
      );
      expect(lastUpdate(mocks.roots[0].spans[0])).toMatchObject({
        level: 'DEFAULT',
        output: { outcome: 'success', exitCode: 2 },
      });
      expect(lastUpdate(mocks.roots[0].spans[1])).toMatchObject({
        level: 'ERROR',
        output: { outcome: 'timed-out', signal: 'SIGTERM' },
      });
      expect(mocks.roots[0].spans[0].body.metadata).toMatchObject({
        dialect: 'company-validator',
        invocationId: 'first',
        name: 'Validate request',
      });
    });

    it('keeps delayed cancellation hooks on their completed turn across the next turn', async () => {
      await setup();
      const session = sessionOf('custom');
      ctx.emit('session/event', session, turnStart(0));
      const invoked = {
        turn: 0,
        point: 'UserCancel',
        dialect: 'gemini',
        handlerId: 'cancel-command',
        invocationId: 'running',
      };
      ctx.emit('session/event', session, ev('hook/invoked', invoked));
      ctx.emit('session/event', session, turnEnd(0));
      expect(mocks.roots[0].spans[0].ended).toBe(0);
      ctx.emit('session/event', session, turnStart(1));
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'UserCancel',
          handlerId: 'cancel-command',
          invocationId: 'running',
          decision: 'pass',
          outcome: 'cancelled',
          signal: 'SIGTERM',
          durationMs: 12,
        }),
      );
      expect(lastUpdate(mocks.roots[0].spans[0])).toMatchObject({
        level: 'WARNING',
        output: { outcome: 'cancelled' },
      });
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', { ...invoked, invocationId: 'detached' }),
      );
      expect(mocks.roots).toHaveLength(2);
      expect(mocks.roots[0].spans[1].name).toBe('hook:UserCancel');
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          ...invoked,
          turn: 1,
          invocationId: 'new-turn',
        }),
      );
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'UserCancel',
          handlerId: 'cancel-command',
          invocationId: 'detached',
          decision: 'pass',
          outcome: 'failed',
          exitCode: 1,
          durationMs: 3,
        }),
      );
      expect(mocks.roots[0].ended).toBe(1);
      expect(mocks.roots[0].spans[1].ended).toBe(1);
      expect(mocks.roots[1].ended).toBe(0);
      expect(mocks.roots[1].spans[0].ended).toBe(0);
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 1,
          point: 'UserCancel',
          handlerId: 'cancel-command',
          invocationId: 'new-turn',
          decision: 'pass',
          outcome: 'success',
          exitCode: 0,
          durationMs: 1,
        }),
      );
      expect(mocks.roots[1].spans[0].ended).toBe(1);
      ctx.emit('session/event', session, turnEnd(1));
      expect(lastUpdate(mocks.roots[1]).metadata).not.toHaveProperty('hadErrors');
    });

    it.each([
      ['success', 'DEFAULT'],
      ['failed', 'ERROR'],
      ['timed-out', 'ERROR'],
      ['cancelled', 'WARNING'],
    ])('reports custom %s independently of the hook decision', async (outcome, level) => {
      await setup({ ...enabledConfig, secretKey: 'sk-lf-private', redactFields: ['name'] });
      const session = sessionOf('custom');
      ctx.emit('session/event', session, turnStart(0));
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'BeforeAgent',
          dialect: 'gemini',
          handlerId: 'h',
          invocationId: 'run',
          name: 'PRIVATE NAME',
        }),
      );
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'h',
          invocationId: 'run',
          decision: 'pass',
          outcome,
          durationMs: 9,
          stderrSummary: 'sk-lf-private',
        }),
      );
      const hook = mocks.roots[0].spans[0];
      expect(lastUpdate(hook)).toMatchObject({ level, output: { decision: 'pass', outcome } });
      expect(JSON.stringify(hook)).not.toContain('sk-lf-private');
      expect(JSON.stringify(hook)).not.toContain('PRIVATE NAME');
      expect(hook.ended).toBe(1);
    });

    it('withholds custom names and stderr with content capture off and closes abandoned runs', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      const session = sessionOf('custom');
      ctx.emit('session/event', session, turnStart(0));
      const invoked = {
        turn: 0,
        point: 'BeforeAgent',
        dialect: 'gemini',
        handlerId: 'h',
        invocationId: 'run',
        name: 'PRIVATE NAME',
        input: { payload: 'PRIVATE INPUT' },
      };
      ctx.emit('session/event', session, ev('hook/invoked', invoked));
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'h',
          invocationId: 'run',
          decision: 'pass',
          outcome: 'failed',
          durationMs: 9,
          stderrSummary: 'PRIVATE STDERR',
          stdout: 'PRIVATE STDOUT',
          stderr: 'PRIVATE STDERR',
          result: { additionalContext: 'PRIVATE RESULT' },
        }),
      );
      expect(JSON.stringify(mocks.roots)).not.toContain('PRIVATE');
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', { ...invoked, invocationId: 'abandoned' }),
      );
      ctx.emit('session/event', session, turnEnd(0));
      expect(mocks.roots[0].spans[1].ended).toBe(0);
      await ctx.fiber.dispose();
      expect(mocks.roots[0].spans[1].ended).toBe(1);
      expect(lastUpdate(mocks.roots[0].spans[1])).toMatchObject({
        level: 'WARNING',
        statusMessage: 'hook result not observed',
      });
    });

    it('ignores malformed or unpaired records and contains hook exporter failures', async () => {
      await setup();
      const session = sessionOf('custom');
      ctx.emit('session/event', session, turnStart(0));
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'missing',
          decision: 'pass',
          durationMs: 1,
        }),
      );
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'BeforeAgent',
          dialect: 'gemini',
          handlerId: 'h',
          invocationId: 12,
        }),
      );
      expect(mocks.roots[0].spans).toHaveLength(0);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        mocks.state.failCreate = true;
        expect(() =>
          ctx.emit(
            'session/event',
            session,
            ev('hook/invoked', {
              turn: 0,
              point: 'BeforeAgent',
              dialect: 'gemini',
              handlerId: 'h',
              invocationId: 'run',
            }),
          ),
        ).not.toThrow();
        expect(error).toHaveBeenCalledWith(
          '[dsh-langfuse] span creation failed:',
          expect.any(Error),
        );
      } finally {
        error.mockRestore();
        await ctx.fiber.dispose();
      }
    });

    it('does not let late child hook failures mark a new parent turn as erroneous', async () => {
      await setup();
      const parent = sessionOf('parent');
      const child = childSessionOf('child', 'parent');
      ctx.emit('session/event', parent, turnStart(0));
      ctx.emit('session/created', child);
      ctx.emit('session/event', child, turnStart(0));
      ctx.emit(
        'session/event',
        child,
        ev('hook/invoked', {
          turn: 0,
          point: 'AfterAgent',
          dialect: 'gemini',
          handlerId: 'h',
          invocationId: 'old',
        }),
      );
      ctx.emit('session/event', child, turnEnd(0));
      ctx.emit('session/event', parent, turnEnd(0));
      ctx.emit('session/event', parent, turnStart(1));
      ctx.emit(
        'session/event',
        child,
        ev('hook/invoked', {
          turn: 0,
          point: 'UserCancel',
          dialect: 'gemini',
          handlerId: 'h',
          invocationId: 'delayed',
        }),
      );
      expect(mocks.roots).toHaveLength(2);
      expect(mocks.roots[0].spans[0].spans[1].name).toBe('hook:UserCancel');
      ctx.emit(
        'session/event',
        child,
        ev('hook/result', {
          turn: 0,
          point: 'UserCancel',
          handlerId: 'h',
          invocationId: 'delayed',
          decision: 'pass',
          outcome: 'failed',
          durationMs: 1,
        }),
      );
      ctx.emit(
        'session/event',
        child,
        ev('hook/result', {
          turn: 0,
          point: 'AfterAgent',
          handlerId: 'h',
          invocationId: 'old',
          decision: 'pass',
          outcome: 'failed',
          durationMs: 1,
        }),
      );
      ctx.emit('session/event', parent, turnEnd(1));
      expect(lastUpdate(mocks.roots[1]).metadata).not.toHaveProperty('hadErrors');
      expect(mocks.roots[0].spans[0].spans[0].ended).toBe(1);
      await ctx.fiber.dispose();
    });

    it('keeps next-turn context queued when a detached hook arrives', async () => {
      await setup();
      const session = sessionOf('custom');
      const context = {
        traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
        userId: 'next-turn-owner',
        tags: ['next-turn'],
      };
      ctx.emit('langfuse/context', session.id, context);
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'AfterAgent',
          dialect: 'gemini',
          handlerId: 'h',
          invocationId: 'late',
        }),
      );
      ctx.emit('session/event', session, turnStart(1));
      expect(mocks.roots[1].parentContext).toMatchObject({
        traceId: '1234567890abcdef1234567890abcdef',
        spanId: '1234567890abcdef',
      });
      expect(mocks.roots[0].parentContext).not.toMatchObject({
        traceId: '1234567890abcdef1234567890abcdef',
      });
      await ctx.fiber.dispose();
    });

    it('keeps next-turn context queued when a hook reuses a completed turn', async () => {
      await setup();
      const session = sessionOf('custom');
      ctx.emit('session/event', session, turnStart(0));
      ctx.emit('session/event', session, turnEnd(0));
      const root = mocks.roots[0];
      const endedAt = root.endedAt;
      ctx.emit('langfuse/context', session.id, { userId: 'next-turn-owner' });
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'UserCancel',
          dialect: 'gemini',
          handlerId: 'h',
          invocationId: 'late',
        }),
      );
      expect(mocks.roots).toHaveLength(1);
      expect(root.spans[0].name).toBe('hook:UserCancel');
      ctx.emit('session/event', session, turnStart(1));
      expect(mocks.roots[1].attributes['user.id']).toBe('next-turn-owner');
      expect(root.endedAt).toBe(endedAt);
      expect(root.ended).toBe(1);
    });

    it('bounds completed-turn parents across sessions and clears them on session disposal', async () => {
      await setup();
      const late = { turn: 0, point: 'UserCancel', dialect: 'gemini', handlerId: 'h' };
      for (let index = 0; index < 129; index++) {
        const session = sessionOf(`session-${index}`);
        ctx.emit('session/event', session, turnStart(0));
        ctx.emit('session/event', session, turnEnd(0));
      }
      ctx.emit(
        'session/event',
        sessionOf('session-0'),
        ev('hook/invoked', {
          ...late,
          invocationId: 'evicted',
        }),
      );
      expect(mocks.roots[129].body.metadata).toMatchObject({ detachedHook: true });
      ctx.emit(
        'session/event',
        sessionOf('session-1'),
        ev('hook/invoked', {
          ...late,
          invocationId: 'retained',
        }),
      );
      expect(mocks.roots).toHaveLength(130);
      expect(mocks.roots[1].spans).toHaveLength(1);
      ctx.emit('session/disposed', sessionOf('session-1'));
      ctx.emit(
        'session/event',
        sessionOf('session-1'),
        ev('hook/invoked', {
          ...late,
          invocationId: 'disposed',
        }),
      );
      expect(mocks.roots[130].body.metadata).toMatchObject({ detachedHook: true });
      await ctx.fiber.dispose();
      expect(mocks.roots[1].ended).toBe(1);
    });

    it('exports custom producer records written through a live Session', async () => {
      await setup();
      new SessionStore(ctx);
      const session = ctx.sessions.create();
      expect(
        appendHookEvent(session, 'hook/invoked', {
          turn: 0,
          point: 'BeforeAgent',
          dialect: 'company-validator',
          handlerId: 'h',
          invocationId: 'run',
        }),
      ).toBe(true);
      expect(
        appendHookEvent(session, 'hook/result', {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'h',
          invocationId: 'run',
          decision: 'pass',
          outcome: 'success',
          exitCode: 0,
          durationMs: 3,
        }),
      ).toBe(true);
      expect(mocks.roots[0].spans[0].body.metadata).toMatchObject({ dialect: 'company-validator' });
      expect(mocks.roots[0].spans[0].ended).toBe(1);
      expect(mocks.roots[0].ended).toBe(1);
      await ctx.fiber.dispose();
    });

    it('marks a failed hook script as an error', async () => {
      await setup();
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'UserPromptSubmit',
          dialect: 'codex',
          handlerId: 'h',
        }),
      );
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'UserPromptSubmit',
          handlerId: 'h',
          decision: 'pass',
          exitCode: 1,
          stderrSummary: 'script failed',
          durationMs: 5,
        }),
      );
      expect(lastUpdate(fakeObs(mocks.roots[0].spans[0]))).toMatchObject({
        level: 'ERROR',
        output: { decision: 'pass', exitCode: 1, stderrSummary: 'script failed' },
      });
    });

    it('redacts hook stderr when content capture is disabled', async () => {
      await setup({ ...enabledConfig, captureContent: false });
      const session = sessionOf('s1');
      ctx.emit('session/event', session, turnStart(0));
      ctx.emit(
        'session/event',
        session,
        ev('hook/invoked', {
          turn: 0,
          point: 'Stop',
          dialect: 'claude-code',
          handlerId: 'handler-2',
        }),
      );
      ctx.emit(
        'session/event',
        session,
        ev('hook/result', {
          turn: 0,
          point: 'Stop',
          handlerId: 'handler-2',
          decision: 'stop',
          exitCode: 0,
          stderrSummary: 'secret output',
          durationMs: 8,
        }),
      );
      const hook = fakeObs(mocks.roots[0].spans[0]);
      expect(lastUpdate(hook).output).toEqual({ decision: 'stop', exitCode: 0 });
      expect(JSON.stringify(hook)).not.toContain('secret output');
    });

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
        level: 'DEFAULT',
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
        { output: undefined, level: 'DEFAULT', metadata: { turn: 0, endReason: 'completed' } },
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

    it('ends an active model operation on session/disposed without duplicate ends', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      const stream = ctx.waterfall('llm/stream', optionsOf(), () => streamOf(finishStop()));
      const root = fakeObs(mocks.roots[0]);
      const generation = root.generations[0];
      const request = generation.spans[0];

      ctx.emit('session/disposed', sessionOf('s1'));
      expect(root.ended).toBe(1);
      expect(generation.ended).toBe(1);
      expect(request.ended).toBe(1);

      await drain(stream);
      expect(generation.ended).toBe(1);
      expect(request.ended).toBe(1);
    });

    it('ends an active tool operation on session/disposed without duplicate ends', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      let release!: (result: ToolExecutionResult) => void;
      const resultPromise = new Promise<ToolExecutionResult>((resolve) => {
        release = resolve;
      });
      const operation = dispatchTool(ctx, execOf(), () => resultPromise);
      const root = fakeObs(mocks.roots[0]);
      const tool = root.spans[0];

      ctx.emit('session/disposed', sessionOf('s1'));
      expect(root.ended).toBe(1);
      expect(tool.ended).toBe(1);

      release(okResult());
      expect(await operation).toEqual(okResult());
      expect(tool.ended).toBe(1);
    });

    it('ends a stale root when the next turn replaces it', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      const stale = fakeObs(mocks.roots[0]);
      ctx.emit(
        'session/event',
        sessionOf('s1'),
        ev('hook/invoked', {
          turn: 0,
          point: 'PreToolUse',
          dialect: 'codex',
          handlerId: 'unfinished',
        }),
      );
      const hook = stale.spans[0];
      ctx.emit('session/event', sessionOf('s1'), turnStart(1));
      expect(hook.ended).toBe(1);
      expect(lastUpdate(hook)).toMatchObject({ level: 'WARNING' });
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
        input: { provider: 'test', model: 'deepseek-chat', messages: [] },
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
        output: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        metadata: { finishReason: 'stop', toolCallCount: 1 },
      });
    });

    it('sends the request parameters as modelParameters (stop list serialized)', async () => {
      await setup();
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({
            stop: ['END-OF-SECRET'],
            temperature: 0.5,
            maxTokens: 100,
            reasoningEffort: 'high' as GenerateOptions['reasoningEffort'],
          }),
          () => streamOf(finishStop()),
        ),
      );
      expect(fakeObs(mocks.roots[0]).generations[0].body).toMatchObject({
        // v5 modelParameters values are string|number — the stop list serializes.
        modelParameters: {
          stop: '["END-OF-SECRET"]',
          temperature: 0.5,
          maxTokens: 100,
          reasoningEffort: 'high',
        },
        input: {
          stop: ['END-OF-SECRET'],
          temperature: 0.5,
          maxTokens: 100,
          reasoningEffort: 'high',
        },
      });
      expect(fakeObs(mocks.roots[0]).generations[0].body.input).not.toHaveProperty(
        'modelParameters',
      );
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

    it('passes new request fields through both inputs', async () => {
      await setup();
      const options = optionsOf({
        temperature: 0.5,
        maxTokens: 100,
        signal: new AbortController().signal,
        futureControl: { enabled: true },
      } as Partial<GenerateOptions>);
      await drain(ctx.waterfall('llm/stream', options, () => streamOf(finishStop())));

      const generation = fakeObs(mocks.roots[0]).generations[0];
      const request = generation.spans[0];
      const { signal: _, ...expectedInput } = options;
      expect(generation.body.input).toEqual(expectedInput);
      expect(request.body.input).toEqual(expectedInput);
    });

    it('bounds captured payloads and preserves the original stream', async () => {
      await setup({ ...enabledConfig, maxPayloadBytes: 48 });
      const chunks = [textDelta('x'.repeat(200)), finishStop()];
      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
      );
      expect(received).toEqual(chunks);

      const generation = fakeObs(mocks.roots[0]).generations[0];
      const request = generation.spans[0];
      expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
      expect(lastUpdate(request).metadata).toMatchObject({ truncated: true });
      expect((JSON.stringify(lastUpdate(generation).output) ?? '').length).toBeLessThan(200);
      expect((JSON.stringify(lastUpdate(request).output) ?? '').length).toBeLessThan(200);
    });

    it('bounds oversized request inputs and marks both observations', async () => {
      await setup({ ...enabledConfig, maxPayloadBytes: 64 });
      await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({
            messages: [{ role: 'user', content: [{ type: 'text', text: 'p'.repeat(500) }] }],
          }),
          () => streamOf(finishStop()),
        ),
      );

      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(generation.body.input).toMatchObject({ truncated: true });
      expect(generation.spans[0].body.input).toMatchObject({ truncated: true });
      expect(JSON.stringify(generation.body.input).length).toBeLessThan(500);
      expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
    });

    it('bounds oversized request structure before full masking or serialization', async () => {
      const secret = 'peak-private-value';
      const requestText = JSON.stringify({ password: secret, padding: 'p'.repeat(200_000) });
      const options = optionsOf({
        messages: [{ role: 'user', content: [{ type: 'text', text: requestText }] }],
      });
      const chunks = [textDelta('visible'), finishStop()];
      const maskSpy = vi.spyOn(LangfuseReporter.prototype, 'mask');
      const stringifySpy = vi.spyOn(JSON, 'stringify');
      try {
        await setup({ ...enabledConfig, maxPayloadBytes: 128, redactFields: ['password'] });
        const received = await drain(
          ctx.waterfall('llm/stream', options, () => streamOf(...chunks)),
        );

        expect(received).toEqual(chunks);
        expect(
          maskSpy.mock.calls.filter(
            ([payload]) => payload && typeof payload === 'object' && 'messages' in payload,
          ),
        ).toHaveLength(0);
        const serializedLengths = stringifySpy.mock.results.map((result) =>
          typeof result.value === 'string' ? result.value.length : 0,
        );
        expect(Math.max(...serializedLengths, 0)).toBeLessThan(4096);
        const generation = fakeObs(mocks.roots[0]).generations[0];
        expect(JSON.stringify(generation.body.input)).not.toContain(secret);
        expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
        const originalBlock = options.messages[0].content[0];
        expect(originalBlock.type).toBe('text');
        if (originalBlock.type === 'text') expect(originalBlock.text).toBe(requestText);
      } finally {
        maskSpy.mockRestore();
        stringifySpy.mockRestore();
      }
    });

    it('stops object traversal and masking after the payload budget is exhausted', async () => {
      const secret = 'stop-private-value';
      const fields = Object.fromEntries([
        ['password', `${secret}${'x'.repeat(1000)}`],
        ...Array.from({ length: 5000 }, (_, index) => [`field${index}`, 'value']),
      ]);
      const options = optionsOf({ futurePayload: fields } as Partial<GenerateOptions>);
      const chunks = [textDelta('visible'), finishStop()];
      const entriesSpy = vi.spyOn(Object, 'entries');
      const maskSpy = vi.spyOn(LangfuseReporter.prototype, 'mask');
      const fieldSpy = vi.spyOn(LangfuseReporter.prototype, 'shouldRedactField');
      try {
        await setup({ ...enabledConfig, maxPayloadBytes: 128, redactFields: ['password'] });
        const received = await drain(
          ctx.waterfall('llm/stream', options, () => streamOf(...chunks)),
        );

        expect(received).toEqual(chunks);
        expect(entriesSpy.mock.calls.filter(([value]) => value === fields)).toHaveLength(0);
        expect(maskSpy.mock.calls.length).toBeLessThan(100);
        expect(fieldSpy.mock.calls.length).toBeLessThan(100);
        const generation = fakeObs(mocks.roots[0]).generations[0];
        expect(JSON.stringify(generation.body.input)).not.toContain(secret);
        expect(Buffer.byteLength(JSON.stringify(generation.body.input))).toBeLessThanOrEqual(128);
        expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
      } finally {
        entriesSpy.mockRestore();
        maskSpy.mockRestore();
        fieldSpy.mockRestore();
      }
    });

    it('redacts structured request fields before truncating previews without changing the stream', async () => {
      const secret = 'request-private-value';
      const requestJson = JSON.stringify({ password: secret, padding: 'p'.repeat(400) });
      const chunks = [textDelta('visible'), finishStop()];
      await setup({ ...enabledConfig, maxPayloadBytes: 224, redactFields: ['password'] });

      const received = await drain(
        ctx.waterfall(
          'llm/stream',
          optionsOf({
            messages: [{ role: 'user', content: [{ type: 'text', text: requestJson }] }],
          }),
          () => streamOf(...chunks),
        ),
      );

      expect(received).toEqual(chunks);
      const generation = fakeObs(mocks.roots[0]).generations[0];
      const request = generation.spans[0];
      const exported = JSON.stringify({
        generationInput: generation.body.input,
        requestInput: request.body.input,
        rawOutput: lastUpdate(request).output,
      });
      expect(exported).not.toContain(secret);
      expect(exported).toContain('[REDACTED]');
      expect(generation.body.input).toMatchObject({ truncated: true });
      expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
    });

    it('redacts structured tool arguments before truncating assembled output', async () => {
      const secret = 'tool-private-value';
      const args = JSON.stringify({ password: secret, padding: 'x'.repeat(400) });
      const chunks = [toolCallEnd('write_file', args), finishStop()];
      await setup({ ...enabledConfig, maxPayloadBytes: 224, redactFields: ['password'] });

      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
      );

      expect(received).toEqual(chunks);
      expect(chunks[0]).toEqual(toolCallEnd('write_file', args));
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(JSON.stringify(lastUpdate(generation).output)).not.toContain(secret);
      expect(JSON.stringify(lastUpdate(generation).output)).toContain('[REDACTED]');
      expect(JSON.stringify(lastUpdate(generation.spans[0]).output)).not.toContain(secret);
      expect(lastUpdate(generation).metadata).toMatchObject({ truncated: true });
    });

    it('bounds tool-call overhead and final serialized output for empty arguments', async () => {
      await setup({ ...enabledConfig, maxPayloadBytes: 96 });
      const chunks = [
        ...Array.from({ length: 20 }, () => toolCallEnd('write_file', '')),
        finishStop(),
      ];

      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
      );

      expect(received).toEqual(chunks);
      const generation = fakeObs(mocks.roots[0]).generations[0];
      const output = lastUpdate(generation);
      expect(JSON.stringify(output.output).length).toBeLessThan(500);
      expect(output.metadata).toMatchObject({ truncated: true, toolCallCount: 20 });
    });

    it.each([1, 2, 17, 31, 64])(
      'keeps truncated JSON exports within the %i-byte serialized cap',
      async (maxPayloadBytes) => {
        await setup({ ...enabledConfig, maxPayloadBytes });
        const chunks = [textDelta('x'.repeat(200)), finishStop()];
        await drain(
          ctx.waterfall(
            'llm/stream',
            optionsOf({
              messages: [{ role: 'user', content: [{ type: 'text', text: 'p'.repeat(500) }] }],
            }),
            () => streamOf(...chunks),
          ),
        );

        const generation = fakeObs(mocks.roots[0]).generations[0];
        const values = [
          generation.body.input,
          generation.spans[0].body.input,
          lastUpdate(generation.spans[0]).output,
          lastUpdate(generation).output,
        ];
        for (const value of values) {
          if (value === undefined) continue;
          const serialized = JSON.stringify(value);
          expect(serialized).toBeDefined();
          expect(Buffer.byteLength(serialized!)).toBeLessThanOrEqual(maxPayloadBytes);
        }
      },
    );

    it('counts raw array brackets and commas after redaction in the serialized cap', async () => {
      const chunks = [textDelta('a'), finishStop()];
      const maxPayloadBytes = chunks.reduce(
        (total, chunk) => total + Buffer.byteLength(JSON.stringify(chunk)),
        0,
      );
      await setup({ ...enabledConfig, maxPayloadBytes });

      expect(
        await drain(ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks))),
      ).toEqual(chunks);
      const request = mocks.roots[0].generations[0].spans[0];
      expect(Buffer.byteLength(JSON.stringify(lastUpdate(request).output))).toBeLessThanOrEqual(
        maxPayloadBytes,
      );
      expect(lastUpdate(request).metadata).toMatchObject({ truncated: true });
    });

    it('keeps an exact-length raw array unchanged through final reporter masking', async () => {
      const chunks = [finishStop()];
      const maxPayloadBytes = Buffer.byteLength(JSON.stringify(chunks));
      await setup({ ...enabledConfig, maxPayloadBytes });

      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
      );

      expect(received).toEqual(chunks);
      const request = mocks.roots[0].generations[0].spans[0];
      expect(lastUpdate(request).output).toEqual(chunks);
      expect(Buffer.byteLength(JSON.stringify(lastUpdate(request).output))).toBe(maxPayloadBytes);
    });

    it('bounds non-delta secrets after final reporter masking at the exact cap', async () => {
      const chunks = [toolCallEnd('sk', 'sk'), finishStop()];
      const maxPayloadBytes = Buffer.byteLength(JSON.stringify(chunks));
      await setup({ ...enabledConfig, maxPayloadBytes });

      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () => streamOf(...chunks)),
      );

      expect(received).toEqual(chunks);
      const request = mocks.roots[0].generations[0].spans[0];
      const output = lastUpdate(request).output;
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(maxPayloadBytes);
      expect(JSON.stringify(output)).not.toContain('sk');
      expect(lastUpdate(request).metadata).toMatchObject({ truncated: true });
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
      const received = await drain(
        ctx.waterfall('llm/stream', optionsOf(), () =>
          streamOf(
            textDelta('secret'),
            toolCallEnd('read_file', '{"secret":"private"}'),
            usageChunk({ inputTokens: 1, outputTokens: 1 }),
            finishStop(),
          ),
        ),
      );
      expect(received[0]).toEqual(textDelta('secret'));
      expect(received[1]).toEqual(toolCallEnd('read_file', '{"secret":"private"}'));
      const generation = fakeObs(mocks.roots[0]).generations[0];
      expect(generation.body).toMatchObject({ input: { messageCount: 0 } });
      expect(lastUpdate(generation)).toMatchObject({
        output: undefined,
        usageDetails: { input: 1, output: 1, total: 2 },
        metadata: { toolCallCount: 1 },
      });
      expect(lastUpdate(generation.spans[0])).toMatchObject({
        output: undefined,
        metadata: { chunkCount: 4 },
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
        input?: Record<string, unknown>;
      };
      expect(body.modelParameters).toEqual({ temperature: 0.5, stopCount: 2 });
      expect(body.input).not.toHaveProperty('modelParameters');
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
      await dispatchTool(ctx, execOf(), async () =>
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
        dispatchTool(ctx, execOf(), async () => {
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

      const result = await dispatchTool(ctx, execOf(), async () => okResult());
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
      const result = await dispatchTool(ctx, execOf(), async () => errResult('nope'));
      expect(result.isError).toBe(true);
      expect(lastUpdate(fakeObs(mocks.roots[0]).spans[0])).toMatchObject({
        level: 'ERROR',
        statusMessage: 'nope',
      });
    });

    it('reports and rethrows a dispatch failure', async () => {
      await setup();
      await expect(
        dispatchTool(ctx, execOf(), async () => {
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
      await dispatchTool(ctx, execOf({ agent: undefined }), async () => okResult());
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

      await dispatchTool(
        ctx,
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

    it('falls back to the root when concurrent tools make the parent ambiguous', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      const first = execOf({ callId: 'a' as ToolCallId, name: 'subagent' });
      const second = execOf({ callId: 'b' as ToolCallId, name: 'other' });
      await ctx.waterfall('tools/pre-execute', first, async () => ({ kind: 'allow' }));
      await ctx.waterfall('tools/pre-execute', second, async () => ({ kind: 'allow' }));

      ctx.emit('session/created', childSessionOf('c1', 's1'));
      const root = fakeObs(mocks.roots[0]);
      const child = root.spans.find((span) => span.name === 'subagent');
      expect(child).toBeDefined();
      expect(root.spans[1].spans).toHaveLength(0);

      ctx.emit('tools/result', first, okResult());
      ctx.emit('tools/result', second, okResult());
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

    it('does not mark a new parent turn when an old subagent fails', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      ctx.emit('session/event', sessionOf('s1'), turnEnd(0));
      ctx.emit('session/event', sessionOf('s1'), turnStart(1));
      const nextRoot = fakeObs(mocks.roots[1]);

      ctx.emit('subagent/end', subagentEnd('c1', 'error'));
      ctx.emit('session/event', sessionOf('s1'), turnEnd(1));
      expect(lastUpdate(nextRoot).metadata).not.toHaveProperty('hadErrors');
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
      // subagent/end fires — once started, the dispose must NOT close the span.
      ctx.emit('subagent/start', subagentStart('c1'));
      ctx.emit('session/disposed', sessionOf('c1'));
      expect(subSpan.ended).toBe(0);

      ctx.emit('subagent/end', subagentEnd('c1', 'completed'));
      expect(lastUpdate(subSpan)).toMatchObject({
        output: { stopReason: 'completed' },
        level: 'DEFAULT',
      });
      expect(subSpan.ended).toBe(1);
    });

    it('closes an unstarted child when activation rolls back', async () => {
      await setup();
      ctx.emit('session/event', sessionOf('s1'), turnStart(0));
      ctx.emit('session/created', childSessionOf('c1', 's1'));
      const subSpan = fakeObs(mocks.roots[0]).spans[0];

      ctx.emit('session/disposed', sessionOf('c1'));
      expect(subSpan.ended).toBe(1);
      expect(subSpan.updates.at(-1)).toMatchObject({ level: 'WARNING' });

      // A late end from an already rolled-back activation must not close it twice.
      ctx.emit('subagent/end', subagentEnd('c1', 'completed'));
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

      await dispatchTool(
        ctx,
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
      ctx.emit(
        'session/event',
        sessionOf('s1'),
        ev('hook/invoked', {
          turn: 0,
          point: 'PreToolUse',
          dialect: 'codex',
          handlerId: 'handler-3',
        }),
      );
      const root = fakeObs(mocks.roots[0]);
      const subSpan = root.spans[0];
      const hookSpan = root.spans[1];

      await ctx.fiber.dispose();
      expect(root.ended).toBe(1);
      expect(subSpan.ended).toBe(1);
      expect(hookSpan.ended).toBe(1);
      expect(lastUpdate(hookSpan)).toMatchObject({ level: 'WARNING' });
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
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    });
  });

  it('omits absent buckets and subtracts reasoning into its own bucket', () => {
    expect(usageOf({ inputTokens: 10, outputTokens: 5, reasoningTokens: 4 })).toEqual({
      input: 10,
      output: 1,
      total: 15,
      output_reasoning_tokens: 4,
    });
  });

  it('coalesces absent primary fields instead of emitting NaN', () => {
    expect(usageOf({} as never)).toEqual({ input: 0, output: 0, total: 0 });
    expect(usageOf({ reasoningTokens: 4 } as never).output).toBe(0);
  });
});

describe('LangfuseReporter', () => {
  it.each(['prefix-sk-lf-key?private-tail', 'sk-lf-key?private-tail', 'abcab'])(
    'redacts overlapping exact and recognizable credentials: %s',
    async (secretKey) => {
      const reporter = new LangfuseReporter({ ...config, secretKey });
      await reporter.ready;
      expect(reporter.mask(secretKey)).toBe('[REDACTED]');
      if (secretKey === 'abcab') expect(reporter.mask('abcabcab')).toBe('[REDACTED]');
      await reporter.shutdown();
    },
  );

  it('keeps redaction idempotent for short credentials and existing markers', async () => {
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const masked = reporter.mask('sk');
    expect(masked).toBe('[REDACTED]');
    expect(reporter.mask(masked)).toBe(masked);
    expect(reporter.mask('prefix sk [REDACTED]')).toBe('prefix [REDACTED] [REDACTED]');
    await reporter.shutdown();
  });

  it('keeps marker overlap checks linear with many existing redaction markers', async () => {
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const masked = reporter.mask(`${'[REDACTED]'.repeat(100)}sk`);
    expect(reporter.mask(masked)).toBe(masked);
    expect(masked.match(/\[REDACTED\]/g)).toHaveLength(101);
    await reporter.shutdown();
  });

  it('does not expand markers when a configured secret contains marker text', async () => {
    const reporter = new LangfuseReporter({ ...config, secretKey: 'x[REDACTED]y' });
    await reporter.ready;
    expect(reporter.mask('x[REDACTED]y')).toBe('x[REDACTED]y');
    expect(reporter.mask('[REDACTED]')).toBe('[REDACTED]');
    await reporter.shutdown();
  });

  it('redacts processor environment/release labels, including SDK env fallbacks', async () => {
    vi.stubEnv('LANGFUSE_TRACING_ENVIRONMENT', 'sk-lf-environment');
    vi.stubEnv('LANGFUSE_RELEASE', 'sk-lf-release');
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    expect(mocks.processors[0].config).toMatchObject({
      environment: 'redacted',
      release: '[REDACTED]',
    });
    await reporter.shutdown();
    const explicit = new LangfuseReporter({
      ...config,
      environment: 'staging',
      release: 'sk-lf-explicit',
    });
    await explicit.ready;
    expect(mocks.processors[1].config).toMatchObject({
      environment: 'staging',
      release: '[REDACTED]',
    });
    await explicit.shutdown();
  });

  it('lazily constructs the export pipeline with the connection config', async () => {
    const reporter = new LangfuseReporter(config);
    expect(mocks.processors).toHaveLength(0);
    await reporter.ready;
    expect(mocks.processors[0].config).toMatchObject(config);
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
      usageDetails: { input: 10, output: 5, total: 17, cache_read_input_tokens: 2 },
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

  it('ends observations when final updates fail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new LangfuseReporter(config);
    await reporter.ready;
    const root = fakeSpan(reporter.openTrace({ name: 't' }));
    const generation = fakeGen(reporter.startGeneration(root, { name: 'g' }));
    const renamed = fakeGen(reporter.startGeneration(root, { name: 'renamed' }));
    const span = fakeSpan(reporter.startSpan(root, { name: 's' }));

    vi.spyOn(generation, 'update').mockImplementation(() => {
      throw new Error('update failed');
    });
    reporter.endGeneration(generation, {});
    expect(generation.ended).toBe(1);

    vi.spyOn(renamed.otelSpan, 'updateName').mockImplementation(() => {
      throw new Error('rename failed');
    });
    reporter.endGeneration(renamed, { name: 'new-name' });
    expect(renamed.ended).toBe(1);

    vi.spyOn(span, 'update').mockImplementation(() => {
      throw new Error('update failed');
    });
    reporter.endSpan(span);
    expect(span.ended).toBe(1);

    vi.spyOn(root, 'setTraceIO').mockImplementation(() => {
      throw new Error('trace IO failed');
    });
    reporter.endSpan(root, { output: 'done' });
    expect(root.ended).toBe(1);
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
