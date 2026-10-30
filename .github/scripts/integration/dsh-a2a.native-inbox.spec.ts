import { Message, Role, TaskState } from '@a2a-js/sdk';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm/types';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }));

import { A2aBridge } from '../../../packages/dsh-a2a/src/bridge.js';
import { DshAgentExecutor } from '../../../packages/dsh-a2a/src/executor.js';
import { INBOX_EXTENSION, NativeInbox } from '../../../packages/dsh-a2a/src/inbox.js';
import { startA2aServer } from '../../../packages/dsh-a2a/src/server.js';
import { MemoryTaskStore } from '../../../packages/dsh-a2a/src/task-store.js';

const contexts: Context[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  vi.restoreAllMocks();
});

function harness(seed: SessionEvent[] = [], store = new MemoryTaskStore(), retainPending = false) {
  const ctx = new Context();
  contexts.push(ctx);
  const log = structuredClone(seed);
  const nextTurn: UserMessage[] = [];
  const nextStep: UserMessage[] = [];
  const session = {
    id: 'context',
    snapshotEvents: () => log.slice(),
    append(type: string, data: unknown) {
      const event = {
        type,
        data: JSON.parse(JSON.stringify(data)),
        seq: log.length,
        time: Date.now(),
      };
      log.push(event as SessionEvent);
      ctx.emit('session/event', session as never, event as never);
      return event;
    },
  } as unknown as Session;
  const append = (target: string, message: UserMessage) => {
    const items = target === 'next-turn' ? nextTurn : nextStep;
    session.append('agent/inbox/spliced', {
      target,
      start: items.length,
      inserted: [message],
    } as never);
    items.push(message);
    ctx.emit('agent/inbox/inserted', { agent, message });
  };
  let activity: Promise<void> | undefined;
  let aborted = false;
  const consumed: string[] = [];
  const agent = {
    id: 'context',
    session,
    status: 'idle',
    options: {},
    inbox: {
      nextTurn,
      nextStep,
      clear: () => {
        for (const target of ['next-step', 'next-turn']) {
          const items = target === 'next-turn' ? nextTurn : nextStep;
          session.append('agent/inbox/spliced', {
            target,
            start: 0,
            removedCount: items.length,
            inserted: [],
            outcome: 'canceled',
          } as never);
          items.splice(0);
        }
      },
      append,
      prepend(target: string, message: UserMessage) {
        const items = target === 'next-turn' ? nextTurn : nextStep;
        session.append('agent/inbox/spliced', { target, start: 0, inserted: [message] } as never);
        items.unshift(message);
      },
      splice(target: string, start: number, removedCount: number, inserted: UserMessage[]) {
        const items = target === 'next-turn' ? nextTurn : nextStep;
        session.append('agent/inbox/spliced', { target, start, removedCount, inserted } as never);
        items.splice(start, removedCount, ...inserted);
      },
      replace(id: string, message: UserMessage) {
        const items = nextTurn.some((m) => m.id === id) ? nextTurn : nextStep;
        const index = items.findIndex((m) => m.id === id);
        if (index < 0) return false;
        session.append('agent/inbox/spliced', {
          target: items === nextTurn ? 'next-turn' : 'next-step',
          start: index,
          removedCount: 1,
          inserted: [message],
          outcome: 'canceled',
        });
        items[index] = message;
        return true;
      },
      remove(id: string) {
        for (const items of [nextTurn, nextStep]) {
          const index = items.findIndex((m) => m.id === id);
          if (index >= 0) {
            items.splice(index, 1);
            return true;
          }
        }
        return false;
      },
    },
    send: vi.fn((message: UserMessage, target: string, wake: boolean) => {
      append(target, message);
      if (wake) drive();
    }),
    drive: vi.fn(() => {
      if (activity || (!nextTurn.length && !nextStep.length)) return;
      aborted = false;
      agent.status = 'running';
      activity = Promise.resolve()
        .then(async () => {
          let turn = 0;
          while (!aborted && (nextTurn.length || nextStep.length)) {
            turn++;
            session.append('turn/start', { turn });
            const messages: UserMessage[] = [];
            for (const [target, items, count] of [
              ['next-step', nextStep, nextStep.length],
              ['next-turn', nextTurn, Math.min(1, nextTurn.length)],
            ] as const) {
              const removed = items.splice(0, count);
              session.append('agent/inbox/spliced', {
                target,
                start: 0,
                removedCount: count,
                inserted: [],
              });
              messages.push(...removed);
              for (const message of removed)
                ctx.emit('agent/inbox/claimed', { agent, message, turn });
            }
            try {
              await ctx.waterfall(
                'agent/pre-step',
                {
                  agent,
                  messages,
                  turn,
                  step: 1,
                  signal: new AbortController().signal,
                },
                async () => ({ kind: 'enter' as const, messages }),
              );
              if (aborted) break;
              for (const message of messages) {
                consumed.push(message.id);
                session.append(
                  'user/message',
                  message as never,
                  { surfaceOp: { kind: 'append' } } as never,
                );
              }
              session.append('turn/end', { turn, reason: { kind: 'completed' } });
            } catch {
              session.append('turn/end', {
                turn,
                reason: { kind: 'error', error: 'prepare failed' },
              } as never);
            }
          }
        })
        .finally(() => {
          activity = undefined;
          agent.status = 'idle';
        });
    }),
    cancel: vi.fn(() => {
      aborted = true;
    }),
    whenIdle: async () => {
      await activity;
    },
  } as unknown as Agent & { drive(): void; status: string };
  const drive = () => agent.drive();
  for (const event of seed) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const items = event.data.target === 'next-turn' ? nextTurn : nextStep;
    items.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted);
  }
  const handle = {
    agent,
    dispose: vi.fn(async () => {
      await agent.whenIdle();
    }),
  };
  ctx.provide('agents', {
    create: async () => handle,
    resume: async () => handle,
  } as never);
  const bridge = new A2aBridge(ctx, { cwd: '/tmp' });
  const native = new NativeInbox(ctx, bridge, store, retainPending);
  const executor = new DshAgentExecutor(bridge);
  const send = (
    id: string,
    options: { parked?: boolean; taskId?: string; target?: string } = {},
  ) => {
    const context = new ServerCallContext({ requestedExtensions: [INBOX_EXTENSION] } as never);
    const message = Message.fromJSON({
      messageId: id,
      contextId: 'context',
      taskId: options.taskId ?? '',
      role: Role.ROLE_USER,
      parts: [{ text: id }],
      extensions: [INBOX_EXTENSION],
      metadata: {
        [INBOX_EXTENSION]: { wakeup: !options.parked, target: options.target ?? 'next-turn' },
      },
    });
    const bus = new DefaultExecutionEventBus();
    const events: any[] = [];
    bus.on('event', (event) => events.push(event));
    const execution = executor.execute(
      new RequestContext(
        { tenant: '', message, configuration: undefined, metadata: undefined },
        options.taskId ?? `task-${id}`,
        'context',
        context,
      ),
      bus,
    );
    return { execution, events };
  };
  const start = async () => {
    const server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'native', description: '', version: '1' },
      executor,
      taskStore: store,
      extensions: [{ uri: INBOX_EXTENSION, description: '', required: false, params: undefined }],
      beforeMessage: (message, context) => native.beforeMessage(message, context),
    });
    native.server = server;
    cleanups.push(() => server.close());
    cleanups.push(() => bridge.dispose());
    return server;
  };
  return { ctx, native, bridge, store, agent, log, consumed, send, handle, start };
}

describe('native A2A inbox', () => {
  it('recovers every input from an interrupted first claim exactly once', async () => {
    const first = harness([], new MemoryTaskStore(), true);
    const a = first.send('one', { parked: true });
    const b = first.send('two', { parked: true });
    await vi.waitFor(() => expect(first.agent.inbox.nextTurn).toHaveLength(2));
    const ids = first.agent.inbox.nextTurn.map((message) => message.id);
    const seed = [
      ...structuredClone(first.log),
      { type: 'turn/start', seq: first.log.length, time: 1, data: { turn: 1 } },
      {
        type: 'agent/inbox/spliced',
        seq: first.log.length + 1,
        time: 1,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      },
    ] as SessionEvent[];
    await first.native.shutdown();
    await Promise.all([a.execution, b.execution]);
    const restored = harness(seed, first.store, true);
    await restored.start();
    await restored.native.resolve('context');
    expect(restored.agent.inbox.nextTurn.map((message) => message.id)).toEqual(ids);
    restored.agent.drive();
    await restored.agent.whenIdle();
    expect(restored.consumed).toEqual(ids);
  });

  it('steers only the active task at the next step without admitting unrelated work', async () => {
    const f = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hook = vi.fn(({ a2aMessage }: { a2aMessage: Message }) =>
      a2aMessage.messageId === 'one' ? gate : undefined,
    );
    f.ctx.on('a2a/before-step', hook);
    const first = f.send('one');
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
    const steering = f.send('steer', { taskId: 'task-one', target: 'next-step', parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextStep).toHaveLength(1));
    expect(f.agent.inbox.nextStep[0].source).toMatchObject({
      kind: 'a2a',
      taskId: 'task-one',
      target: 'next-step',
    });
    const unrelated = f.send('other', { taskId: 'task-other', target: 'next-step', parked: true });
    try {
      await unrelated.execution;
      expect(unrelated.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(f.agent.inbox.nextStep).toHaveLength(1);
    } finally {
      release();
    }
    await Promise.all([first.execution, steering.execution]);
    const consumed = f.log
      .filter((event) => event.type === 'user/message')
      .map((event) => JSON.parse((event.data.source as any).message).messageId);
    expect(consumed).toEqual(['one', 'steer']);
  });

  it('drains checkpoint-committed admission before completing shutdown', async () => {
    const store = new MemoryTaskStore();
    let checkpointed!: () => void;
    let releaseCheckpoint!: () => void;
    const checkpointStarted = new Promise<void>((resolve) => (checkpointed = resolve));
    const checkpointGate = new Promise<void>((resolve) => (releaseCheckpoint = resolve));
    const save = store.save.bind(store);
    Object.assign(store, {
      checkpoint: async (
        task: Parameters<MemoryTaskStore['save']>[0],
        context: ServerCallContext,
      ) => {
        await save(task, context);
        checkpointed();
        await checkpointGate;
      },
    });
    const f = harness([], store, true);
    const pending = f.send('one', { parked: true });
    await checkpointStarted;
    let completed = false;
    const shutdown = f.native.shutdown().then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(f.agent.send).not.toHaveBeenCalled();
    releaseCheckpoint();
    await Promise.all([pending.execution, shutdown]);
    expect(completed).toBe(true);
    expect(f.agent.send).toHaveBeenCalledOnce();
    expect(f.agent.inbox.nextTurn).toHaveLength(1);

    const restored = harness(structuredClone(f.log), store, true);
    await restored.start();
    await restored.native.resolve('context');
    restored.agent.drive();
    await restored.agent.whenIdle();
    expect(restored.consumed).toHaveLength(1);
  });

  async function abortAtCheckpoint(
    action: 'cancel' | 'clear' | 'dispose' | 'shutdown',
    settleOperationFirst = false,
  ) {
    const store = new MemoryTaskStore();
    let checkpointed!: () => void;
    let releaseCheckpoint!: () => void;
    const checkpointStarted = new Promise<void>((resolve) => (checkpointed = resolve));
    const checkpointGate = new Promise<void>((resolve) => (releaseCheckpoint = resolve));
    const save = store.save.bind(store);
    Object.assign(store, {
      checkpoint: async (
        task: Parameters<MemoryTaskStore['save']>[0],
        context: ServerCallContext,
      ) => {
        await save(task, context);
        checkpointed();
        await checkpointGate;
      },
    });
    const f = harness([], store, action === 'shutdown');
    const pending = f.send('one', { parked: true });
    await checkpointStarted;
    let operation: Promise<unknown>;
    if (action === 'cancel') operation = f.native.cancel('task-one');
    else if (action === 'clear') operation = f.native.clear('context');
    else if (action === 'shutdown') operation = f.native.shutdown();
    else {
      f.ctx.emit('session/disposed', f.agent.session);
      operation = Promise.resolve();
    }
    if (settleOperationFirst) {
      await operation;
      releaseCheckpoint();
      await pending.execution;
    } else {
      releaseCheckpoint();
      await Promise.all([pending.execution, operation]);
    }
    return { f, store };
  }

  it('discards a checkpoint commit when ordinary cancel wins the admission race', async () => {
    const { f, store } = await abortAtCheckpoint('cancel');
    const snapshot = await store.load('task-one', new ServerCallContext());
    expect(snapshot?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(f.agent.send).toHaveBeenCalledOnce();
    expect(f.agent.inbox.nextTurn).toHaveLength(0);
  });

  it('discards a late checkpoint commit after clear has completed', async () => {
    const { f } = await abortAtCheckpoint('clear', true);
    expect(f.agent.send).toHaveBeenCalledOnce();
    expect(f.agent.inbox.nextTurn).toHaveLength(0);
  });

  it('retains a checkpoint commit through disposal', async () => {
    const { f } = await abortAtCheckpoint('dispose');
    expect(f.agent.send).toHaveBeenCalledOnce();
    expect(f.agent.inbox.nextTurn.map((message) => message.id)).toHaveLength(1);
  });

  it('recovers checkpoint-committed input after retain-pending shutdown', async () => {
    const { f, store } = await abortAtCheckpoint('shutdown');
    expect(f.agent.inbox.nextTurn.map((message) => message.id)).toHaveLength(1);
    const snapshot = await store.load('task-one', new ServerCallContext());
    expect(snapshot?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(snapshot?.metadata).toHaveProperty(
      'https://github.com/TGYD-helige/dsh-plugins/blob/main/docs/protocol/inbox-v1.md#retained-inputs',
    );

    const restored = harness(structuredClone(f.log), store, true);
    await restored.start();
    await restored.native.resolve('context');
    expect(restored.agent.inbox.nextTurn.map((message) => message.id)).toHaveLength(1);
    restored.agent.drive();
    await restored.agent.whenIdle();
    expect(restored.consumed).toHaveLength(1);
  });

  it('publishes only committed protocol inputs and keeps internal user messages private', async () => {
    const f = harness();
    const original = f.send('one', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(1));
    const userEvents = () =>
      original.events.filter(
        (event) =>
          event.kind === 'statusUpdate' && event.data.status.message?.role === Role.ROLE_USER,
      );
    expect(userEvents()).toEqual([]);
    f.ctx.on('a2a/before-step', () => {
      for (const kind of ['hook', 'goal', 'runtime-context', 'subagent'])
        f.agent.session.append(
          'user/message',
          {
            id: kind,
            role: 'user',
            source: { kind },
            content: [{ type: 'text', text: 'private model context' }],
          } as never,
          { surfaceOp: 'append' } as never,
        );
    });
    f.agent.drive();
    await original.execution;
    expect(userEvents()).toHaveLength(1);
    expect(userEvents()[0].data.status).toMatchObject({
      state: TaskState.TASK_STATE_WORKING,
      message: { messageId: 'one', taskId: 'task-one', role: Role.ROLE_USER },
    });
    expect(JSON.stringify(original.events)).not.toContain('private model context');
  });

  it('removes owned input when the admission flush fails after send', async () => {
    const f = harness();
    f.ctx.on('session/flush', () => {
      if (f.agent.inbox.nextTurn.length) throw new Error('admission checkpoint failed');
    });
    const request = f.send('one', { parked: true });
    await request.execution;
    expect(request.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(f.agent.inbox.nextTurn).toHaveLength(0);
    expect(f.consumed).toHaveLength(0);
  });

  it('rejects duplicate follow-up admission without terminating the accepted task', async () => {
    const f = harness();
    const original = f.send('one', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(1));
    const duplicate = Message.fromJSON({
      messageId: 'one',
      taskId: 'task-one',
      contextId: 'context',
      role: 'ROLE_USER',
      parts: [{ text: 'one' }],
    });
    await expect(f.native.beforeMessage(duplicate, new ServerCallContext())).rejects.toThrow(
      'already queued',
    );
    expect(f.agent.inbox.nextTurn).toHaveLength(1);
    const trigger = f.send('trigger');
    await trigger.execution;
    await original.execution;
    expect(original.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(f.consumed).toHaveLength(2);
  });

  it('releases admission and execution waiters when clearing a stalled admission', async () => {
    const f = harness();
    const hook = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    );
    f.ctx.on('a2a/before-followup', hook);
    const pending = f.send('one');
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
    await f.bridge.clearContext('context');
    await pending.execution;
    expect(f.consumed).toEqual([]);
  });

  it('admits new input after aborting a hook that never cooperates', async () => {
    const f = harness();
    const hook = vi.fn(({ a2aMessage }: { a2aMessage: Message }) =>
      a2aMessage.messageId === 'one' ? new Promise<void>(() => {}) : undefined,
    );
    f.ctx.on('a2a/before-followup', hook);
    const first = f.send('one');
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce());
    await f.bridge.clearContext('context');
    await first.execution;
    const second = f.send('two');
    await second.execution;
    expect(f.consumed).toHaveLength(1);
  });

  it('does not complete a task while a later turn waits at preparation', async () => {
    const f = harness();
    let settle!: () => void;
    let prepare!: () => void;
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const preparation = new Promise<void>((resolve) => {
      prepare = resolve;
    });
    f.ctx.on('a2a/task-settlement', () => settlement);
    const hook = vi.fn(async ({ a2aMessage }: { a2aMessage: Message }) => {
      if (a2aMessage.messageId === 'two') await preparation;
    });
    f.ctx.on('a2a/before-step', hook);
    const first = f.send('one');
    await vi.waitFor(() => expect(f.consumed).toHaveLength(1));
    await f.agent.whenIdle();
    const second = f.send('two', { taskId: 'task-one' });
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(2));
    settle();
    await Promise.resolve();
    expect(
      first.events.some(
        (event) =>
          event.kind === 'statusUpdate' &&
          event.data.status.state === TaskState.TASK_STATE_COMPLETED,
      ),
    ).toBe(false);
    prepare();
    await Promise.all([first.execution, second.execution]);
    expect(f.consumed).toHaveLength(2);
  });

  it('releases a parked execution on external session disposal', async () => {
    const f = harness();
    const pending = f.send('one', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(1));
    f.ctx.emit('session/disposed', f.agent.session);
    await pending.execution;
    expect(pending.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it('finishes waiters and agent cleanup even when shutdown flush fails', async () => {
    const f = harness();
    const pending = f.send('one', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(1));
    f.ctx.on('session/flush', () => {
      throw new Error('disk unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(f.native.shutdown()).rejects.toThrow('shutdown failed');
    await pending.execution;
    await f.bridge.dispose();
    expect(f.handle.dispose).toHaveBeenCalled();
  });

  it('parks standard messages until a real waking send drains the official queue', async () => {
    const f = harness();
    const first = f.send('one', { parked: true });
    const second = f.send('two', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(2));
    expect(f.consumed).toEqual([]);
    const trigger = f.send('trigger');
    await trigger.execution;
    await Promise.all([first.execution, second.execution]);
    expect(f.consumed).toHaveLength(3);
    expect(new Set(f.consumed).size).toBe(3);
    for (const [taskId, request] of [
      ['task-one', first],
      ['task-two', second],
    ] as const) {
      expect(
        request.events.filter((event) => event.kind === 'statusUpdate').at(-1).data.status.state,
      ).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(
        request.events.every(
          (event) => (event.kind === 'task' ? event.data.id : event.data.taskId) === taskId,
        ),
      ).toBe(true);
    }
  });

  it('prepares each selected input after earlier work and isolates admission observer failures', async () => {
    const f = harness();
    const prepared: string[] = [];
    f.ctx.on('a2a/before-step', ({ a2aMessage }) => {
      prepared.push(a2aMessage.messageId);
    });
    f.ctx.on('a2a/message-admitted', () => {
      throw new Error('observer unavailable');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = f.send('one', { parked: true });
    const second = f.send('two', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(2));
    expect(prepared).toEqual([]);
    const trigger = f.send('trigger');
    await trigger.execution;
    await Promise.all([first.execution, second.execution]);
    expect(prepared).toEqual(['one', 'two', 'trigger']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[dsh-a2a]'), expect.any(Error));
  });

  it('clears pending input even when the agent is idle', async () => {
    const f = harness();
    const queued = f.send('one', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(1));
    await f.native.clear('context');
    await queued.execution;
    expect(f.agent.inbox.nextTurn).toHaveLength(0);
  });
});
