import { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, expect, it, vi } from 'vitest';
import { httpNotificationSender, installNotifications } from './notifications.js';

const contexts: Context[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function harness(options: Parameters<typeof installNotifications>[1] = {}) {
  const ctx = new Context();
  contexts.push(ctx);
  const flush = vi.fn(async (_session: Session) => true);
  Object.assign(ctx, { sessions: { flush } });
  installNotifications(ctx, options);
  const session = { id: 's' } as Session;
  const event = (type: string, seq = 1, id = 'native', target = session) =>
    ctx.emit('session/event', target, {
      type,
      seq,
      data: { id, source: { kind: 'user' } },
    } as SessionEvent);
  const admitted = () =>
    ctx.emit('a2a/message-admitted', {
      contextId: 's',
      taskId: 'original',
      a2aMessageId: 'protocol',
      dshMessageId: 'native',
      requestHeaders: { identity: 'owner' },
    });
  const selected = () =>
    ctx.emit('a2a/inbox', {
      phase: 'selected',
      contextId: 's',
      taskId: 'selected',
      messageId: 'protocol',
      nativeMessageId: 'native',
      at: 0,
      pending: 0,
    });
  return { ctx, session, flush, event, admitted, selected };
}
it.each([false, true])(
  'waits for history and correlates selected input (restored=%s)',
  async (restored) => {
    const send = vi.fn(async () => true);
    const f = harness({ message: send });
    let release!: (ok: boolean) => void;
    f.flush.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    if (!restored) f.admitted();
    f.selected();
    f.event('user/message', 1, 'native', { id: 'other' } as Session);
    f.event('user/message');
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
    expect(send).not.toHaveBeenCalled();
    release(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0]).toEqual([
      expect.objectContaining({
        contextId: 's',
        messageId: 'protocol',
        taskId: 'selected',
        requestHeaders: restored ? undefined : { identity: 'owner' },
      }),
      expect.any(AbortSignal),
    ]);
    f.selected();
    f.admitted();
    f.event('user/message');
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
  },
);
it.each(['false', 'reject', 'dispose'])('does not deliver after checkpoint %s', async (mode) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const send = vi.fn(async () => true);
  const f = harness({ message: send });
  let release!: (ok: boolean) => void;
  f.flush.mockImplementation(() =>
    mode === 'reject'
      ? Promise.reject(new Error('offline'))
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  f.admitted();
  f.event('user/message');
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
  if (mode === 'dispose') await f.ctx.fiber.dispose();
  if (mode !== 'reject') release(mode === 'dispose');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(send).not.toHaveBeenCalled();
});
it('coalesces synchronous native changes and isolates contexts', async () => {
  const send = vi.fn(async ({ contextId }: { contextId: string }) =>
    contextId === 's' ? new Promise<boolean>(() => {}) : true,
  );
  const f = harness({ inbox: send });
  f.event('agent/inbox/spliced', 1);
  f.event('agent/inbox/spliced', 2);
  f.event('agent/inbox/spliced', 9, '', { id: 'b' } as Session);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls.map(([value]) => value)).toEqual([
    { contextId: 's', version: 2 },
    { contextId: 'b', version: 9 },
  ]);
});
it('gives a newer version its own retry budget after exhaustion', async () => {
  const versions: number[] = [];
  let release!: (ok: boolean) => void;
  const send = vi.fn(async ({ version }: { version: number }) => {
    versions.push(version);
    if (versions.length === 3)
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    return false;
  });
  const f = harness({ inbox: send });
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3), { timeout: 1500 });
  f.event('agent/inbox/spliced', 2);
  release(false);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(6), { timeout: 1500 });
  expect(versions).toEqual([1, 1, 1, 2, 2, 2]);
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(send).toHaveBeenCalledTimes(6);
});
it('aborts delivery and retry waits on unload; reload has one listener', async () => {
  let signal!: AbortSignal;
  const send = vi.fn(async (_: unknown, value: AbortSignal) => {
    signal = value;
    return false;
  });
  const f = harness({ inbox: send });
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  await f.ctx.fiber.dispose();
  expect(signal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(send).toHaveBeenCalledOnce();
});
it('is opt-in and cleans HTTP response bodies with explicit failure outcomes', async () => {
  const f = harness();
  f.admitted();
  f.event('user/message');
  f.event('agent/inbox/spliced');
  expect(f.flush).not.toHaveBeenCalled();
  const cancel = vi.fn(async () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, body: { cancel } })),
  );
  const send = httpNotificationSender(() => ({
    url: 'http://example.test',
    body: { hello: true },
    headers: { identity: 'selected' },
  }));
  expect(await send({}, new AbortController().signal)).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});

it('retains a newer invalidation after an older success or third failure', async () => {
  for (const exhausted of [false, true]) {
    const versions: number[] = [];
    let release!: (ok: boolean) => void;
    const f = harness({
      inbox: async ({ version }) => {
        versions.push(version);
        if (version === 2) return true;
        if (!exhausted || versions.length === 3)
          return new Promise((resolve) => {
            release = resolve;
          });
        return false;
      },
    });
    f.event('agent/inbox/spliced');
    await vi.waitFor(() => expect(versions).toHaveLength(exhausted ? 3 : 1), { timeout: 1500 });
    f.event('agent/inbox/spliced', 2);
    release(!exhausted);
    await vi.waitFor(() => expect(versions.at(-1)).toBe(2));
    expect(versions).toEqual(exhausted ? [1, 1, 1, 2] : [1, 2]);
  }
});
it('drops discarded input and cancels a disposed context during checkpoint', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ message: send, inbox: send });
  f.admitted();
  f.ctx.emit('agent/inbox/discarded', {
    agent: { session: f.session },
    message: { id: 'native' },
  } as never);
  f.event('user/message');
  expect(f.flush).not.toHaveBeenCalled();
  let release!: (ok: boolean) => void;
  f.flush.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
  f.ctx.emit('session/disposed', f.session);
  release(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(send).not.toHaveBeenCalled();
});
it('unregisters listeners on fiber unload and allows clean reinstall', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('sessions', { flush: async () => true } as never);
  const send = vi.fn(async () => true);
  const plugin = (child: Context) => installNotifications(child, { inbox: send });
  const first = ctx.plugin(plugin);
  await first.await();
  await first.dispose();
  await ctx.plugin(plugin).await();
  ctx.emit(
    'session/event',
    { id: 's' } as Session,
    { type: 'agent/inbox/spliced', seq: 1 } as SessionEvent,
  );
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
});
it('lets a recreated context progress while its old checkpoint is unresolved', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ inbox: send });
  let release!: (ok: boolean) => void;
  f.flush.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
  f.ctx.emit('session/disposed', f.session);
  f.event('agent/inbox/spliced', 2);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  release(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(send).toHaveBeenCalledOnce();
});
it('keeps selected task identity when admission observation arrives later', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ message: send });
  f.selected();
  f.admitted();
  f.event('user/message');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]).toEqual([
    expect.objectContaining({ taskId: 'selected', requestHeaders: { identity: 'owner' } }),
    expect.any(AbortSignal),
  ]);
});
it('preserves admission identity arriving while the committed-message checkpoint is pending', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ message: send });
  let release!: (ok: boolean) => void;
  f.flush.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.selected();
  f.event('user/message');
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
  f.admitted();
  release(true);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]).toEqual([
    expect.objectContaining({ taskId: 'selected', requestHeaders: { identity: 'owner' } }),
    expect.any(AbortSignal),
  ]);
});
it('contains sender failures without rejecting admission or the session append', async () => {
  const failure = new Error('transport unavailable');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = harness({
    message: async () => {
      throw failure;
    },
  });
  expect(() => f.admitted()).not.toThrow();
  expect(() => f.event('user/message')).not.toThrow();
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith('[dsh-a2a] notification failed:', failure),
  );
});

it('bounds slow delivery work and lets another context progress', async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const f = harness({
    message: async ({ contextId }) => {
      seen.push(contextId);
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return true;
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (let i = 0; i < 200; i++) {
    f.ctx.emit('a2a/message-admitted', {
      contextId: 's',
      taskId: 't',
      a2aMessageId: String(i),
      dshMessageId: String(i),
      requestHeaders: undefined,
    });
    f.event('user/message', i, String(i));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(peak).toBe(1);
  expect(f.flush).toHaveBeenCalledTimes(1);
  f.ctx.emit('a2a/message-admitted', {
    contextId: 'b',
    taskId: 't',
    a2aMessageId: 'b',
    dshMessageId: 'b',
    requestHeaders: undefined,
  });
  f.event('user/message', 0, 'b', { id: 'b' } as Session);
  await vi.waitFor(() => expect(seen).toContain('b'));
  await f.ctx.fiber.dispose();
  for (const release of releases) release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.flush).toHaveBeenCalledTimes(2);
});

it('releases capacity for new contexts when many disposed checkpoints never resolve', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ inbox: send });
  f.flush.mockImplementation(async (session) =>
    session.id === 'fresh' ? true : new Promise<boolean>(() => {}),
  );
  for (let i = 0; i < 20; i++) {
    const session = { id: `disposed-${i}` } as Session;
    f.event('agent/inbox/spliced', 0, '', session);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.ctx.emit('session/disposed', session);
  }
  f.event('agent/inbox/spliced', 0, '', { id: 'fresh' } as Session);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]).toEqual([{ contextId: 'fresh', version: 0 }, expect.any(AbortSignal)]);
});

it('caps global sender concurrency and pending work under a slow endpoint', async () => {
  let started = 0;
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const f = harness({
    message: async () => {
      started++;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return true;
    },
  });
  for (let i = 0; i < 200; i++) {
    const contextId = `context-${i}`;
    f.ctx.emit('a2a/message-admitted', {
      contextId,
      taskId: 't',
      a2aMessageId: 'm',
      dshMessageId: 'm',
      requestHeaders: undefined,
    });
    f.event('user/message', 0, 'm', { id: contextId } as Session);
  }
  await vi.waitFor(() => expect(started).toBe(16));
  while (releases.length) {
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(peak).toBe(16);
  expect(started).toBe(144);
  expect(f.flush).toHaveBeenCalledTimes(144);
});
it('suppresses replayed older events without retaining every delivered message id', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ message: send });
  f.admitted();
  f.event('user/message', 0);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  f.ctx.emit('a2a/message-admitted', {
    contextId: 's',
    taskId: 't',
    a2aMessageId: 'new',
    dshMessageId: 'new',
    requestHeaders: undefined,
  });
  f.event('user/message', 100, 'new');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  f.selected();
  f.admitted();
  f.event('user/message', 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(send).toHaveBeenCalledTimes(2);
});
it('bounds stale correlations and restores an evicted native selection', async () => {
  const send = vi.fn(async () => true);
  const f = harness({ message: send });
  f.admitted();
  for (let i = 0; i < 300; i++)
    f.ctx.emit('a2a/message-admitted', {
      contextId: 's',
      taskId: 't',
      a2aMessageId: String(i),
      dshMessageId: String(i),
      requestHeaders: undefined,
    });
  f.event('user/message', 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(send).not.toHaveBeenCalled();
  f.selected();
  f.event('user/message', 1);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]).toEqual([
    expect.objectContaining({ messageId: 'protocol', taskId: 'selected' }),
    expect.any(AbortSignal),
  ]);
});

it('lets an inbox destination progress while the same context chat destination is blocked', async () => {
  let release!: () => void;
  const inbox = vi.fn(async () => true);
  const f = harness({
    message: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    },
    inbox,
  });
  f.admitted();
  f.event('user/message', 0);
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
  try {
    f.event('agent/inbox/spliced', 1);
    await vi.waitFor(() => expect(inbox).toHaveBeenCalledOnce());
  } finally {
    release();
  }
});
