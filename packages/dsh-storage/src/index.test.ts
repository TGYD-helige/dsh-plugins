import { Context } from '@deepseek-ai/cordis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name } from './index.js';

const backends = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('./backends/database.js', () => ({
  DatabaseBackend: class {
    readonly name = 'database';
    init = vi.fn(async () => {});
    upsertMessage = vi.fn(async () => {});
    upsertSession = vi.fn(async () => {});
    close = vi.fn(async () => {});
    constructor(public config: unknown) {
      backends.instances.push(this);
    }
  },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const enabledConfig = {
  enabled: true,
  database: { enabled: true, provider: 'mysql' as const, url: 'mysql://u:p@localhost/db' },
};

function hookNames(ctx: Context): string[] {
  return Object.keys((ctx.events as any)._hooks);
}

/** Catalog-shaped event envelope: { type, seq, time, data }. */
let seq = 0;
function ev(type: string, data: unknown, time = 1700000000000) {
  return { type, seq: ++seq, time, data };
}

const userEvent = (text: string, id = 'm1', time?: number) =>
  ev(
    'user/message',
    { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    time,
  );

const assistantEvent = (text: string, usage?: unknown, id = 'a1', time?: number) =>
  ev(
    'assistant/message',
    {
      turn: 0,
      step: 0,
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      usage,
    },
    time,
  );

describe('dsh-storage plugin', () => {
  let ctx: Context;

  beforeEach(() => {
    backends.instances.length = 0;
    seq = 0;
    ctx = new Context();
  });

  it('exposes the plugin name and no hard injects', () => {
    expect(name).toBe('dsh-storage');
    expect(inject).toEqual([]);
  });

  it('registers no listeners when disabled', () => {
    const before = hookNames(ctx);
    apply(ctx, { enabled: false, database: { enabled: true, provider: 'sqlite', url: 'x' } });
    expect(hookNames(ctx)).toEqual(before);
    expect(backends.instances).toHaveLength(0);
  });

  it('registers no listeners without a database url', () => {
    const before = hookNames(ctx);
    apply(ctx, { enabled: true, database: { enabled: true, provider: 'sqlite', url: '' } });
    expect(hookNames(ctx)).toEqual(before);
    expect(backends.instances).toHaveLength(0);
  });

  it('wires the event tap and initializes the backend at load', async () => {
    apply(ctx, enabledConfig);
    expect(hookNames(ctx)).toEqual(
      expect.arrayContaining(['session/event', 'session/disposed', 'session/flush']),
    );
    const backend = backends.instances[0];
    expect(backend.config).toEqual({ provider: 'mysql', url: enabledConfig.database.url });

    // No 'ready' event in this cordis fork — init starts at plugin load.
    await flush();
    expect(backend.init).toHaveBeenCalledTimes(1);
  });

  it('mirrors user/assistant events into message and session rows', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    ctx.events.emit('session/event', session, userEvent('hi', 'm1', 1700000000000));
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('hello', { inputTokens: 10, outputTokens: 5 }, 'a1', 1700000001000),
    );
    await flush();

    expect(backend.upsertMessage).toHaveBeenCalledTimes(2);
    expect(backend.upsertMessage.mock.calls[0][0]).toMatchObject({
      id: 'm1',
      sessionId: 's1',
      type: 'user',
      content: 'hi',
    });
    expect(backend.upsertMessage.mock.calls[1][0]).toMatchObject({
      id: 'a1',
      type: 'model',
      content: 'hello',
      model: 'deepseek-chat',
    });

    const lastSession = backend.upsertSession.mock.calls.at(-1)?.[0];
    expect(lastSession).toMatchObject({
      sessionId: 's1',
      messageCount: 2,
      totalTokens: 15,
      firstMessageAt: new Date(1700000000000),
      lastMessageAt: new Date(1700000001000),
    });
  });

  it('ignores log-only events; turn/end only checkpoints the rollup', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    ctx.events.emit(
      'session/event',
      session,
      ev('assistant/chunk', { turn: 0, step: 0, chunk: {} }),
    );
    await flush();
    expect(backend.upsertMessage).not.toHaveBeenCalled();
    expect(backend.upsertSession).not.toHaveBeenCalled();

    // turn/end carries no usage — tokens accumulate from assistant/message.
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('hi', { inputTokens: 100, outputTokens: 20 }),
    );
    ctx.events.emit('session/event', session, ev('turn/end', { turn: 0, reason: 'done' }));
    await flush();
    expect(backend.upsertSession).toHaveBeenCalledTimes(2);
    expect(backend.upsertSession.mock.calls.at(-1)?.[0]).toMatchObject({
      messageCount: 1,
      totalTokens: 120,
    });
  });

  it('tracks the latest session/title snapshot in the session row', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    ctx.events.emit('session/event', session, userEvent('how do I prune a git branch'));
    ctx.events.emit(
      'session/event',
      session,
      ev('session/title', {
        title: 'Prune a git branch',
        messageSeqs: [1],
        source: { kind: 'fallback' },
      }),
    );
    await flush();

    const lastSession = backend.upsertSession.mock.calls.at(-1)?.[0];
    expect(lastSession).toMatchObject({ sessionId: 's1', title: 'Prune a git branch' });
  });

  it('swallows backend errors with a prefixed console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.upsertMessage.mockRejectedValueOnce(new Error('db down'));

    expect(() => ctx.events.emit('session/event', { id: 's1' }, userEvent('x'))).not.toThrow();
    await flush();

    expect(errorSpy).toHaveBeenCalledWith('[dsh-storage] database error:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('resets the rollup when a session is disposed', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    ctx.events.emit('session/event', session, userEvent('x'));
    await flush();
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);

    ctx.events.emit('session/disposed', session);
    ctx.events.emit('session/event', session, userEvent('y'));
    await flush();
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);
  });

  it('closes backends when the fiber unloads', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    await flush();
    await ctx.fiber.dispose();
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('drains in-flight row writes before closing on unload', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    await flush();
    let release!: () => void;
    backend.upsertMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    ctx.events.emit('session/event', { id: 's1' }, userEvent('x'));
    const disposal = ctx.fiber.dispose();
    await flush();
    // The write is still in flight: close must wait for it.
    expect(backend.upsertMessage).toHaveBeenCalledTimes(1);
    expect(backend.close).not.toHaveBeenCalled();

    release();
    await disposal;
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('drains in-flight writes at the session/flush checkpoint', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    await flush();
    let release!: () => void;
    backend.upsertMessage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    ctx.events.emit('session/event', { id: 's1' }, userEvent('x'));
    let flushed = false;
    const checkpoint = ctx.events
      .parallel('session/flush', { id: 's1' })
      .then(() => (flushed = true));
    await flush();
    // The checkpoint awaits listeners, so it holds while a write is in flight.
    expect(flushed).toBe(false);

    release();
    await checkpoint;
    expect(flushed).toBe(true);
  });
});
