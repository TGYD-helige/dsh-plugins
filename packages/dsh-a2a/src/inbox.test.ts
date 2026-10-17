import { Message, Role, TaskState } from '@a2a-js/sdk';
import { DefaultExecutionEventBus, RequestContext, ServerCallContext } from '@a2a-js/sdk/server';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm/types';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }));

import { A2aBridge } from './bridge.js';
import { DshAgentExecutor } from './executor.js';
import { INBOX_EXTENSION, NativeInbox, recoverInbox } from './inbox.js';
import { startA2aServer } from './server.js';
import { MemoryTaskStore } from './task-store.js';

const contexts: Context[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  vi.restoreAllMocks();
});

function harness(seed: SessionEvent[] = [], store = new MemoryTaskStore()) {
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
      setPaused(paused: boolean) {
        session.append('agent/inbox/paused', { paused });
      },
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
      if (wake) agent.wake();
    }),
    wake: vi.fn(() => {
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
            }
            try {
              await ctx.serial('agent/before-assembly', {
                agent,
                messages,
                turn,
                step: 1,
                signal: new AbortController().signal,
              });
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
  } as unknown as Agent & { wake(): void; status: string };
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
    nativeInboxVersion: 1,
    create: async () => handle,
    resume: async () => handle,
  } as never);
  const bridge = new A2aBridge(ctx, { cwd: '/tmp' });
  const native = new NativeInbox(ctx, bridge, store);
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
  it('recovers an interrupted first claim ahead of later queued work', async () => {
    const first = harness();
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
    const restored = harness(seed, first.store);
    await restored.native.resolve('context');
    expect(restored.agent.inbox.nextTurn.map((message) => message.id)).toEqual(ids);
    const server = await restored.start();
    expect(server.port).toBeGreaterThan(0);
    await restored.native.wake('context');
    await restored.agent.whenIdle();
    expect(restored.consumed).toEqual(ids);
    expect(recoverInbox(restored.log).pending).toEqual([]);
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
    await f.native.wake('context');
    await original.execution;
    expect(original.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(f.consumed).toHaveLength(1);
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
    await f.native.pause('context');
    await first.execution;
    await f.native.wake('context', { resume: true });
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
    f.ctx.on('a2a/before-assembly', hook);
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
    expect(pending.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_SUBMITTED);
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

  it('retains canceled input while paused and gives it a new task on explicit resume', async () => {
    const f = harness();
    await f.start();
    const pending = f.send('one', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(1));
    await f.native.cancel('task-one', { retainInbox: true });
    await pending.execution;
    expect(pending.events.at(-1).data.status.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(await f.native.wake('context')).toEqual([]);
    const ids = await f.native.wake('context', { resume: true });
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe('task-one');
    await f.agent.whenIdle();
    expect(f.consumed).toHaveLength(1);
  });
  it('parks two standard messages durably, then wakes them once in FIFO task order', async () => {
    const f = harness();
    const first = f.send('one', { parked: true });
    const second = f.send('two', { parked: true });
    await vi.waitFor(() => expect(f.agent.inbox.nextTurn).toHaveLength(2));
    expect(f.consumed).toEqual([]);
    await f.native.wake('context');
    await Promise.all([first.execution, second.execution]);
    expect(f.consumed).toHaveLength(2);
    expect(new Set(f.consumed).size).toBe(2);
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
    f.ctx.on('a2a/before-assembly', ({ a2aMessage }) => {
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
    await f.native.wake('context');
    await Promise.all([first.execution, second.execution]);
    expect(prepared).toEqual(['one', 'two']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[dsh-a2a]'), expect.any(Error));
  });

  it('restores pause intent and refuses to wake until explicitly resumed', async () => {
    const first = harness();
    const queued = first.send('one', { parked: true });
    await vi.waitFor(() => expect(first.agent.inbox.nextTurn).toHaveLength(1));
    await first.native.pause('context');
    const seed = structuredClone(first.log);
    await first.native.shutdown();
    await queued.execution;
    const restored = harness(seed);
    await restored.native.resolve('context');
    await expect(restored.native.wake('context')).resolves.toEqual([]);
    expect(restored.agent.wake).not.toHaveBeenCalled();
    await restored.native.shutdown();
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
