import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { expect, it, vi } from 'vitest';
import { appendHookEvent, type HookInvoked } from './hooks.js';

it('appends custom dialect records through the real session publication seam', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  const observed: Array<{ type: string; data: unknown }> = [];
  ctx.on('session/event', (_session, event) => observed.push(event));
  const session = ctx.sessions.create();
  const invoked: HookInvoked = {
    turn: 0,
    point: 'BeforeAgent',
    dialect: 'company-validator',
    handlerId: 'validator',
    invocationId: 'run-1',
    name: 'Validate request',
  };
  expect(appendHookEvent(session, 'hook/invoked', invoked)).toBe(true);
  expect(
    appendHookEvent(session, 'hook/result', {
      turn: 0,
      point: 'BeforeAgent',
      handlerId: 'validator',
      invocationId: 'run-1',
      decision: 'pass',
      outcome: 'success',
      exitCode: 0,
      durationMs: 3,
    }),
  ).toBe(true);
  expect(observed).toMatchObject([
    { type: 'hook/invoked', data: invoked },
    { type: 'hook/result', data: { invocationId: 'run-1', outcome: 'success', durationMs: 3 } },
  ]);
  expect(session.surface.nodes).toHaveLength(0);
  await ctx.fiber.dispose();
});

it('rejects unsupported event names from JavaScript callers', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  const observed: unknown[] = [];
  ctx.on('session/event', (_session, event) => observed.push(event));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(
      Reflect.apply(appendHookEvent, undefined, [
        ctx.sessions.create(),
        'unrelated/event',
        {
          turn: 0,
          point: 'BeforeAgent',
          handlerId: 'h',
          decision: 'pass',
          durationMs: 1,
        },
      ]),
    ).toBe(false);
    expect(observed).toHaveLength(0);
  } finally {
    error.mockRestore();
    await ctx.fiber.dispose();
  }
});

it('contains invalid data and session append failures without changing producer data', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  const session = ctx.sessions.create();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const invoked = { turn: 0, point: 'BeforeAgent', dialect: 'gemini', handlerId: 'hook' };
  try {
    expect(appendHookEvent(session, 'hook/invoked', { ...invoked, turn: -1 })).toBe(false);
    vi.spyOn(session, 'append').mockImplementation(() => {
      throw new Error('append unavailable');
    });
    expect(appendHookEvent(session, 'hook/invoked', invoked)).toBe(false);
    expect(error).toHaveBeenCalledWith('[dsh-langfuse] hook reporting failed:', expect.any(Error));
    expect(invoked).toEqual({
      turn: 0,
      point: 'BeforeAgent',
      dialect: 'gemini',
      handlerId: 'hook',
    });
  } finally {
    error.mockRestore();
    await ctx.fiber.dispose();
  }
});
