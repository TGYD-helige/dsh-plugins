import { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { expect, it, vi } from 'vitest';
import { InboxChanges } from './inbox-changes.js';

it('publishes only after a successful checkpoint and keeps changes arriving during it', async () => {
  const ctx = new Context();
  let release!: (value: boolean) => void;
  const flush = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(true);
  ctx.provide('sessions', { flush } as never);
  const session = { id: 's', seq: 2 } as unknown as Session;
  const changes = new InboxChanges(ctx, () => true);
  const seen: unknown[] = [];
  changes.watch(
    session,
    (change) => seen.push(change),
    () => {},
  );
  const pending = changes.checkpoint(session);
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
  expect(seen).toEqual([]);
  Object.assign(session, { seq: 4 });
  const newer = changes.checkpoint(session);
  release(true);
  await Promise.all([pending, newer]);
  expect(seen).toEqual([
    { contextId: 's', version: 1 },
    { contextId: 's', version: 3 },
  ]);
  changes.close();
  await ctx.fiber.dispose();
});

it('rejects false or failed checkpoints and suppresses late sends after close', async () => {
  const ctx = new Context();
  const flush = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('storage'));
  ctx.provide('sessions', { flush } as never);
  const session = { id: 's', seq: 1 } as unknown as Session;
  const changes = new InboxChanges(ctx, () => true);
  const listener = vi.fn();
  const closed = vi.fn();
  changes.watch(session, listener, closed);
  await expect(changes.checkpoint(session)).rejects.toThrow();
  await expect(changes.checkpoint(session)).rejects.toThrow('storage');
  let release!: (value: boolean) => void;
  flush.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const pending = changes.checkpoint(session);
  await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(3));
  changes.close();
  release(true);
  await expect(pending).rejects.toThrow();
  expect(listener).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
  await ctx.fiber.dispose();
});

it('does not let a slow context block another context or keep detached subscribers', async () => {
  const ctx = new Context();
  let release!: (value: boolean) => void;
  ctx.provide('sessions', {
    flush: (session: Session) =>
      session.id === 'slow'
        ? new Promise<boolean>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(true),
  } as never);
  const changes = new InboxChanges(ctx, () => true);
  const slow = { id: 'slow', seq: 1 } as unknown as Session;
  const fast = { id: 'fast', seq: 3 } as unknown as Session;
  const listener = vi.fn();
  const detach = changes.watch(slow, listener, () => {});
  const pending = changes.checkpoint(slow);
  expect(await changes.checkpoint(fast)).toEqual({ contextId: 'fast', version: 2 });
  detach();
  release(true);
  await pending;
  expect(listener).not.toHaveBeenCalled();
  changes.close();
  await ctx.fiber.dispose();
});
