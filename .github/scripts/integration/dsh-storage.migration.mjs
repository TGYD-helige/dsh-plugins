/** Real SQLite upgrade: required legacy user_id → create_by, then mirror writes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(fileURLToPath(new URL('../../../packages/dsh-storage/', import.meta.url)));
const dir = mkdtempSync(join(packageDir, '.tmp-migration-'));
try {
  const dbPath = join(dir, 'legacy.db');
  const url = `file:${dbPath}`;
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE ai_chat_histories (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
    title TEXT, summary TEXT, message_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0, first_message_at TEXT,
    last_message_at TEXT, metadata TEXT, deleted_at TEXT
  );
  CREATE TABLE ai_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
    history_id TEXT, type TEXT NOT NULL, content TEXT NOT NULL, thoughts TEXT,
    model TEXT, tokens TEXT, tool_calls TEXT, agent_id TEXT, metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
  );`);
  db.exec("INSERT INTO ai_chat_histories (id, session_id, user_id) VALUES ('h1', 's1', 'old-user')");
  db.exec("INSERT INTO ai_messages (id, session_id, user_id, type, content) VALUES ('m1', 's1', 'old-user', 'user', 'before')");
  for (const table of ['ai_messages', 'ai_chat_histories']) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN create_by TEXT`);
    db.exec(`UPDATE ${table} SET create_by = user_id WHERE create_by IS NULL`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN user_id`);
  }
  db.close();

  const { DatabaseBackend } = await import(new URL('../../../packages/dsh-storage/lib/backends/database.js', import.meta.url));
  const backend = new DatabaseBackend({ provider: 'sqlite', url });
  await backend.init();
  await backend.upsertMessage({ id: 'm2', sessionId: 's1', createBy: 'platform-user', historyId: null, type: 'model', content: 'after', createdAt: new Date() });
  await backend.upsertSession({ sessionId: 's1', createBy: 'platform-user', messageCount: 2, totalTokens: 3 });
  await backend.close();

  const check = new DatabaseSync(dbPath, { readOnly: true });
  const messages = check.prepare('SELECT content, create_by FROM ai_messages ORDER BY content').all();
  const history = check.prepare('SELECT id, create_by, message_count, total_tokens FROM ai_chat_histories').get();
  check.close();
  if (JSON.stringify(messages) !== JSON.stringify([
    { content: 'after', create_by: 'platform-user' },
    { content: 'before', create_by: 'old-user' },
  ])) throw new Error(`migrated message rows wrong: ${JSON.stringify(messages)}`);
  if (history.id !== 'h1' || history.create_by !== 'platform-user' || history.message_count !== 2 || history.total_tokens !== 3) {
    throw new Error(`migrated history rollup wrong: ${JSON.stringify(history)}`);
  }
  console.log('SCENARIO_OK migrated SQLite insert and history rollup');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
