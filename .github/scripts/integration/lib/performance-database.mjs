/** Only disposable SQLite files and the explicitly named loopback PostgreSQL fixture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createAdapter,
  DatabaseBackend,
} from '../../../../packages/dsh-storage/lib/backends/database.js';

const storageRoot = fileURLToPath(new URL('../../../../packages/dsh-storage/', import.meta.url));
const require = createRequire(join(storageRoot, 'package.json'));

export async function performanceDatabase(provider = 'sqlite') {
  assert.ok(['sqlite', 'postgresql'].includes(provider));
  const directory = await mkdtemp(join(tmpdir(), 'dsh-performance-db-'));
  let client;
  let backend;
  try {
    let url = `file:${join(directory, 'performance.db')}`;
    if (provider === 'sqlite') writeFileSync(join(directory, 'performance.db'), '');
    if (provider === 'postgresql') {
      const requested = new URL(process.env.DSH_PERFORMANCE_DB_URL ?? '');
      assert.ok(
        ['127.0.0.1', 'localhost'].includes(requested.hostname),
        'benchmark database must be loopback',
      );
      assert.equal(
        requested.pathname,
        '/dsh_performance',
        'use the disposable dsh_performance database',
      );
      requested.searchParams.set('application_name', 'dsh_performance_backend');
      url = requested.href;
    }
    execFileSync(
      'pnpm',
      [
        'exec',
        'prisma',
        'db',
        'push',
        '--schema',
        `prisma/schema.${provider}.prisma`,
        '--url',
        url,
      ],
      {
        cwd: storageRoot,
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
    const { PrismaClient } = await import(
      new URL(
        `../../../../packages/dsh-storage/lib/generated/${provider}/client.js`,
        import.meta.url,
      )
    );
    let adapter;
    const poolName = `dsh_perf_pool_${randomUUID().slice(0, 8)}`;
    if (provider === 'postgresql') {
      const { PrismaPg } = await import(require.resolve('@prisma/adapter-pg'));
      const poolUrl = new URL(url);
      poolUrl.searchParams.set('application_name', poolName);
      adapter = new PrismaPg({ connectionString: poolUrl.href, max: 2 });
    } else adapter = await createAdapter({ provider, url });
    client = new PrismaClient({ adapter });
    await client.$connect();
    if (provider === 'sqlite') await client.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    backend = new DatabaseBackend({ provider, url });
    await backend.init();
    return {
      client,
      backend,
      provider,
      url,
      poolName,
      async close() {
        try {
          await backend.close();
        } finally {
          try {
            await client.$disconnect();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([backend?.close(), client?.$disconnect()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function benchmark(provider) {
  const db = await performanceDatabase(provider);
  const { client, backend } = db;
  const prefix = `perf-${randomUUID().slice(0, 8)}`;
  const target = `${prefix}-target`;
  const results = [];
  try {
    for (const count of [1000, 5000]) {
      const started = performance.now();
      const from = count === 1000 ? 0 : 1000;
      for (let start = from; start < count; start += 100) {
        const data = Array.from({ length: 100 }, (_, offset) => {
          const index = start + offset;
          return {
            id: randomUUID(),
            sessionId: index % 10 === 0 ? target : `${prefix}-noise`,
            type: 'model',
            content: 'x'.repeat(256),
            createdAt: new Date(1700000000000 + index * 1000),
            toolCalls: [{ id: `call-${index}`, name: 'read', arguments: '{}' }],
            metadata: { id: `m${index}` },
          };
        });
        if (provider === 'postgresql') await client.aiMessage.createMany({ data });
        else for (const row of data) await client.aiMessage.create({ data: row });
      }
      const seedMs = performance.now() - started;
      if (provider === 'sqlite') {
        await backend.close();
        await backend.init();
      }
      const queryAt = performance.now();
      const found = await backend.readToolCallMessages(target, 'call-0');
      assert.equal(found[0]?.id, 'm0');
      const lookupMs = performance.now() - queryAt;
      const marker = provider === 'postgresql' ? '$1' : '?';
      const sql = `SELECT id,tool_calls FROM ai_messages WHERE session_id=${marker} AND deleted_at IS NULL AND history_id IS NULL AND type='model' AND tool_calls IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 100`;
      const plan = await client.$queryRawUnsafe(
        `${provider === 'postgresql' ? 'EXPLAIN (ANALYZE, FORMAT JSON)' : 'EXPLAIN QUERY PLAN'} ${sql}`,
        target,
      );
      results.push({ rows: count, seedMs, oldestToolLookupMs: lookupMs, plan });
    }
    if (provider === 'sqlite') await client.$disconnect();
    const row = {
      id: 'direct',
      sessionId: target,
      historyId: null,
      type: 'user',
      content: 'initial',
      createdAt: new Date(),
    };
    await backend.upsertMessage(row);
    const readAt = performance.now();
    const reads = await Promise.all(
      Array.from({ length: 32 }, () => backend.readMessages(target, 'direct')),
    );
    assert.ok(reads.every((rows) => rows[0]?.content === 'initial'));
    const concurrentReadMs = performance.now() - readAt;
    let pool;
    let lock;
    if (provider === 'postgresql') {
      const poolAt = performance.now();
      const queued = await Promise.all(
        Array.from({ length: 32 }, () =>
          client.$queryRawUnsafe(
            'SELECT 1::int AS n,(SELECT count(*)::int FROM pg_stat_activity WHERE application_name=$1) AS connections FROM pg_sleep(0.01)',
            db.poolName,
          ),
        ),
      );
      const connections = Math.max(...queued.map((rows) => rows[0].connections));
      assert.equal(connections, 2, 'the 32-query fixture must saturate its two-connection pool');
      pool = { requests: 32, maxConnections: connections, elapsedMs: performance.now() - poolAt };
      const existing = await client.aiMessage.findFirst({
        where: { sessionId: target, content: 'initial' },
      });
      let unlock;
      let ready;
      const locked = new Promise((resolve) => {
        ready = resolve;
      });
      const release = new Promise((resolve) => {
        unlock = resolve;
      });
      const transaction = client.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT id FROM ai_messages WHERE id=$1 FOR UPDATE',
            existing.id,
          );
          ready();
          await release;
        },
        { timeout: 10_000 },
      );
      let writing;
      try {
        await Promise.race([locked, transaction]);
        const lockAt = performance.now();
        let settled = false;
        writing = backend.upsertMessage({ ...row, content: 'updated' }).then(() => {
          settled = true;
        });
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const rows = await client.$queryRawUnsafe(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='dsh_performance_backend' AND wait_event_type='Lock'",
          );
          if (rows[0].n > 0) {
            waiting = true;
            break;
          }
          await delay(10);
        }
        assert.ok(waiting, 'database must observe the blocked write');
        assert.equal(settled, false);
        const independentAt = performance.now();
        assert.equal((await backend.readToolCallMessages(target, 'call-10'))[0]?.id, 'm10');
        const independentReadMs = performance.now() - independentAt;
        unlock();
        await Promise.all([writing, transaction]);
        lock = { waitAndReleaseMs: performance.now() - lockAt, independentReadMs };
      } finally {
        unlock();
        await Promise.allSettled([transaction, writing]);
      }
    }
    const archiveAt = performance.now();
    const history = await backend.archiveSession(target);
    assert.ok(history);
    if (provider === 'sqlite') {
      await backend.close();
      await client.$connect();
    }
    assert.equal(
      await client.aiMessage.count({ where: { sessionId: target, historyId: null } }),
      0,
    );
    assert.equal(await client.aiMessage.count({ where: { historyId: history } }), 501);
    writeFileSync(
      `performance-database-${provider}.json`,
      JSON.stringify(
        {
          provider,
          results,
          concurrentReadMs,
          pool,
          lock,
          archiveMs: performance.now() - archiveAt,
        },
        (_key, value) => (typeof value === 'bigint' ? String(value) : value),
        2,
      ),
    );
    console.log(
      `${provider}: query plans, concurrent reads, archive${pool ? ', pool saturation and row-lock isolation' : ''} passed`,
    );
  } finally {
    try {
      if (provider === 'postgresql') {
        await client.aiMessage.deleteMany({ where: { sessionId: { startsWith: prefix } } });
        await client.aiChatHistory.deleteMany({ where: { sessionId: { startsWith: prefix } } });
      }
    } finally {
      await db.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await benchmark(process.env.DSH_PERFORMANCE_DB_PROVIDER ?? 'sqlite');
}
