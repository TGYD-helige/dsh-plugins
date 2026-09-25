import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Message, type Part, Role, TaskState } from '@a2a-js/sdk';
import type { AgentExecutionEvent, ExecutionEventBus } from '@a2a-js/sdk/server';
import {
  DefaultExecutionEventBus,
  RequestContext,
  ServerCallContext,
  STATE_HEADERS_KEY,
} from '@a2a-js/sdk/server';
import { Context } from '@deepseek-ai/cordis';
import type {
  Agent,
  AgentHandle,
  AgentRegistry,
  AssistantStreamFrame,
} from '@deepseek-ai/dsh-agent';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real dsh-agent root module imports workspace-internal packages
// (dsh-scope) absent from this dev install — the bridge needs only
// installModelSelection from it.
const mocks = vi.hoisted(() => ({ installModelSelection: vi.fn() }));
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: mocks.installModelSelection }));

import type { A2aApprovalCodec } from './approval.js';
import { A2aBridge, type TaskEntry } from './bridge.js';
import { DshAgentExecutor } from './executor.js';
import { startA2aServer } from './server.js';
import { MemoryTaskStore, SanitizedTaskStore } from './task-store.js';

// ---------------------------------------------------------------------------
// fake dsh runtime: a scripted Agent behind a registry-shaped fake
// ---------------------------------------------------------------------------

let seq = 0;
function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEvent {
  return { type, seq: seq++, time: Date.now(), data } as SessionEvent;
}

/** One live `agent/assistant-stream` text-delta frame (the V3 delta channel) — minimal shape; the bridge reads only `type` and `chunk`. */
const textDelta = (text: string): AssistantStreamFrame =>
  ({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text } }) as never;
const assistantMessage = (text: string) =>
  event('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 3, outputTokens: 4 },
  } as never);
const turnEnd = (reason: TurnEndReason) => event('turn/end', { turn: 1, reason });

/** One scripted turn: durable session events interleaved with live stream frames. */
function scriptTurn(fake: FakeAgent): void {
  fake.emit([event('turn/start', { turn: 1 })]);
  fake.stream([textDelta('hello '), textDelta('there')]);
  fake.emit([assistantMessage('hello there'), turnEnd({ kind: 'completed' })]);
}
let runScript = scriptTurn;

interface FakeAgent {
  agent: Agent;
  handle: AgentHandle;
  sessionId: SessionId;
  /** Follow-up messages the loop received (text blocks joined). */
  prompts: string[];
  /** Follow-up content blocks the loop received, verbatim per message. */
  contents: Array<Array<{ type: string; text?: string; attachment?: unknown }>>;
  /** Emitted session events are scripted here per test. */
  emit: (events: SessionEvent[]) => void;
  /** Live assistant-stream frames are scripted here per test. */
  stream: (frames: AssistantStreamFrame[]) => void;
}

function fakeAgents(ctx: Context) {
  const created: FakeAgent[] = [];
  const registry = {
    create: vi.fn(
      async (options: {
        sessionId: SessionId;
        agentOptions?: { provider?: string; model?: string };
        meta?: Record<string, unknown>;
        setup?: (agentCtx: Context) => void | Promise<void>;
      }): Promise<AgentHandle> => {
        const session = { id: options.sessionId } as Session;
        const fake: FakeAgent = {
          sessionId: options.sessionId,
          prompts: [],
          contents: [],
          emit: (events) => {
            for (const e of events) ctx.emit('session/event', session, e);
          },
          stream: (frames) => {
            for (const frame of frames)
              ctx.emit('agent/assistant-stream', { agent: fake.agent, frame });
          },
          agent: undefined as never,
          handle: undefined as never,
        };
        const agent = {
          id: options.sessionId,
          session,
          options: options.agentOptions ?? {},
          status: 'idle',
          followup: vi.fn(
            (message: {
              id: string;
              content: Array<{ type: string; text?: string; attachment?: unknown }>;
            }) => {
              if ((fake as FakeAgent & { failFollowup?: boolean }).failFollowup) {
                throw new Error('inbox closed');
              }
              ctx.emit('agent/inbox/inserted', { agent, message: message as never });
              ctx.emit('agent/inbox/claimed', { agent, message: message as never, turn: 1 });
              fake.contents.push(message.content);
              fake.prompts.push(message.content.map((b) => b.text ?? '').join(''));
              runScript(fake);
            },
          ),
          cancel: vi.fn(() => {
            fake.emit([turnEnd({ kind: 'aborted', reason: { kind: 'user' } })]);
          }),
          whenIdle: vi.fn(async () => {}),
        } as unknown as Agent;
        fake.agent = agent;
        fake.handle = { agent, dispose: vi.fn(async () => {}) };
        // The real factory awaits creation-time setup before publication.
        await options.setup?.(ctx);
        created.push(fake);
        return fake.handle;
      },
    ),
  } as unknown as AgentRegistry;
  ctx.provide('agents', registry);
  return { registry, created };
}

function userMessage(text: string): Message {
  return {
    messageId: 'user-1',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [part({ $case: 'text', value: text }, 'text/plain')],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function part(content: Part['content'], mediaType = '', filename = ''): Part {
  return { content, metadata: undefined, filename, mediaType };
}

function requestContext(message: Message, taskId: string, contextId: string): RequestContext {
  return new RequestContext(
    { tenant: '', message, configuration: undefined, metadata: undefined },
    taskId,
    contextId,
    new ServerCallContext({ state: new Map([[STATE_HEADERS_KEY, { 'x-example': 'value' }]]) }),
  );
}

function collect(bus: ExecutionEventBus) {
  const seen: AgentExecutionEvent[] = [];
  let finished = false;
  bus.on('event', (e) => seen.push(e));
  bus.on('finished', () => {
    finished = true;
  });
  return { seen, isFinished: () => finished };
}

type StatusUpdate = Extract<AgentExecutionEvent, { kind: 'statusUpdate' }>['data'];

const statusUpdates = (events: AgentExecutionEvent[]) =>
  events
    .filter(
      (e): e is Extract<AgentExecutionEvent, { kind: 'statusUpdate' }> => e.kind === 'statusUpdate',
    )
    .map((e) => e.data);

const textOfStatus = (update: StatusUpdate | undefined) => {
  const part = update?.status?.message?.parts[0];
  return part?.content?.$case === 'text' ? part.content.value : undefined;
};

describe('A2aBridge + DshAgentExecutor', () => {
  let ctx: Context;
  let bridge: A2aBridge;
  let agents: ReturnType<typeof fakeAgents>;

  const createCalls = () => (agents.registry.create as ReturnType<typeof vi.fn>).mock.calls;

  beforeEach(() => {
    seq = 0;
    runScript = scriptTurn;
    ctx = new Context();
    agents = fakeAgents(ctx);
    bridge = new A2aBridge(ctx, { cwd: '/tmp', agentOptions: { model: 'm' } });
    mocks.installModelSelection.mockClear();
  });

  afterEach(vi.unstubAllGlobals);

  async function executeMessage(taskId: string, contextId: string, message: Message) {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const collector = collect(bus);
    await executor.execute(requestContext(message, taskId, contextId), bus);
    return { bus, ...collector };
  }

  async function execute(taskId: string, contextId: string, text = 'hi') {
    return executeMessage(taskId, contextId, userMessage(text));
  }

  it.each([
    ['allowed-once', true],
    ['rejected', false],
  ] as const)('continues the same turn after an %s approval reply', async (outcome, allowed) => {
    const decisions: string[] = [];
    let toolExecuted = false;
    runScript = (fake) => {
      fake.emit([event('turn/start', { turn: 1 })]);
      fake.emit([
        event('approval/asked', {
          id: 'request-1',
          toolName: 'shell',
          callId: 'call-1',
          reason: 'Run command?',
        } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          {
            agent: fake.agent,
            toolName: 'shell',
            callId: 'call-1' as never,
            reason: 'Run command?',
          },
          async () => 'unavailable',
        )
        .then((answer) => {
          decisions.push(answer);
          toolExecuted = answer === 'allowed-once';
          fake.emit([assistantMessage('done'), turnEnd({ kind: 'completed' })]);
        });
    };
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const original = executor.execute(requestContext(userMessage('work'), 't1', 'ctx1'), bus);
    await vi.waitFor(() =>
      expect(
        statusUpdates(seen).some(
          (status) => status.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED,
        ),
      ).toBe(true),
    );
    const prompt = statusUpdates(seen).find(
      (status) => status.metadata?.dshAgent?.reason === 'approval',
    );
    expect(prompt?.status?.message?.parts[0].content).toEqual({
      $case: 'data',
      value: {
        requestId: 'request-1',
        toolName: 'shell',
        reason: 'Run command?',
        callId: 'call-1',
      },
    });
    const reply = userMessage('');
    reply.taskId = 't1';
    reply.contextId = 'ctx1';
    reply.parts = [
      part({ $case: 'data', value: { requestId: 'request-1', callId: 'call-1', outcome } }),
    ];
    expect(() => bridge.validateApprovalMessage({ ...reply, taskId: 'foreign' })).toThrow();
    expect(() =>
      bridge.validateApprovalMessage({
        ...reply,
        parts: [
          part({ $case: 'data', value: { requestId: 'request-1', outcome: 'proceed_always' } }),
        ],
      }),
    ).toThrow();
    await executor.execute(requestContext(reply, 't1', 'ctx1'), bus);
    await original;
    expect(decisions).toEqual([outcome]);
    expect(toolExecuted).toBe(allowed);
    expect(agents.created[0].prompts).toEqual(['work']);
    expect(() => bridge.validateApprovalMessage(reply)).toThrow();
  });

  it('accepts a deployment codec that correlates a legacy callId-only reply', async () => {
    const codec: A2aApprovalCodec = {
      encode: ({ callId, toolName }) => ({ callId, toolName }),
      decode: (message) => {
        const part = message.parts[0]?.content;
        if (part?.$case !== 'data' || typeof part.value.callId !== 'string') return;
        if (part.value.outcome !== 'allowed-once' && part.value.outcome !== 'rejected')
          throw new Error('Unsupported outcome');
        return { callId: part.value.callId, outcome: part.value.outcome };
      },
    };
    ctx.provide('a2aApprovalCodec', codec);
    bridge = new A2aBridge(ctx, { cwd: '/tmp' });
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', { id: 'request-2', toolName: 'shell', callId: 'call-2' } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          { agent: fake.agent, toolName: 'shell', callId: 'call-2' as never },
          async () => 'unavailable',
        )
        .then(() => fake.emit([turnEnd({ kind: 'completed' })]));
    };
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const original = executor.execute(requestContext(userMessage('work'), 't2', 'ctx2'), bus);
    await vi.waitFor(() =>
      expect(
        statusUpdates(seen).some((status) => status.metadata?.dshAgent?.reason === 'approval'),
      ).toBe(true),
    );
    const reply = userMessage('');
    reply.taskId = 't2';
    reply.contextId = 'ctx2';
    reply.parts = [part({ $case: 'data', value: { callId: 'call-2', outcome: 'allowed-once' } })];
    await executor.execute(requestContext(reply, 't2', 'ctx2'), bus);
    await original;
    expect(agents.created[0].prompts).toEqual(['work']);
  });

  it('serializes concurrent asks and matches each confirmation by request ID', async () => {
    const decisions: string[] = [];
    runScript = (fake) => {
      fake.emit([event('turn/start', { turn: 1 })]);
      for (const number of [1, 2]) {
        fake.emit([
          event('approval/asked', {
            id: `request-${number}`,
            toolName: 'shell',
            callId: `call-${number}`,
          } as never),
        ]);
        void ctx
          .waterfall(
            'approval/request',
            { agent: fake.agent, toolName: 'shell', callId: `call-${number}` as never },
            async () => 'unavailable',
          )
          .then((outcome) => {
            decisions.push(`${number}:${outcome}`);
            if (decisions.length === 2) fake.emit([turnEnd({ kind: 'completed' })]);
          });
      }
    };
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const original = executor.execute(requestContext(userMessage('work'), 't1', 'ctx1'), bus);
    await vi.waitFor(() =>
      expect(
        statusUpdates(seen).filter((s) => s.metadata?.dshAgent?.reason === 'approval'),
      ).toHaveLength(1),
    );
    const reply = (requestId: string, callId: string) => {
      const message = userMessage('');
      message.taskId = 't1';
      message.contextId = 'ctx1';
      message.parts = [
        part({ $case: 'data', value: { requestId, callId, outcome: 'allowed-once' } }),
      ];
      return message;
    };
    expect(() => bridge.validateApprovalMessage(reply('request-2', 'call-1'))).toThrow();
    const first = executor.execute(requestContext(reply('request-1', 'call-1'), 't1', 'ctx1'), bus);
    await vi.waitFor(() =>
      expect(
        statusUpdates(seen).filter((s) => s.metadata?.dshAgent?.reason === 'approval'),
      ).toHaveLength(2),
    );
    expect(() => bridge.validateApprovalMessage(reply('request-1', 'call-1'))).toThrow();
    await executor.execute(requestContext(reply('request-2', 'call-2'), 't1', 'ctx1'), bus);
    await Promise.all([first, original]);
    expect(decisions).toEqual(['1:allowed-once', '2:allowed-once']);
    expect(agents.created[0].prompts).toEqual(['work']);
  });

  it('fails closed when two unclaimed asks have no distinguishing call ID', async () => {
    const decisions: string[] = [];
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', { id: 'request-1', toolName: 'shell' } as never),
        event('approval/asked', { id: 'request-2', toolName: 'shell' } as never),
      ]);
      for (let i = 0; i < 2; i++) {
        void ctx
          .waterfall(
            'approval/request',
            { agent: fake.agent, toolName: 'shell' },
            async () => 'unavailable',
          )
          .then((outcome) => {
            decisions.push(outcome);
            if (decisions.length === 2) fake.emit([turnEnd({ kind: 'completed' })]);
          });
      }
    };
    const { seen } = await execute('t1', 'ctx1');
    expect(decisions).toEqual(['unavailable', 'unavailable']);
    expect(
      statusUpdates(seen).some((status) => status.metadata?.dshAgent?.reason === 'approval'),
    ).toBe(false);
  });

  it('withdraws an approval when the task is canceled', async () => {
    const decisions: string[] = [];
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', { id: 'request-1', toolName: 'shell' } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          { agent: fake.agent, toolName: 'shell' },
          async () => 'unavailable',
        )
        .then((outcome) => decisions.push(outcome));
    };
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const original = executor.execute(requestContext(userMessage('work'), 't1', 'ctx1'), bus);
    await vi.waitFor(() =>
      expect(statusUpdates(seen).some((s) => s.metadata?.dshAgent?.reason === 'approval')).toBe(
        true,
      ),
    );
    await executor.cancelTask('t1', bus);
    await original;
    expect(decisions).toEqual(['cancelled']);
    const late = userMessage('');
    late.taskId = 't1';
    late.contextId = 'ctx1';
    late.parts = [
      part({ $case: 'data', value: { requestId: 'request-1', outcome: 'allowed-once' } }),
    ];
    expect(() => bridge.validateApprovalMessage(late)).toThrow();
  });

  it('withdraws an approval on request abort', async () => {
    const controller = new AbortController();
    const decisions: string[] = [];
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', { id: 'request-abort', toolName: 'shell' } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          { agent: fake.agent, toolName: 'shell', signal: controller.signal },
          async () => 'unavailable',
        )
        .then((outcome) => {
          decisions.push(outcome);
          fake.emit([turnEnd({ kind: 'completed' })]);
        });
    };
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const original = executor.execute(requestContext(userMessage('work'), 't1', 'ctx1'), bus);
    await vi.waitFor(() =>
      expect(statusUpdates(seen).some((s) => s.metadata?.dshAgent?.reason === 'approval')).toBe(
        true,
      ),
    );
    controller.abort();
    await original;
    expect(decisions).toEqual(['cancelled']);
    const late = userMessage('');
    late.taskId = 't1';
    late.contextId = 'ctx1';
    late.parts = [
      part({ $case: 'data', value: { requestId: 'request-abort', outcome: 'allowed-once' } }),
    ];
    expect(() => bridge.validateApprovalMessage(late)).toThrow();
  });

  it.each(['clear', 'dispose'] as const)('withdraws a pending approval on %s', async (action) => {
    const decisions: string[] = [];
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', { id: 'request-cleanup', toolName: 'shell' } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          { agent: fake.agent, toolName: 'shell' },
          async () => 'unavailable',
        )
        .then((outcome) => decisions.push(outcome));
    };
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const original = executor.execute(requestContext(userMessage('work'), 't1', 'ctx1'), bus);
    await vi.waitFor(() =>
      expect(statusUpdates(seen).some((s) => s.metadata?.dshAgent?.reason === 'approval')).toBe(
        true,
      ),
    );
    if (action === 'clear') await bridge.clearContext('ctx1');
    else await bridge.dispose();
    await original;
    expect(decisions).toEqual(['cancelled']);
    expect(agents.created[0].handle.dispose).toHaveBeenCalledOnce();
  });

  it('resumes approvals through blocking send, SSE, and task resubscribe', async () => {
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', {
          id: 'request-http',
          toolName: 'shell',
          callId: 'call-http',
        } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          { agent: fake.agent, toolName: 'shell', callId: 'call-http' as never },
          async () => 'unavailable',
        )
        .then(() => fake.emit([assistantMessage('done'), turnEnd({ kind: 'completed' })]));
    };
    const server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.1' },
      executor: new DshAgentExecutor(bridge),
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
      approvalGuard: (message) => bridge.reserveApprovalMessage(message),
    });
    const rpc = async (method: string, params: unknown) =>
      (
        await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).json() as Promise<any>;
    try {
      const first = await rpc('SendMessage', {
        tenant: '',
        message: { messageId: 'user-http', role: 'user', parts: [{ text: 'work' }] },
      });
      expect(first.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      const { id: taskId, contextId } = first.result.task;
      const data = first.result.task.status.message.parts[0].data;
      expect(data).toMatchObject({ requestId: 'request-http', callId: 'call-http' });
      const stored = await rpc('GetTask', { tenant: '', id: taskId });
      expect(stored.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      const subscription = await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'SubscribeToTask',
          params: { tenant: '', id: taskId },
        }),
      });
      const reader = subscription.body!.getReader();
      const initial = await reader.read();
      expect(new TextDecoder().decode(initial.value)).toContain('TASK_STATE_INPUT_REQUIRED');
      const bad = await rpc('SendMessage', {
        tenant: '',
        message: {
          messageId: 'bad',
          taskId,
          contextId,
          role: 'user',
          parts: [{ data: { requestId: 'request-http', outcome: 'proceed_always' } }],
        },
      });
      expect(bad.error).toBeDefined();
      const reply = await rpc('SendMessage', {
        tenant: '',
        message: {
          messageId: 'reply',
          taskId,
          contextId,
          role: 'user',
          parts: [
            { data: { requestId: 'request-http', callId: 'call-http', outcome: 'allowed-once' } },
          ],
        },
      });
      expect(reply.result.task.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(reply.result.task.status.message.parts[0].text).toBe('done');
      expect(agents.created[0].prompts).toEqual(['work']);
      let continuation = '';
      while (!continuation.includes('done')) {
        const next = await reader.read();
        expect(next.done).toBe(false);
        continuation += new TextDecoder().decode(next.value);
      }
      expect(continuation).toContain('TASK_STATE_WORKING');
      expect(continuation).toContain('done');
      await reader.cancel();

      const streamed = await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'SendStreamingMessage',
          params: {
            tenant: '',
            message: { messageId: 'user-stream', role: 'user', parts: [{ text: 'stream' }] },
          },
        }),
      });
      const frames = (await streamed.text())
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)));
      expect(frames.at(-1).result.statusUpdate.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      const streamTaskId = frames[0].result.task.id;
      const streamReply = await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'SendStreamingMessage',
          params: {
            tenant: '',
            message: {
              messageId: 'reply-stream',
              taskId: streamTaskId,
              contextId: frames[0].result.task.contextId,
              role: 'user',
              parts: [{ data: { requestId: 'request-http', outcome: 'allowed-once' } }],
            },
          },
        }),
      });
      const replyFrames = (await streamReply.text())
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)));
      expect(
        replyFrames.some((frame) => frame.result?.task?.status?.state === 'TASK_STATE_WORKING'),
      ).toBe(true);
      expect(replyFrames.at(-1).result.statusUpdate.status.message.parts[0].text).toBe('done');
      expect(agents.created.at(-1)?.prompts).toEqual(['stream']);
      const canceled = await rpc('CancelTask', { tenant: '', id: streamTaskId });
      expect(canceled.result.status.state).toBe('TASK_STATE_CANCELED');
    } finally {
      await server.close();
    }
  });

  it('rejects a simultaneous duplicate reply before it can finish the live task bus', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const decisions: string[] = [];
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('approval/asked', {
          id: 'request-race',
          toolName: 'shell',
          callId: 'call-race',
        } as never),
      ]);
      void ctx
        .waterfall(
          'approval/request',
          { agent: fake.agent, toolName: 'shell', callId: 'call-race' as never },
          async () => 'unavailable',
        )
        .then(async (outcome) => {
          decisions.push(outcome);
          await toolGate;
          fake.emit([assistantMessage('done'), turnEnd({ kind: 'completed' })]);
        });
    };
    const store = new SanitizedTaskStore(new MemoryTaskStore());
    const load = store.load.bind(store);
    let taskId = '';
    vi.spyOn(store, 'load').mockImplementation(async (id, context) => {
      if (id === taskId) await loadGate;
      return load(id, context);
    });
    let guards = 0;
    const server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.1' },
      executor: new DshAgentExecutor(bridge),
      taskStore: store,
      approvalGuard: (message) => {
        if (message.messageId.startsWith('reply-') && ++guards === 2) releaseLoad();
        return bridge.reserveApprovalMessage(message);
      },
    });
    const rpc = async (message: Record<string, unknown>) =>
      (
        await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: message.messageId,
            method: 'SendMessage',
            params: { tenant: '', message },
          }),
        })
      ).json() as Promise<any>;
    try {
      const initial = await rpc({ messageId: 'original', role: 'user', parts: [{ text: 'work' }] });
      taskId = initial.result.task.id;
      const contextId = initial.result.task.contextId;
      const reply = (messageId: string) =>
        rpc({
          messageId,
          taskId,
          contextId,
          role: 'user',
          parts: [
            { data: { requestId: 'request-race', callId: 'call-race', outcome: 'allowed-once' } },
          ],
        });
      const first = reply('reply-1');
      const duplicate = reply('reply-2');
      await vi.waitFor(() => expect(guards).toBe(2));
      await vi.waitFor(() => expect(decisions).toEqual(['allowed-once']));
      releaseTool();
      const results = await Promise.all([first, duplicate]);
      expect(results.filter((result) => result.error)).toHaveLength(1);
      expect(
        results.filter(
          (result) => result.result?.task?.status?.message?.parts?.[0]?.text === 'done',
        ),
      ).toHaveLength(1);
      expect(agents.created[0].prompts).toEqual(['work']);
    } finally {
      releaseLoad();
      releaseTool();
      await server.close();
    }
  });

  it('runs a full turn: task anchor, working, deltas, final input-required', async () => {
    const admitted = vi.fn();
    const order: string[] = [];
    ctx.on('a2a/message-admitted', admitted);
    ctx.on('a2a/message-admitted', () => order.push('admitted'));
    ctx.on('agent/inbox/claimed', () => order.push('claimed'));
    const { seen, isFinished } = await execute('t1', 'ctx1', 'fix the bug');

    expect(isFinished()).toBe(true);
    expect(agents.created).toHaveLength(1);
    expect(agents.created[0].sessionId).toBe('ctx1');
    expect(agents.created[0].prompts).toEqual(['fix the bug']);
    expect(admitted).toHaveBeenCalledWith({
      contextId: 'ctx1',
      taskId: 't1',
      a2aMessageId: 'user-1',
      dshMessageId: expect.any(String),
      requestHeaders: { 'x-example': 'value' },
    });
    expect(agents.created[0].agent.followup).toHaveBeenCalledWith(
      expect.objectContaining({ id: admitted.mock.calls[0][0].dshMessageId }),
    );
    expect(order).toEqual(['admitted', 'claimed']);

    const task = seen[0];
    expect(task.kind).toBe('task');
    if (task.kind !== 'task') throw new Error('unreachable');
    expect(task.data.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task.data.history[0].messageId).toBe('user-1');

    const statuses = statusUpdates(seen);
    expect(statuses[0].status?.state).toBe(TaskState.TASK_STATE_WORKING);
    const texts = statuses.map(textOfStatus).filter(Boolean);
    expect(texts).toContain('hello ');
    expect(texts).toContain('there');
    const final = statuses.at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(textOfStatus(final)).toBe('hello there');
    expect(final.metadata?.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('continues an existing task by taskId with a working anchor', async () => {
    await execute('t1', 'ctx1');
    const { seen } = await execute('t1', 'ctx1', 'again');
    expect(agents.created).toHaveLength(1);
    // A2A 1.0 stream ordering: the first event of every execute is a task snapshot.
    expect(seen[0].kind).toBe('task');
    if (seen[0].kind !== 'task') throw new Error('unreachable');
    expect(seen[0].data.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(agents.created[0].prompts).toEqual(['hi', 'again']);
  });

  it('rebinds a live context to a fresh task id (contextId-only continuation)', async () => {
    await execute('t1', 'ctx1');
    const { seen } = await execute('t2', 'ctx1', 'context follow-up');
    expect(agents.created).toHaveLength(1);
    expect(seen[0].kind).toBe('task');
    if (seen[0].kind !== 'task') throw new Error('unreachable');
    expect(seen[0].data.id).toBe('t2');
    expect(seen[0].data.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });

  it('resumes a persisted context after restart instead of creating it again', async () => {
    ctx.provide('sessionPersistence', { stat: vi.fn(async () => ({ id: 'ctx1' })) });
    const originalCreate = agents.registry.create;
    agents.registry.resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: SessionId }) =>
      originalCreate({ sessionId: resumeSessionId }),
    );
    await execute('t1', 'ctx1');
    expect(agents.registry.resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'ctx1' }),
    );
    expect(await bridge.clearContext('ctx1')).toEqual(['t1']);
  });

  it('clears an idle bound task and permits a fresh binding', async () => {
    await execute('t1', 'ctx1');
    expect(await bridge.clearContext('ctx1')).toEqual(['t1']);
    expect(agents.created[0].handle.dispose).toHaveBeenCalledOnce();
    await execute('t2', 'ctx1');
    expect(agents.created).toHaveLength(2);
  });

  it('waits for an in-flight creation and blocks rebinding through stored cleanup', async () => {
    let creationStarted!: () => void;
    let releaseCreation!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    ctx.provide('agentPresets', {
      resolve: async () => {
        creationStarted();
        await creationGate;
        return { id: 'code' };
      },
      mount: async () => {},
    });
    const creating = bridge.ensureTask('t1', 'ctx1');
    await started;
    let releaseCleanup!: () => void;
    let cleanupStarted!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleaning = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const cleared = bridge.clearContext('ctx1', async (ids) => {
      expect(ids).toEqual(['t1']);
      cleanupStarted();
      await cleanupGate;
      return ids;
    });
    releaseCreation();
    await creating;
    await cleaning;
    await expect(bridge.ensureTask('t2', 'ctx1')).rejects.toThrow(/being cleared/);
    releaseCleanup();
    expect(await cleared).toEqual(['t1']);
    expect(agents.created[0].handle.dispose).toHaveBeenCalledOnce();
  });

  it('waits for an execute still building content before clearing', async () => {
    let started!: () => void;
    let release!: () => void;
    const building = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(bridge, 'buildContent').mockImplementation(async () => {
      started();
      await gate;
      return [{ type: 'text', text: 'hi' }];
    });
    const order: string[] = [];
    const bus = new DefaultExecutionEventBus();
    const suppress = vi.fn();
    const executing = new DshAgentExecutor(bridge, suppress)
      .execute(requestContext(userMessage('hi'), 't1', 'ctx1'), bus)
      .then(() => {
        order.push('executed');
      });
    await building;
    const clearing = bridge.clearContext('ctx1').then(() => {
      order.push('cleared');
    });
    release();
    await Promise.all([executing, clearing]);
    expect(order).toEqual(['executed', 'cleared']);
    expect(agents.created).toHaveLength(0);
    expect(suppress).toHaveBeenCalledWith('t1');
  });

  it('suppresses a new task started during stored cleanup', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleaning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cleared = bridge.clearContext('ctx1', async (ids) => {
      started();
      await gate;
      return ids;
    });
    await cleaning;
    const suppress = vi.fn();
    await new DshAgentExecutor(bridge, suppress).execute(
      requestContext(userMessage('hi'), 't1', 'ctx1'),
      new DefaultExecutionEventBus(),
    );
    expect(suppress).toHaveBeenCalledWith('t1');
    release();
    await cleared;
  });

  it('cancels and drains a live turn before clearing its binding', async () => {
    let session: Session;
    agents.registry.create = vi.fn(async ({ sessionId }: { sessionId: SessionId }) => {
      session = { id: sessionId } as Session;
      return {
        agent: {
          session,
          followup: vi.fn(() =>
            ctx.emit('session/event', session, event('turn/start', { turn: 1 })),
          ),
          cancel: vi.fn(() =>
            ctx.emit(
              'session/event',
              session,
              turnEnd({ kind: 'aborted', reason: { kind: 'user' } }),
            ),
          ),
          whenIdle: vi.fn(async () => {}),
        } as unknown as Agent,
        dispose: vi.fn(async () => {}),
      };
    });
    const bus = new DefaultExecutionEventBus();
    const collector = collect(bus);
    const running = new DshAgentExecutor(bridge).execute(
      requestContext(userMessage('hi'), 't1', 'ctx1'),
      bus,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(await bridge.clearContext('ctx1')).toEqual(['t1']);
    await running;
    expect(collector.isFinished()).toBe(true);
  });

  it("keeps a previous binding's late turn/end out of a rebound task", async () => {
    // Turns never end on their own here; the test drives every event.
    let session: Session;
    agents.registry.create = vi.fn(
      async (options: { sessionId: SessionId }): Promise<AgentHandle> => {
        session = { id: options.sessionId } as Session;
        const agent = {
          id: options.sessionId,
          session,
          followup: vi.fn(() =>
            ctx.emit('session/event', session, event('turn/start', { turn: 1 })),
          ),
          cancel: vi.fn(),
          whenIdle: vi.fn(async () => {}),
        } as unknown as Agent;
        return { agent, dispose: vi.fn(async () => {}) };
      },
    );
    const executor = new DshAgentExecutor(bridge);

    const firstBus = new DefaultExecutionEventBus();
    collect(firstBus);
    const first = executor.execute(requestContext(userMessage('one'), 't1', 'ctx1'), firstBus);
    await new Promise((resolve) => setImmediate(resolve));

    // Rebind the context to t2 while t1's turn is still open (its cancel is
    // still propagating).
    const secondBus = new DefaultExecutionEventBus();
    const second = collect(secondBus);
    const secondRun = executor.execute(requestContext(userMessage('two'), 't2', 'ctx1'), secondBus);
    await new Promise((resolve) => setImmediate(resolve));

    // t1's late aborted turn/end must settle its waiter but publish nothing
    // under t2.
    ctx.emit('session/event', session!, turnEnd({ kind: 'aborted', reason: { kind: 'user' } }));
    expect(
      statusUpdates(second.seen).some((u) => u.status?.state === TaskState.TASK_STATE_CANCELED),
    ).toBe(false);

    // t2's own turn then completes normally.
    ctx.emit('session/event', session!, event('turn/start', { turn: 2 }));
    ctx.emit('session/event', session!, assistantMessage('ok'));
    ctx.emit('session/event', session!, turnEnd({ kind: 'completed' }));
    await Promise.all([first, secondRun]);
    const final = statusUpdates(second.seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(textOfStatus(final)).toBe('ok');
  });

  it('fails the task when agent creation throws', async () => {
    agents.registry.create = vi.fn(async () => {
      throw new Error('no agent factory registered');
    });
    const { seen, isFinished } = await execute('t9', 'ctx9');
    expect(isFinished()).toBe(true);
    expect(seen[0].kind).toBe('task');
    if (seen[0].kind !== 'task') throw new Error('unreachable');
    expect(seen[0].data.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(textOfStatus(final)).toBe('no agent factory registered');
  });

  it('fails fast on a message with no usable parts', async () => {
    const message: Message = { ...userMessage(''), parts: [part({ $case: 'text', value: '  ' })] };
    const { seen } = await executeMessage('t5', 'ctx5', message);
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(agents.created).toHaveLength(0);
  });

  describe('message parts', () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const docBytes = new TextEncoder().encode('hello doc');

    let uploadsCwd: string;

    beforeEach(async () => {
      uploadsCwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-a2a-uploads-'));
      bridge = new A2aBridge(ctx, {
        cwd: uploadsCwd,
        agentOptions: { model: 'm' },
        uploadsDir: uploadsCwd,
      });
    });

    function fakeAttachments() {
      const store = {
        imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
        saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
          attachmentId: `img-${input.name ?? 'image'}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 8,
          height: 8,
          name: input.name,
        })),
        saveFile: vi.fn(async (input: { data: Uint8Array; name?: string }) => ({
          attachmentId: `file-${input.name ?? 'upload'}`,
          name: input.name ?? 'upload',
          bytes: input.data.byteLength,
        })),
      };
      ctx.provide('attachments', store as unknown as AttachmentStore);
      return store;
    }

    const stubFetch = (body: ConstructorParameters<typeof Response>[0], contentType: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { headers: { 'content-type': contentType } })),
      );

    const promptPath = (prompt: string) => {
      const filePath = /path="([^"]+)"/.exec(prompt)?.[1];
      if (!filePath) throw new Error(`no path attribute in prompt: ${prompt}`);
      return filePath;
    };

    it('downloads a url file part locally when a store is composed', async () => {
      const store = fakeAttachments();
      stubFetch(docBytes, DOCX);
      const message: Message = {
        ...userMessage(''),
        parts: [
          part({ $case: 'text', value: '这个文档讲了啥' }, 'text/plain'),
          part({ $case: 'url', value: 'https://cdn.example.com/doc.docx' }, DOCX, 'doc.docx'),
        ],
      };
      const { seen } = await executeMessage('t1', 'ctx1', message);
      expect(store.saveFile).not.toHaveBeenCalled();
      const blocks = agents.created[0].contents[0];
      expect(blocks[0]).toMatchObject({ type: 'text', text: '这个文档讲了啥' });
      expect(blocks[1]).toMatchObject({ type: 'text' });
      expect(new Uint8Array(await readFile(promptPath(blocks[1].text ?? '')))).toEqual(docBytes);
      expect(statusUpdates(seen).at(-1)!.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    });

    it('materializes non-image files without saving another host attachment', async () => {
      const store = fakeAttachments();
      const materializeFile = vi.fn(async () => ({ readablePath: '/sandbox/ctx1/doc.docx' }));
      ctx.provide('a2aFileMaterializer', { materializeFile });
      const message: Message = {
        ...userMessage(''),
        parts: [part({ $case: 'raw', value: Buffer.from(docBytes) }, DOCX, 'doc.docx')],
      };

      await executeMessage('t1', 'ctx1', message);

      expect(store.saveFile).not.toHaveBeenCalled();
      expect(materializeFile).toHaveBeenCalledWith({
        contextId: 'ctx1',
        bytes: docBytes,
        filename: 'doc.docx',
        mediaType: DOCX,
      });
      expect(agents.created[0].contents[0]).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('path="/sandbox/ctx1/doc.docx"'),
        }),
      ]);
    });

    it('does not advertise a host path when the configured materializer fails', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const store = fakeAttachments();
      ctx.provide('a2aFileMaterializer', {
        materializeFile: vi.fn(async () => {
          throw new Error('remote upload failed');
        }),
      });
      const message: Message = {
        ...userMessage(''),
        parts: [part({ $case: 'raw', value: Buffer.from(docBytes) }, DOCX, 'doc.docx')],
      };

      await executeMessage('t1', 'ctx1', message);

      expect(store.saveFile).not.toHaveBeenCalled();
      expect(agents.created[0].contents[0]).toHaveLength(1);
      expect(agents.created[0].contents[0][0]).toMatchObject({ type: 'text' });
      expect(agents.created[0].prompts[0]).toContain('not delivered');
      expect(agents.created[0].prompts[0]).not.toContain('path="');
      expect(spy.mock.calls.some(([p]) => String(p).includes('[dsh-a2a]'))).toBe(true);
    });

    it('stores an inline raw image part as an image attachment', async () => {
      const store = fakeAttachments();
      const materializeFile = vi.fn();
      ctx.provide('a2aFileMaterializer', { materializeFile });
      const message: Message = {
        ...userMessage(''),
        parts: [
          part(
            { $case: 'raw', value: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
            'image/png',
            's.png',
          ),
        ],
      };
      await executeMessage('t1', 'ctx1', message);
      expect(store.saveImage).toHaveBeenCalledTimes(1);
      expect(store.saveImage.mock.calls[0][0]).toMatchObject({
        mediaType: 'image/png',
        name: 's.png',
      });
      expect(agents.created[0].contents[0][0]).toMatchObject({
        type: 'image',
        attachment: { attachmentId: 'img-s.png' },
      });
      expect(materializeFile).not.toHaveBeenCalled();
    });

    it('falls back to a file attachment when image admission rejects the bytes', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const store = fakeAttachments();
      const materializeFile = vi.fn();
      ctx.provide('a2aFileMaterializer', { materializeFile });
      store.saveImage.mockRejectedValue(new Error('not a png'));
      const message: Message = {
        ...userMessage(''),
        parts: [part({ $case: 'raw', value: Buffer.from('garbage') }, 'image/png', 's.png')],
      };
      await executeMessage('t1', 'ctx1', message);
      expect(store.saveFile).toHaveBeenCalledTimes(1);
      expect(materializeFile).not.toHaveBeenCalled();
      expect(agents.created[0].contents[0][0].type).toBe('file');
      expect(spy.mock.calls.some(([p]) => String(p).includes('[dsh-a2a]'))).toBe(true);
      spy.mockRestore();
    });

    it('persists a url file part into the workspace when no store is composed', async () => {
      stubFetch(docBytes, DOCX);
      const message: Message = {
        ...userMessage(''),
        parts: [
          part({ $case: 'text', value: '这个文档讲了啥' }, 'text/plain'),
          part({ $case: 'url', value: 'https://cdn.example.com/doc.docx' }, DOCX, 'doc.docx'),
        ],
      };
      const { seen } = await executeMessage('t1', 'ctx1', message);
      const prompt = agents.created[0].prompts[0];
      expect(prompt).toContain('<document name="doc.docx" uri="https://cdn.example.com/doc.docx"');
      expect(prompt).toContain(`type="${DOCX}"`);
      expect(prompt).toContain(`size="${docBytes.byteLength}"`);
      const filePath = promptPath(prompt);
      expect(filePath.startsWith(uploadsCwd)).toBe(true);
      expect(new Uint8Array(await readFile(filePath))).toEqual(docBytes);
      expect(statusUpdates(seen).at(-1)!.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    });

    it('defaults uploads to a dsh-a2a-uploads dir under the OS temp dir', async () => {
      bridge = new A2aBridge(ctx, { cwd: uploadsCwd, agentOptions: { model: 'm' } });
      const message: Message = {
        ...userMessage(''),
        parts: [part({ $case: 'raw', value: Buffer.from('x') }, 'text/plain', 'a.txt')],
      };
      await executeMessage('t1', 'ctx1', message);
      const filePath = promptPath(agents.created[0].prompts[0]);
      expect(filePath.startsWith(path.join(os.tmpdir(), 'dsh-a2a-uploads'))).toBe(true);
    });

    it('persists an anonymous raw part under a fallback name', async () => {
      const message: Message = {
        ...userMessage(''),
        parts: [part({ $case: 'raw', value: Buffer.from('plain body') }, 'text/plain')],
      };
      await executeMessage('t1', 'ctx1', message);
      const filePath = promptPath(agents.created[0].prompts[0]);
      expect(path.basename(filePath)).toBe('unnamed-file');
      expect(await readFile(filePath, 'utf8')).toBe('plain body');
    });

    it('sanitizes path separators out of upload filenames', async () => {
      const message: Message = {
        ...userMessage(''),
        parts: [
          part(
            { $case: 'raw', value: Buffer.from('x') },
            'application/octet-stream',
            '../../evil.sh',
          ),
        ],
      };
      await executeMessage('t1', 'ctx1', message);
      const prompt = agents.created[0].prompts[0];
      const filePath = promptPath(prompt);
      expect(prompt).toContain('name="evil.sh"');
      expect(path.basename(filePath)).toBe('evil.sh');
      expect(filePath.startsWith(uploadsCwd)).toBe(true);
    });

    it('keeps same-named uploads distinct', async () => {
      const message: Message = {
        ...userMessage(''),
        parts: [
          part({ $case: 'raw', value: Buffer.from('one') }, 'text/plain', 'a.txt'),
          part({ $case: 'raw', value: Buffer.from('two') }, 'text/plain', 'a.txt'),
        ],
      };
      await executeMessage('t1', 'ctx1', message);
      const paths = agents.created[0].contents[0].map((b) => promptPath(b.text ?? ''));
      expect(new Set(paths).size).toBe(2);
      expect(await readFile(paths[0], 'utf8')).toBe('one');
      expect(await readFile(paths[1], 'utf8')).toBe('two');
    });

    it('degrades a failed download to a note instead of failing the turn', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const store = fakeAttachments();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      const message: Message = {
        ...userMessage('hi'),
        parts: [
          part({ $case: 'text', value: 'hi' }, 'text/plain'),
          part({ $case: 'url', value: 'https://cdn.example.com/doc.docx' }, DOCX, 'doc.docx'),
        ],
      };
      const { seen } = await executeMessage('t1', 'ctx1', message);
      expect(store.saveFile).not.toHaveBeenCalled();
      expect(agents.created[0].prompts[0]).toContain('not delivered');
      expect(statusUpdates(seen).at(-1)!.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      expect(spy.mock.calls.some(([p]) => String(p).includes('[dsh-a2a]'))).toBe(true);
      spy.mockRestore();
    });

    it('maps a data part onto JSON text instead of failing', async () => {
      const message: Message = {
        ...userMessage(''),
        parts: [
          part({ $case: 'text', value: 'fix this' }, 'text/plain'),
          part({ $case: 'data', value: { type: 'error', line: 3 } }, 'application/json'),
        ],
      };
      const { seen } = await executeMessage('t1', 'ctx1', message);
      const prompt = agents.created[0].prompts[0];
      expect(prompt).toContain('<data>');
      expect(prompt).toContain('"type": "error"');
      expect(statusUpdates(seen).at(-1)!.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    });
  });

  it('cancelTask aborts the agent and publishes a canceled final', async () => {
    await execute('t1', 'ctx1');
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    await executor.cancelTask('t1', bus);
    expect(agents.created[0].agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(final.contextId).toBe('ctx1');
  });

  it('cancelTask on a task with no live agent still publishes a canceled final', async () => {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    await executor.cancelTask('ghost', bus);
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it('resolves an in-flight execute with a canceled final when the session is disposed', async () => {
    // A turn that never ends: only turn/start is scripted.
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen, isFinished } = collect(bus);
    agents.registry.create = vi.fn(
      async (options: { sessionId: SessionId }): Promise<AgentHandle> => {
        const session = { id: options.sessionId } as Session;
        const agent = {
          id: options.sessionId,
          followup: vi.fn(() =>
            ctx.emit('session/event', session, event('turn/start', { turn: 1 })),
          ),
          cancel: vi.fn(),
          whenIdle: vi.fn(async () => {}),
        } as unknown as Agent;
        return { agent, dispose: vi.fn(async () => ctx.emit('session/disposed', session)) };
      },
    );

    const pending = executor.execute(requestContext(userMessage('hi'), 't7', 'ctx7'), bus);
    await new Promise((resolve) => setImmediate(resolve));
    // external disposal (e.g. another plugin tearing the session down)
    const entry = (bridge as unknown as { tasks: Map<string, TaskEntry> }).tasks.get('t7')!;
    ctx.emit('session/disposed', { id: entry.sessionId } as Session);
    await pending;
    expect(isFinished()).toBe(true);
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it('dispose() cancels active turns and disposes every owned agent', async () => {
    await execute('t1', 'ctx1');
    await execute('t2', 'ctx2');
    expect(agents.created).toHaveLength(2);
    await bridge.dispose();
    for (const fake of agents.created) expect(fake.handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('never lets translation errors escape into the event stream', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await execute('t1', 'ctx1');
    const session = { id: agents.created[0].sessionId } as Session;
    // malformed durable event: message missing — translator would throw inside
    ctx.emit(
      'session/event',
      session,
      event('assistant/message', { turn: 1, step: 1, message: undefined } as never),
    );
    // malformed live frame: chunk missing — the stream path would throw inside
    agents.created[0].stream([
      { type: 'chunk', chunk: undefined } as unknown as AssistantStreamFrame,
    ]);
    expect(spy.mock.calls.some(([prefix]) => String(prefix).includes('[dsh-a2a]'))).toBe(true);
    spy.mockRestore();
  });

  describe('model selection', () => {
    it('resolves the deployment default and installs the selection at setup', async () => {
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'low',
        }),
      });
      bridge = new A2aBridge(ctx, { cwd: '/tmp' });
      await execute('t1', 'ctx1');
      expect(createCalls()[0][0].agentOptions).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      });
      expect(mocks.installModelSelection).toHaveBeenCalledWith(ctx, {
        current: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
          reasoningEffort: 'low',
        },
        assembled: undefined,
      });
    });

    it('prefers the configured provider/model over the deployment default', async () => {
      ctx.provide('agentDefaultModel', {
        currentSelection: () => ({ provider: 'default-p', model: 'default-m' }),
      });
      bridge = new A2aBridge(ctx, {
        cwd: '/tmp',
        agentOptions: { provider: 'my-provider', model: 'my-model' },
      });
      await execute('t1', 'ctx1');
      expect(createCalls()[0][0].agentOptions).toEqual({
        provider: 'my-provider',
        model: 'my-model',
      });
      expect(mocks.installModelSelection).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({
          current: expect.objectContaining({ provider: 'my-provider', model: 'my-model' }),
        }),
      );
    });

    it('creates the agent without a selection when neither source has one', async () => {
      bridge = new A2aBridge(ctx, { cwd: '/tmp' });
      await execute('t1', 'ctx1');
      expect(createCalls()[0][0].agentOptions).toBeUndefined();
      expect(createCalls()[0][0].setup).toBeUndefined();
      expect(mocks.installModelSelection).not.toHaveBeenCalled();
    });
  });

  describe('agent presets', () => {
    function fakePresets() {
      const presets = {
        resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
        mount: vi.fn(async () => ({})),
      };
      ctx.provide('agentPresets', presets);
      return presets;
    }

    it('mounts the deployment default preset and records it on the session meta', async () => {
      const presets = fakePresets();
      await execute('t1', 'ctx1');
      expect(presets.resolve).toHaveBeenCalledWith(undefined);
      expect(presets.mount).toHaveBeenCalledWith(ctx, 'standard');
      expect(createCalls()[0][0].meta).toEqual({ cwd: '/tmp', agentPreset: 'standard' });
    });

    it('mounts the configured preset instead of the default', async () => {
      const presets = fakePresets();
      bridge = new A2aBridge(ctx, { cwd: '/tmp', preset: 'code' });
      await execute('t1', 'ctx1');
      expect(presets.resolve).toHaveBeenCalledWith('code');
      expect(presets.mount).toHaveBeenCalledWith(ctx, 'code');
    });

    it('fails the task when the preset is unknown', async () => {
      const presets = fakePresets();
      presets.resolve.mockRejectedValue(new Error('unknown preset "nope"'));
      bridge = new A2aBridge(ctx, { cwd: '/tmp', preset: 'nope' });
      const { seen, isFinished } = await execute('t1', 'ctx1');
      expect(isFinished()).toBe(true);
      const final = statusUpdates(seen).at(-1)!;
      expect(final.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(textOfStatus(final)).toBe('unknown preset "nope"');
    });
  });

  it('fails the task when followup throws and does not poison later turns', async () => {
    await execute('t1', 'ctx1');
    const fake = agents.created[0] as FakeAgent & { failFollowup?: boolean };
    fake.failFollowup = true;
    const admitted = vi.fn();
    ctx.on('a2a/message-admitted', admitted);

    const failed = await execute('t1', 'ctx1', 'boom');
    const failedFinal = statusUpdates(failed.seen).at(-1)!;
    expect(failed.isFinished()).toBe(true);
    expect(failedFinal.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(textOfStatus(failedFinal)).toBe('inbox closed');
    expect(admitted).not.toHaveBeenCalled();

    // The stale waiter was spliced out: the next turn settles on its own
    // turn/end instead of inheriting the poisoned FIFO slot.
    fake.failFollowup = false;
    const recovered = await execute('t1', 'ctx1', 'again');
    const final = statusUpdates(recovered.seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(agents.created[0].prompts).toEqual(['hi', 'again']);
  });

  it('isolates a failing admission listener from the agent turn and other listeners', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.on('a2a/message-admitted', () => {
      throw new Error('observer failed');
    });
    const admitted = vi.fn();
    ctx.on('a2a/message-admitted', admitted);

    const { seen } = await execute('t1', 'ctx1');
    expect(statusUpdates(seen).at(-1)?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(agents.created[0].prompts).toEqual(['hi']);
    expect(admitted).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      '[dsh-a2a] message-admitted listener failed:',
      expect.any(AggregateError),
    );
    error.mockRestore();
  });
});
