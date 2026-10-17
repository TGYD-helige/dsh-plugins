import { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-hook-protocol';
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

it('rejects malformed optional tool and result fields without appending', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  const session = ctx.sessions.create();
  session.append('turn/start', { turn: 0 });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const identity = { turn: 0, point: 'AfterTool', handlerId: 'h' };
  try {
    expect(
      appendHookEvent(session, 'hook/invoked', {
        ...identity,
        dialect: 'gemini',
        callId: '',
      }),
    ).toBe(false);
    for (const fields of [{ result: [] }, { stdout: 3 }, { stderr: true }]) {
      expect(
        appendHookEvent(session, 'hook/result', {
          ...identity,
          decision: 'pass',
          durationMs: 1,
          ...fields,
        } as never),
      ).toBe(false);
    }
    expect(session.seq).toBe(1);
    expect(error).toHaveBeenCalledWith('[dsh-langfuse] hook reporting failed:', expect.any(Error));
  } finally {
    error.mockRestore();
    await ctx.fiber.dispose();
  }
});

it('publishes custom hook results after their originating turn closes on DSH 0.2.1', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  const session = ctx.sessions.create();
  const observed: Array<{ type: string; data: unknown }> = [];
  ctx.on('session/event', (_session, event) => observed.push(event));
  const identity = { turn: 0, point: 'BeforeAgent', handlerId: 'custom', invocationId: 'run-1' };
  try {
    session.append('turn/start', { turn: 0 });
    expect(
      appendHookEvent(session, 'hook/invoked', { ...identity, dialect: 'company-validator' }),
    ).toBe(true);
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    expect(
      appendHookEvent(session, 'hook/result', {
        ...identity,
        decision: 'pass',
        outcome: 'cancelled',
        durationMs: 1,
      }),
    ).toBe(true);
    expect(observed.map((event) => event.type)).toEqual([
      'turn/start',
      'hook/invoked',
      'turn/end',
      'hook/result',
    ]);
  } finally {
    await ctx.fiber.dispose();
  }
});
