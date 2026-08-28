import { type Message, Role, TaskState } from '@a2a-js/sdk';
import type { AgentExecutionEvent, ExecutionEventBus } from '@a2a-js/sdk/server';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server';
import { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real dsh-agent root module imports workspace-internal packages
// (dsh-scope) absent from this dev install — the bridge needs only
// installModelSelection from it.
const mocks = vi.hoisted(() => ({ installModelSelection: vi.fn() }));
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: mocks.installModelSelection }));

import { A2aBridge, type TaskEntry } from './bridge.js';
import { DshAgentExecutor } from './executor.js';

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

const textDelta = (text: string) =>
  event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } });
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

const SCRIPTED_TURN: SessionEvent[] = [
  event('turn/start', { turn: 1 }),
  textDelta('hello '),
  textDelta('there'),
  assistantMessage('hello there'),
  turnEnd({ kind: 'completed' }),
];

interface FakeAgent {
  agent: Agent;
  handle: AgentHandle;
  sessionId: SessionId;
  /** Follow-up messages the loop received. */
  prompts: string[];
  /** Emitted session events are scripted here per test. */
  emit: (events: SessionEvent[]) => void;
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
          emit: (events) => {
            for (const e of events) ctx.emit('session/event', session, e);
          },
          agent: undefined as never,
          handle: undefined as never,
        };
        const agent = {
          id: options.sessionId,
          options: options.agentOptions ?? {},
          status: 'idle',
          followup: vi.fn((message: { content: Array<{ type: string; text?: string }> }) => {
            if ((fake as FakeAgent & { failFollowup?: boolean }).failFollowup) {
              throw new Error('inbox closed');
            }
            fake.prompts.push(message.content.map((b) => b.text ?? '').join(''));
            fake.emit(SCRIPTED_TURN);
          }),
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
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function requestContext(message: Message, taskId: string, contextId: string): RequestContext {
  return new RequestContext(
    { tenant: '', message, configuration: undefined, metadata: undefined },
    taskId,
    contextId,
    new ServerCallContext(),
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
    ctx = new Context();
    agents = fakeAgents(ctx);
    bridge = new A2aBridge(ctx, { cwd: '/tmp', agentOptions: { model: 'm' } });
    mocks.installModelSelection.mockClear();
  });

  async function execute(taskId: string, contextId: string, text = 'hi') {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const collector = collect(bus);
    await executor.execute(requestContext(userMessage(text), taskId, contextId), bus);
    return { bus, ...collector };
  }

  it('runs a full turn: task anchor, working, deltas, final input-required', async () => {
    const { seen, isFinished } = await execute('t1', 'ctx1', 'fix the bug');

    expect(isFinished()).toBe(true);
    expect(agents.created).toHaveLength(1);
    expect(agents.created[0].sessionId).toBe('ctx1');
    expect(agents.created[0].prompts).toEqual(['fix the bug']);

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

  it('fails fast on messages without text parts', async () => {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    const message: Message = {
      ...userMessage(''),
      parts: [
        {
          content: { $case: 'data', value: {} },
          metadata: undefined,
          filename: '',
          mediaType: 'application/json',
        },
      ],
    };
    await executor.execute(requestContext(message, 't5', 'ctx5'), bus);
    const final = statusUpdates(seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(agents.created).toHaveLength(0);
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
    // malformed event: chunk missing — translator would throw inside
    ctx.emit(
      'session/event',
      session,
      event('assistant/chunk', { turn: 1, step: 1, chunk: undefined as never }),
    );
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

    const failed = await execute('t1', 'ctx1', 'boom');
    const failedFinal = statusUpdates(failed.seen).at(-1)!;
    expect(failed.isFinished()).toBe(true);
    expect(failedFinal.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(textOfStatus(failedFinal)).toBe('inbox closed');

    // The stale waiter was spliced out: the next turn settles on its own
    // turn/end instead of inheriting the poisoned FIFO slot.
    fake.failFollowup = false;
    const recovered = await execute('t1', 'ctx1', 'again');
    const final = statusUpdates(recovered.seen).at(-1)!;
    expect(final.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(agents.created[0].prompts).toEqual(['hi', 'again']);
  });
});
