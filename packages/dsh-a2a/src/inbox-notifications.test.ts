import { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { afterEach, expect, it, vi } from 'vitest';
import { httpInboxNotificationSender, installInboxNotifications } from './inbox-notifications.js';

const contexts: Context[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('only sends checkpointed native inbox invalidations, leaving messages to A2A', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  let finish!: (ok: boolean) => void;
  const flush = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  ctx.provide('sessions', { flush } as never);
  const send = vi.fn(async () => true);
  installInboxNotifications(ctx, send);
  const session = { id: 'context' } as Session;
  ctx.emit('session/event', session, {
    type: 'user/message',
    seq: 1,
    data: { id: 'native' },
  } as SessionEvent);
  ctx.emit('a2a/message-admitted', {
    contextId: 'context',
    taskId: 'task',
    a2aMessageId: 'message',
    dshMessageId: 'native',
    requestHeaders: {},
  });
  await Promise.resolve();
  expect(flush).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  ctx.emit('session/event', session, { type: 'agent/inbox/spliced', seq: 2 } as SessionEvent);
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
  expect(send).not.toHaveBeenCalled();
  finish(true);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]).toEqual([
    { contextId: 'context', version: 2 },
    expect.any(AbortSignal),
  ]);
});

function harness(send?: Parameters<typeof installInboxNotifications>[1]) {
  const ctx = new Context();
  contexts.push(ctx);
  const flush = vi.fn(async (_session: Session) => true);
  ctx.provide('sessions', { flush } as never);
  installInboxNotifications(ctx, send);
  const session = { id: 's' } as Session;
  const event = (type: string, seq = 1, _id = '', target = session) =>
    ctx.emit('session/event', target, { type, seq } as SessionEvent);
  return { ctx, session, flush, event };
}

it('coalesces synchronous native changes and isolates contexts', async () => {
  const send = vi.fn(async ({ contextId }: { contextId: string }) =>
    contextId === 's' ? new Promise<boolean>(() => {}) : true,
  );
  const f = harness(send);
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
  const f = harness(send);
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
  const f = harness(send);
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  await f.ctx.fiber.dispose();
  expect(signal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(send).toHaveBeenCalledOnce();
});
it('retains a newer invalidation after an older success or third failure', async () => {
  for (const exhausted of [false, true]) {
    const versions: number[] = [];
    let release!: (ok: boolean) => void;
    const f = harness(async ({ version }) => {
      versions.push(version);
      if (version === 2) return true;
      if (!exhausted || versions.length === 3)
        return new Promise((resolve) => {
          release = resolve;
        });
      return false;
    });
    f.event('agent/inbox/spliced');
    await vi.waitFor(() => expect(versions).toHaveLength(exhausted ? 3 : 1), { timeout: 1500 });
    f.event('agent/inbox/spliced', 2);
    release(!exhausted);
    await vi.waitFor(() => expect(versions.at(-1)).toBe(2));
    expect(versions).toEqual(exhausted ? [1, 1, 1, 2] : [1, 2]);
  }
});
it('unregisters listeners on fiber unload and allows clean reinstall', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('sessions', { flush: async () => true } as never);
  const send = vi.fn(async () => true);
  const plugin = (child: Context) => installInboxNotifications(child, send);
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
  const f = harness(send);
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
it('releases capacity for new contexts when many disposed checkpoints never resolve', async () => {
  const send = vi.fn(async () => true);
  const f = harness(send);
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

it.each([false, 'reject'] as const)(
  'never delivers after a failed checkpoint (%s)',
  async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => true);
    const f = harness(send);
    f.flush.mockImplementation(async () => {
      if (outcome === 'reject') throw new Error('unavailable');
      return false;
    });
    f.event('agent/inbox/spliced');
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledTimes(3), { timeout: 1500 });
    expect(send).not.toHaveBeenCalled();
  },
);
it('unloads while checkpointing without sending on late completion', async () => {
  const send = vi.fn(async () => true);
  const f = harness(send);
  let finish!: (ok: boolean) => void;
  f.flush.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce());
  await f.ctx.fiber.dispose();
  finish(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(send).not.toHaveBeenCalled();
});
it('does not install any notification listeners by default', () => {
  const ctx = new Context();
  contexts.push(ctx);
  const on = vi.spyOn(ctx, 'on');
  installInboxNotifications(ctx);
  expect(on).not.toHaveBeenCalled();
});
it('reports sender errors without throwing into the session append', async () => {
  const failure = new Error('transport unavailable');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = harness(async () => {
    throw failure;
  });
  expect(() => f.event('agent/inbox/spliced')).not.toThrow();
  await vi.waitFor(() =>
    expect(error).toHaveBeenCalledWith('[dsh-a2a] inbox notification failed:', failure),
  );
});
it('bounds active work and pending contexts and keeps the latest admitted version', async () => {
  const calls: Array<{ contextId: string; version: number }> = [];
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const f = harness(async (detail) => {
    calls.push(detail);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return true;
  });
  for (let i = 0; i < 200; i++) f.event('agent/inbox/spliced', 1, '', { id: String(i) } as Session);
  f.event('agent/inbox/spliced', 2, '', { id: '127' } as Session);
  await vi.waitFor(() => expect(calls).toHaveLength(16));
  while (releases.length) {
    for (const finish of releases.splice(0)) finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(peak).toBe(16);
  expect(calls).toHaveLength(128);
  expect(calls).toContainEqual({ contextId: '127', version: 2 });
});
it('does not starve waiting contexts when active contexts keep changing', async () => {
  const calls: string[] = [];
  const releases: Array<() => void> = [];
  const f = harness(async ({ contextId, version }) => {
    calls.push(contextId);
    if (version === 0) {
      await new Promise<void>((resolve) => releases.push(resolve));
      f.event('agent/inbox/spliced', 1, '', { id: contextId } as Session);
    }
    return true;
  });
  for (let i = 0; i < 16; i++) f.event('agent/inbox/spliced', 0, '', { id: String(i) } as Session);
  await vi.waitFor(() => expect(calls).toHaveLength(16));
  f.event('agent/inbox/spliced', 1, '', { id: 'waiting' } as Session);
  for (const finish of releases.splice(0)) finish();
  await vi.waitFor(() => expect(calls).toContain('waiting'));
  expect(calls.indexOf('waiting')).toBe(16);
});
it('cleans HTTP response bodies and returns observable failure with explicit host headers', async () => {
  const cancel = vi.fn(async () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, body: { cancel } })),
  );
  const send = httpInboxNotificationSender((detail) => ({
    url: 'http://example.test/inbox',
    body: detail,
    headers: { 'x-fixture-owner': 'owner' },
  }));
  expect(await send({ contextId: 's', version: 1 }, new AbortController().signal)).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    'http://example.test/inbox',
    expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-owner': 'owner' },
      signal: expect.any(AbortSignal),
    }),
  );
});

it('aborts a pending HTTP delivery when its plugin is unloaded', async () => {
  let signal!: AbortSignal;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ),
  );
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = harness(
    httpInboxNotificationSender((detail) => ({ url: 'http://example.test/inbox', body: detail })),
  );
  f.event('agent/inbox/spliced');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await f.ctx.fiber.dispose();
  expect(signal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(error).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
});
it('makes the HTTP five-second timeout abort pending delivery with an observable failure', async () => {
  const timeout = new AbortController();
  const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    ),
  );
  const send = httpInboxNotificationSender((detail) => ({
    url: 'http://example.test/inbox',
    body: detail,
  }));
  const delivery = send({ contextId: 's', version: 1 }, new AbortController().signal);
  expect(deadline).toHaveBeenCalledWith(5000);
  const failure = new DOMException('Timeout', 'TimeoutError');
  timeout.abort(failure);
  await expect(delivery).rejects.toBe(failure);
});
