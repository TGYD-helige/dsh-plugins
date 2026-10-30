import { Context } from '@deepseek-ai/cordis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name } from './index.js';

const backends = vi.hoisted(() => ({
  instances: [] as any[],
  initImpl: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('./backends/database.js', () => ({
  DatabaseBackend: class {
    readonly name = 'database';
    init = vi.fn(() => backends.initImpl?.() ?? Promise.resolve());
    readSession = vi.fn(async () => null);
    readMessages = vi.fn(async () => [] as any[]);
    readToolCallMessages = vi.fn(async () => [] as any[]);
    upsertMessage = vi.fn(async (_row: any) => {});
    upsertSession = vi.fn(async (_row: any) => {});
    upsertEvent = vi.fn(async (message: any, session: any) => {
      if (message) await this.upsertMessage(message);
      await this.upsertSession(session);
    });
    archiveSession = vi.fn(async (): Promise<string | null> => 'history-1');
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

/** V3 failed/cancelled attempt: the adapter's usage survives as a raw record in the embedded compact stream. */
const attemptWithUsage = (turn: number, step: number, usage: unknown, time?: number) =>
  ev(
    'assistant/attempt',
    {
      turn,
      step,
      stream: [{ type: 'chunk', time: 1700000000000, chunk: { type: 'usage', usage } }],
    },
    time,
  );

describe('dsh-storage plugin', () => {
  let ctx: Context;

  beforeEach(() => {
    backends.instances.length = 0;
    backends.initImpl = undefined;
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

  it('stores successful compaction as a source-compatible snapshot of the committed surface', async () => {
    apply(ctx, enabledConfig);
    const session = {
      id: 's1',
      header: { createdAt: 1000 },
      deriveMessages: vi.fn(() => [
        { role: 'system', content: [{ type: 'text', text: 'Private system prompt' }] },
        { role: 'user', content: [{ type: 'text', text: 'Summary of earlier work' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Retained tail' }] },
      ]),
    };
    ctx.events.emit(
      'session/event',
      session,
      ev('compaction/end', { compactionId: 'compact-1', turn: 1 }),
    );
    session.deriveMessages.mockReturnValue([]);
    await ctx.parallel('session/flush', session as any);
    const backend = backends.instances[0];
    const row = backend.upsertMessage.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      id: 'compact-1',
      type: 'utility_compressor',
      sessionId: 's1',
      agentId: 'main',
      historyId: null,
    });
    expect(JSON.parse(row.content)).toEqual([
      { role: 'user', parts: [{ text: 'Summary of earlier work' }] },
      { role: 'model', parts: [{ text: 'Retained tail' }] },
    ]);
    expect(row.metadata).toMatchObject({ seq: 1, sessionCreatedAt: 1000 });
    expect(backend.upsertSession).not.toHaveBeenCalled();
  });

  it('logs snapshot failures and still mirrors later conversation events', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('missing message interpreter');
    const session = {
      id: 's1',
      deriveMessages: () => {
        throw failure;
      },
    };
    try {
      apply(ctx, enabledConfig);
      expect(() =>
        ctx.events.emit(
          'session/event',
          session,
          ev('compaction/end', { compactionId: 'bad', turn: 1 }),
        ),
      ).not.toThrow();
      ctx.events.emit('session/event', session, userEvent('Still available', 'next'));
      await ctx.parallel('session/flush', session as any);
      expect(log).toHaveBeenCalledWith('[dsh-storage] compaction snapshot error:', failure);
      const backend = backends.instances[0];
      expect(
        backend.upsertMessage.mock.calls.map(([row]: any[]) => ({
          id: row.id,
          type: row.type,
          content: row.content,
        })),
      ).toEqual([{ id: 'next', type: 'user', content: 'Still available' }]);
    } finally {
      await ctx.fiber.dispose();
      log.mockRestore();
    }
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

  it('archives after queued writes and starts a fresh session rollup', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };
    ctx.events.emit('session/event', session, userEvent('before', 'm1'));

    const service = ctx.get('dshStorage') as { archiveSession(id: string): Promise<string | null> };
    await expect(service.archiveSession('s1')).resolves.toBe('history-1');
    expect(backend.archiveSession).toHaveBeenCalledWith('s1');
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);

    ctx.events.emit('session/event', session, userEvent('after', 'm2'));
    await ctx.events.parallel('session/flush', session);
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);
  });

  it('freezes the cumulative token baseline at archive start', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('first', { inputTokens: 100, outputTokens: 0 }, 'a1'),
    );

    const service = ctx.get('dshStorage') as { archiveSession(id: string): Promise<string | null> };
    backend.archiveSession.mockRejectedValueOnce(new Error('archive interrupted'));
    await expect(service.archiveSession('s1')).rejects.toThrow('archive interrupted');
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('second', { inputTokens: 10, outputTokens: 0 }, 'a2'),
    );
    await ctx.events.parallel('session/flush', session);

    expect(backend.upsertSession.mock.calls.at(-1)?.[0]).toMatchObject({
      totalTokens: 110,
      metadata: { 'dsh-storage:token-baseline': 100 },
    });
  });

  it('preserves the first baseline across consecutive archive failures', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('first', { inputTokens: 100, outputTokens: 0 }, 'a1'),
    );
    await ctx.events.parallel('session/flush', session);

    const service = ctx.get('dshStorage') as { archiveSession(id: string): Promise<string | null> };
    backend.archiveSession
      .mockRejectedValueOnce(new Error('first archive failure'))
      .mockRejectedValueOnce(new Error('second archive failure'));
    await expect(service.archiveSession('s1')).rejects.toThrow('first archive failure');
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('second', { inputTokens: 10, outputTokens: 0 }, 'a2'),
    );
    await ctx.events.parallel('session/flush', session);
    await expect(service.archiveSession('s1')).rejects.toThrow('second archive failure');
    ctx.events.emit(
      'session/event',
      session,
      assistantEvent('third', { inputTokens: 5, outputTokens: 0 }, 'a3'),
    );
    await ctx.events.parallel('session/flush', session);

    expect(backend.upsertSession.mock.calls.at(-1)?.[0]).toMatchObject({
      totalTokens: 115,
      metadata: { 'dsh-storage:token-baseline': 100 },
    });
  });

  it('keeps the current rollup when archive fails', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const service = ctx.get('dshStorage') as { archiveSession(id: string): Promise<string | null> };
    backend.archiveSession.mockRejectedValueOnce(new Error('db down'));
    const session = { id: 's1' };
    ctx.events.emit('session/event', session, userEvent('before', 'm1'));

    await expect(service.archiveSession('s1')).rejects.toThrow('db down');
    ctx.events.emit('session/event', session, userEvent('after', 'm2'));
    await ctx.events.parallel('session/flush', session);
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(2);
  });

  it('preserves a merged result when tool results and the assistant message are redelivered', async () => {
    const rows = new Map<string, any>();
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.upsertMessage.mockImplementation(async (row: any) => {
      rows.set(row.id, row);
    });
    backend.readMessages.mockImplementation(async () => [...rows.values()]);
    backend.readToolCallMessages.mockImplementation(async () => [...rows.values()]);
    const session = { id: 's1' };
    const call = assistantEvent('', undefined, 'a1') as any;
    call.data.message.content.push({
      type: 'tool-call',
      id: 'call-1',
      name: 'read',
      arguments: '{}',
    });
    ctx.events.emit('session/event', session, call);
    const resultBlock = {
      type: 'tool-result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'ok' }],
    };
    const result = ev('tool/result', {
      message: { id: 'r1', source: { callId: 'call-1' }, content: [resultBlock] },
    });
    ctx.events.emit('session/event', session, result);
    ctx.events.emit('session/event', session, result);
    ctx.events.emit('session/event', session, call);
    await ctx.events.parallel('session/flush', session);
    expect([...rows.values()]).toMatchObject([
      { id: 'a1', type: 'model', toolCalls: [{ id: 'call-1', result: resultBlock }] },
    ]);
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);
  });

  it('uses a committed assistant tool call to read only its model row for a result', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const model = {
      id: 'a1',
      sessionId: 's1',
      historyId: null,
      type: 'model',
      content: '',
      toolCalls: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
      createdAt: new Date(1700000000000),
    };
    backend.readMessages.mockResolvedValue([model]);
    const call = assistantEvent('', undefined, 'a1') as any;
    call.data.message.content.push({ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' });

    ctx.events.emit('session/event', { id: 's1' }, call);
    ctx.events.emit(
      'session/event',
      { id: 's1' },
      ev('tool/result', {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'ok' }],
        },
      }),
    );
    await flush();

    expect(backend.readMessages.mock.calls.map((args: any[]) => args)).toEqual([
      ['s1', 'a1'],
      ['s1', 'a1'],
    ]);
  });

  it('uses the restored model surface to avoid scanning on a cold cache', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readMessages.mockResolvedValue([
      {
        id: 'restored-message',
        type: 'model',
        toolCalls: [{ id: 'restored-call' }],
      },
    ]);
    const session = {
      id: 's1',
      deriveMessages: () => [
        {
          role: 'assistant',
          id: 'restored-message',
          content: [{ type: 'tool-call', id: 'restored-call' }],
        },
      ],
    };
    ctx.events.emit(
      'session/event',
      session,
      ev('tool/result', {
        message: { source: { callId: 'restored-call' }, content: [] },
      }),
    );
    await ctx.events.parallel('session/flush', session);
    expect(backend.readMessages).toHaveBeenCalledExactlyOnceWith('s1', 'restored-message');
    expect(backend.readToolCallMessages).not.toHaveBeenCalled();
  });

  it('does not query message history when a tool result has no call id', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctx.events.emit('session/event', { id: 's1' }, ev('tool/result', { message: { content: [] } }));
    await ctx.events.parallel('session/flush', { id: 's1' });
    expect(backend.readMessages).not.toHaveBeenCalled();
    expect(backend.readToolCallMessages).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('locates only the matching row on a cache miss and remembers its call ids', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const model = {
      id: 'a1',
      sessionId: 's1',
      historyId: null,
      type: 'model',
      content: '',
      toolCalls: [
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'write', arguments: '{}' },
      ],
      createdAt: new Date(1700000000000),
    };
    backend.readToolCallMessages.mockResolvedValue([model]);
    backend.readMessages.mockResolvedValue([model]);
    const result = (callId: string) =>
      ev('tool/result', {
        message: { source: { kind: 'tool', callId }, toolCallId: callId, content: [] },
      });

    ctx.events.emit('session/event', { id: 's1' }, result('c1'));
    ctx.events.emit('session/event', { id: 's1' }, result('c2'));
    await flush();

    expect(backend.readMessages.mock.calls.map((args: any[]) => args)).toEqual([['s1', 'a1']]);
    expect(backend.readToolCallMessages).toHaveBeenCalledExactlyOnceWith('s1', 'c1');
  });

  it('locates only the matching row when an old call id is evicted from the bounded cache', async () => {
    const rows = new Map<string, any>();
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.upsertMessage.mockImplementation(async (row: any) => {
      rows.set(row.id, row);
    });
    const readCalls: any[][] = [];
    backend.readMessages.mockImplementation(async (_sessionId: string, messageId?: string) => {
      readCalls.push(messageId === undefined ? [] : [messageId]);
      return messageId === undefined
        ? [...rows.values()]
        : rows.get(messageId)
          ? [rows.get(messageId)]
          : [];
    });
    backend.readToolCallMessages.mockImplementation(async (_sessionId: string, callId: string) =>
      [...rows.values()].filter((row) => row.toolCalls?.some((call: any) => call.id === callId)),
    );
    const session = { id: 's1' };
    const first = assistantEvent('', undefined, 'a0') as any;
    first.data.message.content.push({ type: 'tool-call', id: 'c0', name: 'read', arguments: '{}' });
    ctx.events.emit('session/event', session, first);
    const later = assistantEvent('', undefined, 'a1') as any;
    for (let index = 1; index <= 1000; index++) {
      later.data.message.content.push({
        type: 'tool-call',
        id: `c${index}`,
        name: 'read',
        arguments: '{}',
      });
    }
    ctx.events.emit('session/event', session, later);

    ctx.events.emit(
      'session/event',
      session,
      ev('tool/result', {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'c0' },
          toolCallId: 'c0',
          content: [{ type: 'text', text: 'old result' }],
        },
      }),
    );
    await ctx.events.parallel('session/flush', session);

    expect(backend.readToolCallMessages).toHaveBeenCalledExactlyOnceWith('s1', 'c0');
    expect(readCalls.every((args) => args.length === 1)).toBe(true);
    expect(rows.get('a0').toolCalls).toEqual([
      expect.objectContaining({
        id: 'c0',
        result: expect.objectContaining({
          type: 'tool-result',
          toolCallId: 'c0',
          content: [{ type: 'text', text: 'old result' }],
        }),
      }),
    ]);
  });

  it('matches a tool result against a model row persisted before resume', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readSession.mockResolvedValue({ sessionId: 's1', messageCount: 1, totalTokens: 0 });
    backend.readToolCallMessages.mockResolvedValue([
      {
        id: 'a1',
        sessionId: 's1',
        historyId: null,
        type: 'model',
        content: '',
        toolCalls: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
        createdAt: new Date(1700000000000),
      },
    ]);
    const resultBlock = {
      type: 'tool-result',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'ok' }],
    };
    ctx.events.emit(
      'session/event',
      { id: 's1' },
      ev('tool/result', {
        message: { source: { callId: 'c1' }, content: [resultBlock] },
      }),
    );
    await ctx.events.parallel('session/flush', { id: 's1' });
    expect(backend.upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'a1',
        type: 'model',
        toolCalls: [expect.objectContaining({ id: 'c1', result: resultBlock })],
      }),
    );
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);
  });

  it('logs a message lookup failure and keeps later session events flowing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readToolCallMessages.mockRejectedValueOnce(new Error('db down'));
    ctx.events.emit(
      'session/event',
      { id: 's1' },
      ev('tool/result', {
        message: { source: { callId: 'c1' }, content: [] },
      }),
    );
    ctx.events.emit('session/event', { id: 's1' }, userEvent('second', 'm2'));
    await ctx.events.parallel('session/flush', { id: 's1' });
    expect(backend.upsertMessage.mock.calls.map((call: any) => call[0].id)).toEqual(['m2']);
    expect(errorSpy).toHaveBeenCalledWith('[dsh-storage] mirror task error:', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('ignores log-only events; turn/end only checkpoints the rollup', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    ctx.events.emit(
      'session/event',
      session,
      ev('assistant/attempt', { turn: 0, step: 0, stream: [] }),
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

  it('does not advance the rollup when an event write fails, then retries cleanly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.upsertMessage.mockRejectedValueOnce(new Error('db down'));
    const session = { id: 's1' };
    const event = userEvent('x');

    expect(() => ctx.events.emit('session/event', session, event)).not.toThrow();
    await flush();
    expect(backend.upsertSession).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[dsh-storage\]/),
      expect.any(Error),
    );

    ctx.events.emit('session/event', session, event);
    await flush();
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);
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

  it('closes the backend when init fails during unload', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectInit!: (error: Error) => void;
    backends.initImpl = () => new Promise<void>((_resolve, reject) => (rejectInit = reject));
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];

    const disposal = ctx.fiber.dispose();
    rejectInit(new Error('init failed during unload'));

    await expect(disposal).resolves.toBeUndefined();
    expect(backend.close).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
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

  it('drains writes created after a delayed init before closing on unload', async () => {
    let releaseInit!: () => void;
    backends.initImpl = () => new Promise<void>((resolve) => (releaseInit = resolve));
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const order: string[] = [];
    let releaseWrite!: () => void;
    backend.upsertEvent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('upsert:start');
          releaseWrite = () => {
            order.push('upsert:end');
            resolve();
          };
        }),
    );
    backend.close.mockImplementation(async () => order.push('close'));
    ctx.events.emit('session/event', { id: 's1' }, userEvent('first', 'm1'));

    const disposal = ctx.fiber.dispose();
    releaseInit();
    await vi.waitFor(() => expect(backend.upsertEvent).toHaveBeenCalledOnce());
    expect(backend.close).not.toHaveBeenCalled();
    releaseWrite();
    await disposal;
    expect(order).toEqual(['upsert:start', 'upsert:end', 'close']);
  });

  it('drains writes created after a delayed seed read before closing on unload', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    await flush();
    let releaseRead!: () => void;
    backend.readSession.mockImplementationOnce(
      () => new Promise<null>((resolve) => (releaseRead = () => resolve(null))),
    );
    const order: string[] = [];
    let releaseWrite!: () => void;
    backend.upsertEvent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('upsert:start');
          releaseWrite = () => {
            order.push('upsert:end');
            resolve();
          };
        }),
    );
    backend.close.mockImplementation(async () => order.push('close'));
    ctx.events.emit('session/event', { id: 's1' }, userEvent('first', 'm1'));
    await vi.waitFor(() => expect(backend.readSession).toHaveBeenCalledOnce());

    const disposal = ctx.fiber.dispose();
    releaseRead();
    await vi.waitFor(() => expect(backend.upsertEvent).toHaveBeenCalledOnce());
    expect(backend.close).not.toHaveBeenCalled();
    releaseWrite();
    await disposal;
    expect(order).toEqual(['upsert:start', 'upsert:end', 'close']);
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

  it('does not block one session flush on another session write', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    await flush();
    let releaseB!: () => void;
    backend.upsertSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseB = resolve)),
    );
    const a = { id: 'a' };
    const b = { id: 'b' };
    ctx.events.emit('session/event', b, userEvent('blocked', 'b1'));
    ctx.events.emit('session/event', a, userEvent('ready', 'a1'));

    let aFlushed = false;
    const checkpointA = ctx.events.parallel('session/flush', a).then(() => (aFlushed = true));
    await flush();
    const flushedWhileBWasBlocked = aFlushed;

    releaseB();
    await Promise.all([checkpointA, ctx.events.parallel('session/flush', b)]);
    expect(flushedWhileBWasBlocked).toBe(true);
  });

  it('seeds the rollup from the stored session row on resume', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readSession.mockResolvedValue({
      sessionId: 's1',
      title: 'old title',
      messageCount: 50,
      totalTokens: 1000,
      firstMessageAt: new Date(1600000000000),
      lastMessageAt: new Date(1600000100000),
    });

    ctx.events.emit('session/event', { id: 's1' }, userEvent('x', 'm1', 1700000000000));
    await flush();

    expect(backend.readSession).toHaveBeenCalledWith('s1');
    const lastSession = backend.upsertSession.mock.calls.at(-1)?.[0];
    expect(lastSession).toMatchObject({
      sessionId: 's1',
      title: 'old title',
      messageCount: 51,
      totalTokens: 1000,
      firstMessageAt: new Date(1600000000000),
      lastMessageAt: new Date(1700000000000),
    });
  });

  it('waits for backend init before seeding the rollup', async () => {
    let releaseInit!: () => void;
    backends.initImpl = () => new Promise<void>((resolve) => (releaseInit = resolve));
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readSession.mockResolvedValue({
      sessionId: 's1',
      title: 'old title',
      messageCount: 50,
      totalTokens: 1000,
      firstMessageAt: new Date(1600000000000),
      lastMessageAt: new Date(1600000100000),
    });

    ctx.events.emit('session/event', { id: 's1' }, userEvent('x', 'm1', 1700000000000));
    await flush();
    // Init still pending: no read, no write — nothing may zero-seed over the
    // stored rollup while the backend is still connecting.
    expect(backend.readSession).not.toHaveBeenCalled();
    expect(backend.upsertSession).not.toHaveBeenCalled();

    releaseInit();
    await flush();
    expect(backend.readSession).toHaveBeenCalledWith('s1');
    expect(backend.upsertSession.mock.calls.at(-1)?.[0]).toMatchObject({
      messageCount: 51,
      totalTokens: 1000,
    });
  });

  it('retries a failed backend init on a later event without zero-seeding', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    backends.initImpl = async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('database unavailable');
    };
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    await flush();
    expect(attempts).toBe(1);

    ctx.events.emit('session/event', { id: 's1' }, userEvent('lost while down', 'm1'));
    await flush();
    expect(attempts).toBe(2);
    expect(backend.readSession).not.toHaveBeenCalled();
    expect(backend.upsertEvent).not.toHaveBeenCalled();

    ctx.events.emit('session/event', { id: 's1' }, userEvent('stored after recovery', 'm2'));
    await flush();
    expect(attempts).toBe(3);
    expect(backend.readSession).toHaveBeenCalledOnce();
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(1);
    errorSpy.mockRestore();
  });

  it('treats a seed read failure as failure (no zero-seed overwrite) and retries', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readSession.mockRejectedValueOnce(new Error('db down'));

    ctx.events.emit('session/event', { id: 's1' }, userEvent('x', 'm1', 1700000000000));
    await flush();

    // The failed read must not produce a zero-seeded session row.
    expect(backend.upsertSession).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('[dsh-storage] database error:', expect.any(Error));

    // Next event re-seeds from the (now readable) stored row.
    backend.readSession.mockResolvedValue({
      sessionId: 's1',
      title: null,
      messageCount: 50,
      totalTokens: 1000,
      firstMessageAt: new Date(1600000000000),
      lastMessageAt: new Date(1600000100000),
    });
    ctx.events.emit('session/event', { id: 's1' }, userEvent('y', 'm2', 1700000001000));
    await flush();
    expect(backend.upsertSession.mock.calls.at(-1)?.[0]).toMatchObject({
      messageCount: 51,
      totalTokens: 1000,
    });
    errorSpy.mockRestore();
  });

  it('adds usage for every model call across attempts and messages', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    // Failed step: usage arrives only in the committed attempt's embedded
    // stream; no assistant/message exists for it.
    ctx.events.emit(
      'session/event',
      session,
      attemptWithUsage(0, 0, { inputTokens: 10, outputTokens: 5 }),
    );
    // Retry at the next step: a failed attempt's call, then another model call
    // whose settled message lands on the SAME step — both calls are billed.
    ctx.events.emit(
      'session/event',
      session,
      attemptWithUsage(0, 1, { inputTokens: 20, outputTokens: 0 }),
    );
    ctx.events.emit(
      'session/event',
      session,
      ev(
        'assistant/message',
        {
          turn: 0,
          step: 1,
          message: {
            id: 'a1',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
          usage: { inputTokens: 20, outputTokens: 7 },
        },
        1700000001000,
      ),
    );
    await flush();

    const lastSession = backend.upsertSession.mock.calls.at(-1)?.[0];
    expect(lastSession).toMatchObject({
      messageCount: 1,
      // step 0: 10+5; step 1: failed call 20+0 plus successful call 20+7.
      // Total = 15 + 20 + 27 = 62.
      totalTokens: 62,
    });
  });

  it('adds separate attempts even when they share one step', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const session = { id: 's1' };

    // Two attempts at the same step are two model calls, not progressive snapshots.
    ctx.events.emit(
      'session/event',
      session,
      attemptWithUsage(0, 0, { inputTokens: 10, outputTokens: 0 }),
    );
    ctx.events.emit(
      'session/event',
      session,
      attemptWithUsage(0, 0, { inputTokens: 10, outputTokens: 5 }),
    );
    await flush();

    expect(backend.upsertSession.mock.calls.at(-1)?.[0].totalTokens).toBe(25);
  });

  it('does not count redelivered usage events again, including older sequences', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    const first = attemptWithUsage(0, 0, { inputTokens: 10, outputTokens: 5 });
    const second = attemptWithUsage(0, 0, { inputTokens: 20, outputTokens: 0 });

    ctx.events.emit('session/event', { id: 's1' }, first);
    ctx.events.emit('session/event', { id: 's1' }, second);
    ctx.events.emit('session/event', { id: 's1' }, first);
    ctx.events.emit('session/event', { id: 's1' }, second);
    await flush();

    expect(backend.upsertSession.mock.calls.at(-1)?.[0].totalTokens).toBe(35);
  });

  it('folds cache buckets into the token total', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];

    ctx.events.emit(
      'session/event',
      { id: 's1' },
      assistantEvent('hi', {
        inputTokens: 100,
        outputTokens: 7,
        cacheReadTokens: 900,
        cacheWriteTokens: 30,
      }),
    );
    await flush();

    expect(backend.upsertSession.mock.calls.at(-1)?.[0].totalTokens).toBe(1037);
  });

  it('keeps write order across dispose and a new event on the same id', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    let release!: () => void;
    backend.upsertSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const session = { id: 's1' };
    ctx.events.emit('session/event', session, userEvent('a'));
    ctx.events.emit('session/event', session, userEvent('b'));
    ctx.events.emit('session/disposed', session);
    ctx.events.emit('session/event', session, userEvent('c'));
    await flush();
    // taskA is now blocked on its first write; taskB/C are chained behind it.
    release();
    await flush();

    // taskA (count=1) and taskB (count=2) land before taskC (re-seeded
    // count=1) — the settle-guarded chain delete cannot let C jump the queue.
    expect(backend.upsertSession.mock.calls.map((c: any) => c[0].messageCount)).toEqual([1, 2, 1]);
  });

  it('restores the usage sequence high-water mark and adds only unseen calls', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    backend.readSession.mockResolvedValue({
      sessionId: 's1',
      title: null,
      messageCount: 5,
      totalTokens: 120,
      metadata: {
        custom: 'keep-me',
        'dsh-storage:lastUsage': { key: '0', input: 100, output: 20 },
      },
    });

    // Sequence 1 is a new model call after the reload, so all of its usage is
    // added to the stored total: 120 + 150 + 30 = 300.
    ctx.events.emit(
      'session/event',
      { id: 's1' },
      assistantEvent('hello', { inputTokens: 150, outputTokens: 30 }),
    );
    await flush();

    const lastSession = backend.upsertSession.mock.calls.at(-1)?.[0];
    expect(lastSession.totalTokens).toBe(300);
    // Existing metadata fields survive our bookkeeping write.
    expect(lastSession.metadata).toMatchObject({
      custom: 'keep-me',
      'dsh-storage:lastUsage': { key: '1', input: 150, output: 30 },
    });
  });

  it('serializes rollup writes per session: latest-wins under bursts', async () => {
    apply(ctx, enabledConfig);
    const backend = backends.instances[0];
    let release!: () => void;
    backend.upsertSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    ctx.events.emit('session/event', { id: 's1' }, userEvent('a'));
    ctx.events.emit('session/event', { id: 's1' }, userEvent('b'));
    await flush();
    // First write still in flight; the second event's write must be queued
    // behind it, not racing it.
    expect(backend.upsertSession).toHaveBeenCalledTimes(1);

    release();
    await flush();
    expect(backend.upsertSession).toHaveBeenCalledTimes(2);
    expect(backend.upsertSession.mock.calls[0][0].messageCount).toBe(1);
    expect(backend.upsertSession.mock.calls[1][0].messageCount).toBe(2);
    // Final state is the newest snapshot, never an older one landing last.
    expect(backend.upsertSession.mock.calls.at(-1)?.[0].messageCount).toBe(2);
  });
});
