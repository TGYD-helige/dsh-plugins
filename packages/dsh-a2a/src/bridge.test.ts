import type { Message } from '@a2a-js/sdk';
import type { AgentExecutionEvent, ExecutionEventBus } from '@a2a-js/sdk/server';
import { DefaultExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
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
        setup?: (agentCtx: Context) => void;
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
        // The real factory runs creation-time setup before publication.
        options.setup?.(ctx);
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
    kind: 'message',
    messageId: 'user-1',
    role: 'user',
    parts: [{ kind: 'text', text }],
  };
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

describe('A2aBridge + DshAgentExecutor', () => {
  let ctx: Context;
  let bridge: A2aBridge;
  let agents: ReturnType<typeof fakeAgents>;

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
    await executor.execute(new RequestContext(userMessage(text), taskId, contextId), bus);
    return { bus, ...collector };
  }

  it('runs a full turn: task anchor, working, deltas, final input-required', async () => {
    const { seen, isFinished } = await execute('t1', 'ctx1', 'fix the bug');

    expect(isFinished()).toBe(true);
    expect(agents.created).toHaveLength(1);
    expect(agents.created[0].sessionId).toBe('ctx1');
    expect(agents.created[0].prompts).toEqual(['fix the bug']);

    const task = seen[0] as { kind: string; status: { state: string }; history: Message[] };
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('submitted');
    expect(task.history[0].messageId).toBe('user-1');

    const statuses = seen.filter(
      (e): e is Extract<AgentExecutionEvent, { kind: 'status-update' }> =>
        e.kind === 'status-update',
    );
    expect(statuses[0].status.state).toBe('working');
    const texts = statuses
      .map((s) => s.status.message?.parts?.[0])
      .filter((p): p is Extract<NonNullable<typeof p>, { kind: 'text' }> => p?.kind === 'text')
      .map((p) => p.text);
    expect(texts).toContain('hello ');
    expect(texts).toContain('there');
    const final = statuses.at(-1)!;
    expect(final.status.state).toBe('input-required');
    expect(final.final).toBe(true);
    expect((final.status.message as Message).parts).toEqual([
      { kind: 'text', text: 'hello there' },
    ]);
    expect(final.metadata?.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('continues an existing task by taskId without a new agent or task anchor', async () => {
    await execute('t1', 'ctx1');
    const { seen } = await execute('t1', 'ctx1', 'again');
    expect(agents.created).toHaveLength(1);
    expect(seen[0].kind).toBe('status-update');
    expect(agents.created[0].prompts).toEqual(['hi', 'again']);
  });

  it('rebinds a live context to a fresh task id (contextId-only continuation)', async () => {
    await execute('t1', 'ctx1');
    const { seen } = await execute('t2', 'ctx1', 'context follow-up');
    expect(agents.created).toHaveLength(1);
    expect(seen[0].kind).toBe('task');
    expect((seen[0] as { id: string }).id).toBe('t2');
    const final = (
      seen.filter((e) => e.kind === 'status-update') as Array<{ status: { state: string } }>
    ).at(-1)!;
    expect(final.status.state).toBe('input-required');
  });

  it('fails the task when agent creation throws', async () => {
    agents.registry.create = vi.fn(async () => {
      throw new Error('no agent factory registered');
    });
    const { seen, isFinished } = await execute('t9', 'ctx9');
    expect(isFinished()).toBe(true);
    expect(seen[0].kind).toBe('task');
    const final = seen.at(-1) as Extract<AgentExecutionEvent, { kind: 'status-update' }>;
    expect(final.status.state).toBe('failed');
    expect(final.final).toBe(true);
    expect((final.status.message as Message).parts[0]).toEqual({
      kind: 'text',
      text: 'no agent factory registered',
    });
  });

  it('fails fast on messages without text parts', async () => {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    await executor.execute(
      new RequestContext(
        { kind: 'message', messageId: 'u2', role: 'user', parts: [{ kind: 'data', data: {} }] },
        't5',
        'ctx5',
      ),
      bus,
    );
    const final = seen.at(-1) as Extract<AgentExecutionEvent, { kind: 'status-update' }>;
    expect(final.status.state).toBe('failed');
    expect(agents.created).toHaveLength(0);
  });

  it('cancelTask aborts the agent and publishes a canceled final', async () => {
    await execute('t1', 'ctx1');
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    await executor.cancelTask('t1', bus);
    expect(agents.created[0].agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    const final = seen.at(-1) as Extract<AgentExecutionEvent, { kind: 'status-update' }>;
    expect(final.status.state).toBe('canceled');
    expect(final.contextId).toBe('ctx1');
  });

  it('cancelTask on a task with no live agent still publishes a canceled final', async () => {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const { seen } = collect(bus);
    await executor.cancelTask('ghost', bus);
    const final = seen.at(-1) as Extract<AgentExecutionEvent, { kind: 'status-update' }>;
    expect(final.status.state).toBe('canceled');
    expect(final.final).toBe(true);
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

    const pending = executor.execute(new RequestContext(userMessage('hi'), 't7', 'ctx7'), bus);
    await new Promise((resolve) => setImmediate(resolve));
    // external disposal (e.g. another plugin tearing the session down)
    const entry = (bridge as unknown as { tasks: Map<string, TaskEntry> }).tasks.get('t7')!;
    ctx.emit('session/disposed', { id: entry.sessionId } as Session);
    await pending;
    expect(isFinished()).toBe(true);
    const final = seen.at(-1) as Extract<AgentExecutionEvent, { kind: 'status-update' }>;
    expect(final.status.state).toBe('canceled');
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
    const createCalls = () => (agents.registry.create as ReturnType<typeof vi.fn>).mock.calls;

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

  it('fails the task when followup throws and does not poison later turns', async () => {
    await execute('t1', 'ctx1');
    const fake = agents.created[0] as FakeAgent & { failFollowup?: boolean };
    fake.failFollowup = true;

    const failed = await execute('t1', 'ctx1', 'boom');
    const failedFinal = failed.seen.at(-1) as Extract<
      AgentExecutionEvent,
      { kind: 'status-update' }
    >;
    expect(failed.isFinished()).toBe(true);
    expect(failedFinal.status.state).toBe('failed');
    expect((failedFinal.status.message as Message).parts[0]).toEqual({
      kind: 'text',
      text: 'inbox closed',
    });

    // The stale waiter was spliced out: the next turn settles on its own
    // turn/end instead of inheriting the poisoned FIFO slot.
    fake.failFollowup = false;
    const recovered = await execute('t1', 'ctx1', 'again');
    const final = recovered.seen.at(-1) as Extract<AgentExecutionEvent, { kind: 'status-update' }>;
    expect(final.status.state).toBe('input-required');
    expect(agents.created[0].prompts).toEqual(['hi', 'again']);
  });
});
