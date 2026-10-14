import { Context } from '@deepseek-ai/cordis';
import * as HookProtocolInvariant from '@deepseek-ai/dsh-hook-protocol/invariant';
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants';
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

it('respects the installed upstream hook invariant and contains rejected telemetry', async () => {
  const ctx = new Context();
  new SessionStore(ctx);
  new InvariantRegistry(ctx);
  await ctx.plugin(HookProtocolInvariant);
  const session = ctx.sessions.create();
  const observed: Array<{ type: string; data: unknown }> = [];
  ctx.on('session/event', (_session, event) => observed.push(event));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const identity = {
    turn: 0,
    point: 'BeforeAgent',
    handlerId: 'validator',
    invocationId: 'custom',
  };
  try {
    session.append('turn/start', { turn: 0 });
    for (const dialect of ['gemini', 'company-validator']) {
      expect(appendHookEvent(session, 'hook/invoked', { ...identity, dialect })).toBe(false);
      expect(error).toHaveBeenLastCalledWith(
        '[dsh-langfuse] hook reporting failed:',
        expect.objectContaining({
          packageName: '@deepseek-ai/dsh-hook-protocol',
          message: expect.stringContaining('unknown dialect'),
        }),
      );
    }
    for (const dialect of ['claude-code', 'codex']) {
      const run = { ...identity, invocationId: dialect };
      expect(appendHookEvent(session, 'hook/invoked', { ...run, dialect })).toBe(true);
      expect(
        appendHookEvent(session, 'hook/result', {
          ...run,
          decision: 'pass',
          outcome: 'success',
          exitCode: 0,
          durationMs: 1,
        }),
      ).toBe(true);
    }
    expect(appendHookEvent(session, 'hook/invoked', { ...identity, dialect: 'codex' })).toBe(true);
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    const late = { ...identity, decision: 'pass', outcome: 'cancelled' as const, durationMs: 1 };
    expect(appendHookEvent(session, 'hook/result', late)).toBe(false);
    expect(error.mock.calls.at(-1)?.[1]).toBeInstanceOf(InvariantError);
    expect(error.mock.calls.at(-1)?.[1]).toMatchObject({
      message: expect.stringContaining('outside any open turn'),
    });
    expect(appendHookEvent(session, 'hook/invoked', { ...identity, dialect: 'codex' })).toBe(false);
    session.append('turn/start', { turn: 1 });
    expect(appendHookEvent(session, 'hook/result', late)).toBe(false);
    expect(error.mock.calls.at(-1)?.[1]).toMatchObject({
      message: expect.stringContaining('open turn is 1'),
    });
    expect(observed.filter((event) => event.type === 'hook/invoked')).toHaveLength(3);
    expect(observed.filter((event) => event.type === 'hook/result')).toHaveLength(2);
    expect(session.seq).toBe(8); // Three turn records and five accepted hook records only.
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
