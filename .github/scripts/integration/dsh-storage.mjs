/**
 * dsh-storage integration scenario, two leg shapes driven by DSH_PROVIDER:
 *
 * - base leg (DSH_PROVIDER unset / 'sqlite'): boot the dsh headless profile
 *   with the packed plugin, run one real LLM query (deepseek-v4-flash through
 *   the integration gateway), then assert the session mirror landed in SQLite.
 * - backend-only leg (DSH_PROVIDER = mysql | postgresql | sqlserver): no dsh
 *   boot, no LLM, no secrets — db push the variant schema and drive
 *   DatabaseBackend against the service database in DSH_DB_URL.
 *
 * Contract with .github/workflows/integration.yml:
 *   env in : DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL (base leg)
 *            DSH_DB_URL (provider legs)
 *   env opt: DSH_PROVIDER, DSH_HOME (default <workdir>/dsh-home),
 *            DSH_CLI (default 'dsh'), RUNNER_TEMP (default os.tmpdir())
 *   exit   : non-zero on any failure
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-storage-e2e');
mkdirSync(workDir, { recursive: true });
const dbPath = join(workDir, 'dsh.db');
const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
const dsh = process.env.DSH_CLI ?? 'dsh';

const provider = process.env.DSH_PROVIDER || 'sqlite';
if (provider !== 'sqlite') {
  await backendOnlyLeg(provider);
  process.exit(0);
}

const { DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL } = process.env;
for (const name of ['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY', 'DSH_PKG_TARBALL']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

// If the runner routes egress through a host-level proxy, fetch to the
// gateway can break (pi's self-hosted integration jobs hit exactly that) —
// drop proxy vars from the LLM-carrying processes entirely.
const netEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)),
);

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: workDir, env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${r.status}`);
}

const dshHomeEnv = { DSH_HOME: dshHome };

// 1. Install the packed bundle — `dsh plugin` forwards to pnpm in the profile
//    directory and auto-registers any dependency with a dsh.bundle patch.
run(dsh, ['plugin', '--profile', 'headless', 'add', resolve(DSH_PKG_TARBALL)], dshHomeEnv);

// 2. The profile template sets autoInstallPeers: false, so the plugin's
//    runtime peers (Prisma 7 client + the sqlite driver adapter) must be
//    added explicitly. The PrismaClient itself ships pre-generated in the
//    bundle — no generate step here.
run(dsh, ['plugin', '--profile', 'headless', 'add', '@prisma/client@7.9.1', '@prisma/adapter-libsql@7.9.1'], dshHomeEnv);

// 3. Enable the sqlite mirror through the profile's user patch layer (an
//    id-targeted row replaces the bundle row's whole config). The template
//    file is one top-level YAML array (`[]`), so rewrite it wholesale. The
//    agent-default-model row restates the dsh-base default explicitly so the
//    scenario is pinned to deepseek-v4-flash rather than inheriting it.
const patchPath = join(dshHome, 'profiles', 'headless', 'cordis.patch.yml');
writeFileSync(
  patchPath,
  `# dsh-storage integration scenario: enable the sqlite mirror, pin the model.
- id: storage-mirror
  config:
    enabled: true
    database:
      enabled: true
      provider: sqlite
      url: file:${dbPath}

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
`,
);
console.log(`--- ${patchPath} ---\n${readFileSync(patchPath, 'utf8')}`);

// 4. Create the tables with the schema variant shipped in the bundle
//    (`db push --url` still works in Prisma 7; the URL moved out of the
//    schema only for config-file flows).
const schemaPath = join(
  dshHome,
  'profiles',
  'headless',
  'node_modules',
  'dsh-storage',
  'prisma',
  'schema.sqlite.prisma',
);
run('pnpm', ['dlx', 'prisma@7.9.1', 'db', 'push', '--schema', schemaPath, '--url', `file:${dbPath}`]);

// 5. One real query, seeded to force a tool round-trip: the marker file's
//    unique content can only reach the transcript through a tool result, so
//    the database assertions below prove the full
//    user → assistant(tool-call) → tool/result → assistant chain landed.
//    The gateway and key arrive through the adapter's documented env seams
//    (@deepseek-ai/dsh-llm-deepseek README: apiKeyEnv defaults to
//    DEEPSEEK_API_KEY, baseURL falls back to $DEEPSEEK_BASE_URL); the model
//    is pinned via the agent-default-model patch row above.
const markerFile = 'ci-marker.txt';
const markerContent = 'ci-dsh-storage-marker-7788';
writeFileSync(join(workDir, markerFile), `${markerContent}\n`);
const prompt = `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`;
console.log(`\n$ dsh --profile headless "${prompt}"`);
const query = spawnSync(dsh, ['--profile', 'headless', prompt], {
  cwd: workDir,
  encoding: 'utf8',
  timeout: 8 * 60_000,
  env: {
    ...netEnv,
    ...dshHomeEnv,
    DSH_TELEMETRY_DISABLED: '1',
    // Ephemeral CI workspace: never stall on tool approval prompts.
    DSH_PERMISSION_MODE: 'danger-full-access',
    DEEPSEEK_BASE_URL: DSH_INTEGRATION_BASE_URL,
    DEEPSEEK_API_KEY: DSH_INTEGRATION_API_KEY,
  },
});
process.stdout.write(query.stdout ?? '');
process.stderr.write(query.stderr ?? '');
if (query.error) throw query.error;
if (query.status !== 0) throw new Error(`dsh headless exited ${query.status}`);
if (!query.stdout?.trim()) throw new Error('empty answer from dsh headless');

// 6. Assert the mirror in SQLite.
console.log('\n--- ai_messages ---');
const db = new DatabaseSync(dbPath, { readOnly: true });
const messages = db
  .prepare('SELECT session_id, type, content, model, metadata, tool_calls FROM ai_messages ORDER BY rowid')
  .all();
for (const m of messages) {
  console.log(
    ` [${m.type}] model=${m.model ?? '-'} content=${JSON.stringify(String(m.content).slice(0, 80))} metadata=${m.metadata}`,
  );
}
console.log('--- ai_chat_histories ---');
const histories = db.prepare('SELECT * FROM ai_chat_histories').all();
for (const h of histories) console.log(` ${JSON.stringify(h)}`);
db.close();

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const user = messages.find((m) => m.type === 'user' && String(m.content).includes(markerFile));
const model = messages.find((m) => m.type === 'model' && String(m.content).length > 0);
assert(user, 'user message row with the prompt missing');
assert(model, 'assistant message row missing or empty');
assert(model.model === 'deepseek-v4-flash', `expected model=deepseek-v4-flash, got ${model.model}`);
for (const m of messages) {
  const meta = JSON.parse(m.metadata);
  assert(typeof meta.id === 'string' && meta.id.length > 0, `row missing metadata.id: ${m.metadata}`);
}

// The tool round-trip, proven from the database: the marker content only
// exists on disk, so it can only appear in the transcript via a tool result.
const toolCallIds = new Set();
for (const m of messages) {
  if (m.type !== 'model' || !m.tool_calls) continue;
  for (const block of JSON.parse(m.tool_calls)) toolCallIds.add(block.id);
}
// The model may call more than one tool — assert on the marker-bearing row,
// not whatever tool result happens to be first.
const tool = messages.find((m) => m.type === 'tool' && String(m.content).includes(markerContent));
assert(tool, 'no tool/result row contains the marker content — the model did not read the marker file');
assert(toolCallIds.size > 0, 'no tool-call block in any assistant row');
assert(
  toolCallIds.has(JSON.parse(tool.metadata).callId),
  `tool result callId ${JSON.parse(tool.metadata).callId} not in assistant tool-call ids ${[...toolCallIds]}`,
);
assert(
  messages.some((m) => m.type === 'model' && String(m.content).includes(markerContent)),
  'no assistant row repeated the marker content',
);

assert(histories.length === 1, `expected 1 session row, got ${histories.length}`);
const history = histories[0];
assert(history.session_id === user.session_id, 'session row id mismatch');
assert(Number(history.message_count) >= 4, `message_count=${history.message_count} < 4 (user + assistant/tool-call + tool + assistant)`);
assert(Number(history.total_tokens) > 0, `total_tokens=${history.total_tokens} == 0`);
assert(history.first_message_at != null && history.last_message_at != null, 'message timestamps missing');

console.log(`\nSCENARIO_OK (messages=${messages.length}, toolCalls=${toolCallIds.size}, title=${JSON.stringify(history.title)})`);

/**
 * Backend-only provider leg: db push the variant schema, drive
 * DatabaseBackend against the service database in DSH_DB_URL, and read the
 * rows back through the provider's own pre-generated client. No dsh boot,
 * no LLM, no secrets — the per-provider delta lives entirely in the
 * adapter/schema/read-write path this exercises.
 */
async function backendOnlyLeg(dbProvider) {
  const url = process.env.DSH_DB_URL;
  if (!url) throw new Error('DSH_DB_URL is required for provider legs');
  const pkgUrl = (rel) => new URL(`../../../packages/dsh-storage/${rel}`, import.meta.url);

  // 1. Create the tables with the shipped schema variant.
  run('pnpm', [
    'dlx',
    'prisma@7.9.1',
    'db',
    'push',
    '--schema',
    fileURLToPath(pkgUrl(`prisma/schema.${dbProvider}.prisma`)),
    '--url',
    url,
  ]);

  // 2. Write through the real backend (same code path as production).
  const { DatabaseBackend, createAdapter } = await import(pkgUrl('lib/backends/database.js').href);
  const backend = new DatabaseBackend({ provider: dbProvider, url });
  await backend.init();
  await backend.upsertMessage({
    id: 'm1',
    sessionId: 's1',
    historyId: null,
    type: 'user',
    content: `hello from ${dbProvider}`,
    metadata: { event: 'user/message', seq: 1 },
    createdAt: new Date(1700000000000),
  });
  await backend.upsertMessage({
    id: 'a1',
    sessionId: 's1',
    historyId: null,
    type: 'model',
    content: 'hi',
    thoughts: 'thinking…',
    model: 'deepseek-v4-flash',
    tokens: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
    metadata: { event: 'assistant/message', seq: 2 },
    createdAt: new Date(1700000001000),
  });
  // Redelivery must update in place, not duplicate (deterministic PK).
  await backend.upsertMessage({
    id: 'm1',
    sessionId: 's1',
    historyId: null,
    type: 'user',
    content: `hello from ${dbProvider} (edited)`,
    metadata: { event: 'user/message', seq: 1 },
    createdAt: new Date(1700000000000),
  });
  await backend.upsertSession({
    sessionId: 's1',
    title: 'CI',
    messageCount: 2,
    totalTokens: 15,
    firstMessageAt: new Date(1700000000000),
    lastMessageAt: new Date(1700000001000),
  });

  // 3. Read back through the provider's own generated client + adapter.
  const { PrismaClient } = await import(pkgUrl(`lib/generated/${dbProvider}/client.js`).href);
  const prisma = new PrismaClient({ adapter: await createAdapter({ provider: dbProvider, url }) });
  const messages = await prisma.aiMessage.findMany({ orderBy: { createdAt: 'asc' } });
  const sessions = await prisma.aiChatHistory.findMany();
  for (const m of messages) console.log(` [${m.type}] ${JSON.stringify(m.content)} tokens=${JSON.stringify(m.tokens)}`);
  for (const h of sessions) console.log(` history title=${JSON.stringify(h.title)} count=${h.messageCount} tokens=${h.totalTokens}`);
  await prisma.$disconnect();
  await backend.close();

  const parseJsonColumn = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  assert(messages.length === 2, `expected 2 messages, got ${messages.length}`);
  assert(messages[0].content === `hello from ${dbProvider} (edited)`, 'redelivery did not update in place');
  assert(parseJsonColumn(messages[1].metadata).id === 'a1', 'metadata did not round-trip');
  assert(parseJsonColumn(messages[1].tokens).inputTokens === 10, 'tokens did not round-trip');
  assert(sessions.length === 1 && Number(sessions[0].totalTokens) === 15, 'session rollup wrong');

  console.log(`SCENARIO_OK ${dbProvider} (backend-only leg)`);
}
