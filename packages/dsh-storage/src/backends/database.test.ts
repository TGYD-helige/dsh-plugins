import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageRow, SessionRow } from '../types.js';
import { DatabaseBackend } from './database.js';

const prismaMock = vi.hoisted(() => {
  const instances: any[] = [];
  class PrismaClient {
    aiMessage = { upsert: vi.fn() };
    aiChatHistory = { upsert: vi.fn() };
    $connect = vi.fn(async () => {});
    $disconnect = vi.fn(async () => {});
    constructor(public options: unknown) {
      instances.push(this);
    }
  }
  return { instances, PrismaClient };
});

const adapterMocks = vi.hoisted(() => {
  const calls: Record<string, unknown[]> = { mariadb: [], pg: [], sqlite: [], mssql: [] };
  const make = (key: keyof typeof calls) =>
    class {
      constructor(public arg: unknown) {
        calls[key].push(arg);
      }
    };
  return {
    calls,
    PrismaMariaDb: make('mariadb'),
    PrismaPg: make('pg'),
    PrismaLibSql: make('sqlite'),
    PrismaMssql: make('mssql'),
  };
});

vi.mock('@prisma/adapter-mariadb', () => ({ PrismaMariaDb: adapterMocks.PrismaMariaDb }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: adapterMocks.PrismaPg }));
vi.mock('@prisma/adapter-libsql', () => ({ PrismaLibSql: adapterMocks.PrismaLibSql }));
vi.mock('@prisma/adapter-mssql', () => ({ PrismaMssql: adapterMocks.PrismaMssql }));

const url = 'file:/tmp/dsh.db';
const baseConfig = { provider: 'sqlite', url } as const;

const messageRow: MessageRow = {
  id: 'm1',
  sessionId: 's1',
  historyId: null,
  type: 'user',
  content: 'hello',
  metadata: { event: 'user/message' },
  createdAt: new Date(1700000000000),
};

const sessionRow: SessionRow = {
  sessionId: 's1',
  messageCount: 3,
  totalTokens: 42,
  firstMessageAt: new Date(1700000000000),
  lastMessageAt: new Date(1700000001000),
};

describe('DatabaseBackend', () => {
  let backend: DatabaseBackend;

  beforeEach(() => {
    prismaMock.instances.length = 0;
    for (const calls of Object.values(adapterMocks.calls)) calls.length = 0;
    vi.spyOn(DatabaseBackend.prototype as any, 'loadClient').mockResolvedValue(
      prismaMock.PrismaClient,
    );
    backend = new DatabaseBackend(baseConfig);
  });

  it('connects the generated client with the provider adapter', async () => {
    await backend.init();
    const prisma = prismaMock.instances[0];
    expect(prisma.options).toEqual({ adapter: expect.any(adapterMocks.PrismaLibSql) });
    expect(adapterMocks.calls.sqlite).toEqual([{ url }]);
    expect(prisma.$connect).toHaveBeenCalledTimes(1);
  });

  it('builds the mysql adapter from a mariadb:// url', async () => {
    backend = new DatabaseBackend({ provider: 'mysql', url: 'mysql://u:p@host:3306/db' });
    await backend.init();
    expect(adapterMocks.calls.mariadb).toEqual(['mariadb://u:p@host:3306/db']);
  });

  it('builds the postgresql adapter from the connection string', async () => {
    backend = new DatabaseBackend({ provider: 'postgresql', url: 'postgresql://u:p@host/db' });
    await backend.init();
    expect(adapterMocks.calls.pg).toEqual([{ connectionString: 'postgresql://u:p@host/db' }]);
  });

  it.each([
    {
      url: 'sqlserver://host:1433;database=dsh;user=sa;password=p%40ss%3A%2F%25;encrypt=false',
      expected: {
        server: 'host',
        port: 1433,
        database: 'dsh',
        user: 'sa',
        password: 'p@ss:/%',
        options: { encrypt: false, trustServerCertificate: false },
      },
    },
    {
      url: 'sqlserver://host:1433;database=dsh;user=sa;password=p;encrypt=true;trustServerCertificate=true',
      expected: {
        server: 'host',
        port: 1433,
        database: 'dsh',
        user: 'sa',
        password: 'p',
        options: { encrypt: true, trustServerCertificate: true },
      },
    },
  ])('parses the sqlserver url into a node-mssql config ($url)', async ({ url, expected }) => {
    backend = new DatabaseBackend({ provider: 'sqlserver', url });
    await backend.init();
    expect(adapterMocks.calls.mssql).toEqual([expected]);
  });

  it('fails fast on a sqlserver url missing keys, without leaking credentials', async () => {
    backend = new DatabaseBackend({
      provider: 'sqlserver',
      url: 'sqlserver://host:1433;user=sa;password=s3cret',
    });
    await expect(backend.init()).rejects.toThrow(/missing 'database'/);
    await expect(backend.init()).rejects.not.toThrow(/s3cret/);
  });

  it('no-ops writes before init', async () => {
    await expect(backend.upsertMessage(messageRow)).resolves.toBeUndefined();
    await expect(backend.upsertSession(sessionRow)).resolves.toBeUndefined();
    expect(prismaMock.instances).toHaveLength(0);
  });

  it('upserts a message row by a deterministic PK, logical id in metadata', async () => {
    await backend.init();
    const prisma = prismaMock.instances[0];

    await backend.upsertMessage(messageRow);

    expect(prisma.aiMessage.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.aiMessage.upsert.mock.calls[0][0];
    expect(call.where.id).toMatch(/^[0-9a-f]{36}$/);
    expect(call.create).toMatchObject({
      id: call.where.id,
      sessionId: 's1',
      historyId: null,
      type: 'user',
      content: 'hello',
      metadata: { id: 'm1', event: 'user/message' },
      createdAt: new Date(1700000000000),
    });
    expect(call.update).toMatchObject({ content: 'hello' });
    expect(call.update.id).toBeUndefined();
    expect(call.update.sessionId).toBeUndefined();
  });

  it('derives a stable PK per (sessionId, messageId)', async () => {
    await backend.init();
    const prisma = prismaMock.instances[0];

    await backend.upsertMessage(messageRow);
    await backend.upsertMessage(messageRow);
    await backend.upsertMessage({ ...messageRow, id: 'm2' });
    await backend.upsertMessage({ ...messageRow, sessionId: 's2' });

    const ids = prisma.aiMessage.upsert.mock.calls.map((c: any) => c[0].where.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(ids[0]).not.toBe(ids[3]);
    expect(ids[2]).not.toBe(ids[3]);
  });

  it('upserts the session row by deterministic PK with BigInt totalTokens', async () => {
    await backend.init();
    const prisma = prismaMock.instances[0];

    await backend.upsertSession(sessionRow);

    expect(prisma.aiChatHistory.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.aiChatHistory.upsert.mock.calls[0][0];
    expect(call.where.id).toMatch(/^[0-9a-f]{36}$/);
    expect(call.create).toMatchObject({
      id: call.where.id,
      sessionId: 's1',
      messageCount: 3,
      totalTokens: BigInt(42),
      firstMessageAt: new Date(1700000000000),
      lastMessageAt: new Date(1700000001000),
    });
    expect(call.update).toMatchObject({ messageCount: 3 });
    expect(call.update.id).toBeUndefined();
    expect(call.update.sessionId).toBeUndefined();
  });

  it('derives a stable session PK per sessionId', async () => {
    await backend.init();
    const prisma = prismaMock.instances[0];

    await backend.upsertSession(sessionRow);
    await backend.upsertSession(sessionRow);
    await backend.upsertSession({ ...sessionRow, sessionId: 's2' });

    const ids = prisma.aiChatHistory.upsert.mock.calls.map((c: any) => c[0].where.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it('serializes JSON columns as text on sqlserver (derived from provider)', async () => {
    backend = new DatabaseBackend({
      provider: 'sqlserver',
      url: 'sqlserver://host:1433;database=dsh;user=sa;password=p',
    });
    await backend.init();
    const prisma = prismaMock.instances[0];

    await backend.upsertMessage({
      ...messageRow,
      thoughts: 'thinking…',
      tokens: { inputTokens: 1, outputTokens: 2 },
      toolCalls: [{ callId: 'c1', result: null }],
    });

    const call = prisma.aiMessage.upsert.mock.calls[0][0];
    expect(call.create.thoughts).toBe('"thinking…"');
    expect(call.create.tokens).toBe('{"inputTokens":1,"outputTokens":2}');
    expect(call.create.toolCalls).toBe('[{"callId":"c1","result":null}]');
    expect(call.create.metadata).toBe(JSON.stringify({ id: 'm1', event: 'user/message' }));
    expect(call.create.content).toBe('hello');
  });

  it('disconnects on close', async () => {
    await backend.init();
    const prisma = prismaMock.instances[0];
    await backend.close();
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });
});
