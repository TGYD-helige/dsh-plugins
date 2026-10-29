/** Local generated-Prisma smoke: pnpm --filter @amaster.ai/dsh-storage build, then node this file. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseBackend } from '../../../packages/dsh-storage/lib/backends/database.js';
import { PrismaClient } from '../../../packages/dsh-storage/lib/generated/sqlite/client.js';

const directory = await mkdtemp(join(tmpdir(), 'dsh-archive-sql-'));
const path = join(directory, 'test.db');
const db = new DatabaseSync(path);
// NOCASE models an existing case-insensitive database; logical session identity is still exact.
db.exec(`
  CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY, session_id TEXT COLLATE NOCASE NOT NULL, history_id TEXT,
    type TEXT NOT NULL, content TEXT NOT NULL, thoughts TEXT, model TEXT, tokens TEXT,
    tool_calls TEXT, agent_id TEXT, metadata TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, deleted_at INTEGER);
  CREATE TABLE ai_chat_histories (
    id TEXT PRIMARY KEY, session_id TEXT COLLATE NOCASE NOT NULL, title TEXT, summary TEXT,
    message_count INTEGER DEFAULT 0, total_tokens BIGINT DEFAULT 0,
    first_message_at INTEGER, last_message_at INTEGER, metadata TEXT, deleted_at INTEGER);
`);
const queries = [];
class LoggedClient extends PrismaClient {
  constructor(options) {
    super({ ...options, log: [{ emit: 'event', level: 'query' }] });
    this.$on('query', ({ query }) => queries.push(query));
  }
}
class LoggedBackend extends DatabaseBackend {
  async loadClient() {
    return LoggedClient;
  }
}
const backend = new LoggedBackend({ provider: 'sqlite', url: `file:${path}` });
try {
  await backend.init();
  for (const sessionId of ['Alice', 'alice']) {
    await backend.upsertMessage({
      id: `${sessionId}-message`, sessionId, historyId: null, type: 'user', content: 'small',
      createdAt: new Date(1700000000000),
    });
    await backend.upsertSession({ sessionId, messageCount: 1, totalTokens: 0 });
  }
  queries.length = 0;
  const historyId = await backend.archiveSession('Alice');
  assert.ok(historyId);
  const rows = db.prepare('SELECT session_id, history_id, updated_at FROM ai_messages ORDER BY session_id COLLATE BINARY').all();
  assert.equal(rows[0].session_id, 'Alice');
  assert.equal(rows[0].history_id, historyId);
  assert.equal(rows[1].session_id, 'alice');
  assert.equal(rows[1].history_id, null);
  assert.ok(Date.parse(rows[0].updated_at) > 1700000000000);
  const rollup = db.prepare('SELECT message_count, first_message_at, last_message_at FROM ai_chat_histories WHERE id = ?').get(historyId);
  assert.equal(rollup.message_count, 1);
  assert.equal(Date.parse(rollup.first_message_at), 1700000000000);
  assert.equal(Date.parse(rollup.last_message_at), 1700000000000);

  await backend.upsertMessage({
    id: 'later', sessionId: 'Alice', historyId: null, type: 'user', content: 'small',
    createdAt: new Date(1700000001000),
  });
  const before = db.prepare('SELECT COUNT(*) AS count FROM ai_chat_histories').get().count;
  db.exec(`CREATE TRIGGER refuse_archive BEFORE UPDATE OF history_id ON ai_messages
    WHEN OLD.history_id IS NULL BEGIN SELECT RAISE(IGNORE); END;`);
  await assert.rejects(backend.archiveSession('Alice'), /active messages changed/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_chat_histories').get().count, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_messages WHERE history_id IS NULL').get().count, 2);
  assert.ok(queries.some(query => /SELECT COUNT\(\*\).*AS message_count/s.test(query)));
  assert.ok(queries.some(query => /^UPDATE ai_messages SET history_id/.test(query)));
  assert.ok(queries.some(query => /ROLLBACK/.test(query)));
  for (const query of queries) assert.doesNotMatch(query, /\(\s*SELECT\b|\bJOIN\b/i);
  console.log(`PASS: ${queries.length} actual Prisma SQL statements; exact-case archive, rollback, timestamps, no nested SELECT/JOIN.`);
} finally {
  await backend.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
}
