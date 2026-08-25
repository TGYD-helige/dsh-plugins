/**
 * dsh-langfuse integration scenario (base leg only — no provider variants):
 * boot the dsh headless profile with the packed plugin pointed at an
 * in-process fake Langfuse ingestion endpoint, run one real LLM query
 * (deepseek-v4-flash through the integration gateway, seeded to force a tool
 * round-trip), then assert the trace/generation/span tree the plugin
 * ingested. No real Langfuse instance and no extra secrets: the fake
 * endpoint captures POST /api/public/ingestion batches in memory, and the
 * plugin's publicKey/secretKey are placeholders it never checks.
 *
 * The query runs via async spawn on purpose: the fake endpoint lives in THIS
 * process, so the event loop must stay responsive while dsh runs (a
 * spawnSync there would deadlock the SDK's shutdown flush).
 *
 * Contract with .github/workflows/integration.yml:
 *   env in : DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL
 *   env opt: DSH_HOME (default <workdir>/dsh-home), DSH_CLI (default 'dsh'),
 *            RUNNER_TEMP (default os.tmpdir())
 *   exit   : non-zero on any failure
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-langfuse-e2e');
mkdirSync(workDir, { recursive: true });
const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
const dsh = process.env.DSH_CLI ?? 'dsh';

const { DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL } = process.env;
for (const name of ['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY', 'DSH_PKG_TARBALL']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// --- fake Langfuse ingestion endpoint --------------------------------------
// The v3 SDK posts { batch: [{ id, type, timestamp, body }] } to
// /api/public/ingestion; keep every (type, body) pair in memory. Any other
// call 404s loudly — a surprise endpoint means the SDK drifted from the
// envelope this scenario asserts on. unref'd so the process can always exit.
const captured = [];
const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/api/public/ingestion')) {
    console.log(`::warning::unexpected ${req.method} ${req.url}`);
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for (const item of payload.batch ?? []) captured.push({ type: item.type, body: item.body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"successes":[],"errors":[]}');
  });
});
server.unref();
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`fake langfuse ingestion at ${baseUrl}`);

// If the runner routes egress through a host-level proxy, fetch to the
// gateway can break — drop proxy vars from the LLM-carrying process.
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

// 1. Install the packed bundle (idempotent — the workflow's Stage A already
//    did it once), then the langfuse peer: the profile template sets
//    autoInstallPeers: false, so runtime peers are added explicitly. The
//    dsh-* peers ship with the profile itself.
run(dsh, ['plugin', '--profile', 'headless', 'add', resolve(DSH_PKG_TARBALL)], dshHomeEnv);
run(dsh, ['plugin', '--profile', 'headless', 'add', 'langfuse@3.38.20'], dshHomeEnv);

// 2. Enable the plugin through the profile's user patch layer (an
//    id-targeted row replaces the bundle row's whole config), pointed at the
//    fake endpoint. The agent-default-model row pins deepseek-v4-flash; the
//    llm-deepseek row disables thinking — with reasoning enabled, this
//    gateway stochastically garbles tool calls (observed in CI).
const patchPath = join(dshHome, 'profiles', 'headless', 'cordis.patch.yml');
writeFileSync(
  patchPath,
  `# dsh-langfuse integration scenario: enable the plugin against the fake ingestion endpoint.
- id: langfuse
  config:
    enabled: true
    publicKey: pk-lf-ci
    secretKey: sk-lf-ci
    baseUrl: ${baseUrl}

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

- id: llm-deepseek
  config:
    thinking: disabled
`,
);
console.log(`--- ${patchPath} ---\n${readFileSync(patchPath, 'utf8')}`);

// 3. One real query, seeded to force a tool round-trip: the marker file's
//    unique content can only reach a tool span through a real dispatch (see
//    dsh-storage's scenario for the retry rationale — same model variance).
const markerFile = 'ci-marker.txt';
const markerContent = 'ci-dsh-langfuse-marker-5566';
writeFileSync(join(workDir, markerFile), `${markerContent}\n`);
const prompt = `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`;

function runQuery() {
  console.log(`\n$ dsh --profile headless "${prompt}"`);
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    const child = spawn(dsh, ['--profile', 'headless', prompt], {
      cwd: workDir,
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
    child.stdout.on('data', (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', rejectRun);
    const killer = setTimeout(() => child.kill('SIGKILL'), 8 * 60_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return rejectRun(new Error(`dsh headless exited ${code}`));
      if (!stdout.trim()) console.log('::warning::empty answer from dsh headless');
      resolveRun();
    });
  });
}

const spans = () => captured.filter((e) => e.type === 'span-create').map((e) => e.body);
const markerSpan = () =>
  spans().find(
    (b) => String(b.name).startsWith('tool:') && JSON.stringify(b.input ?? '').includes(markerFile),
  );

for (let attempt = 1; attempt <= 3; attempt++) {
  // Each attempt is a fresh session; judge it on its own ingest.
  captured.length = 0;
  console.log(`\n(attempt ${attempt})`);
  await runQuery();
  if (markerSpan()) break;
  console.log('::warning::attempt produced no marker-bearing tool span');
}

// 4. Assert the ingested tree. The SDK envelope is upsert-based: creates and
//    later updates share the observation id, so match follow-ups loosely by
//    id instead of betting on exact event-type spellings.
console.log(`\n--- captured ${captured.length} ingestion events ---`);
for (const e of captured) console.log(` ${e.type} ${JSON.stringify(e.body).slice(0, 160)}`);

const traces = captured.filter((e) => e.type === 'trace-create').map((e) => e.body);
const generations = captured.filter((e) => e.type === 'generation-create').map((e) => e.body);

const trace = traces.find((b) => b.name === 'dsh-turn' && b.sessionId);
assert(trace, 'no dsh-turn trace with a sessionId was ingested');
const traceEvents = captured.filter((e) => e.body?.id === trace.id);

const generation = generations.find((b) => b.traceId === trace.id && b.model === 'deepseek-v4-flash');
assert(generation, 'no deepseek-v4-flash generation under the turn trace');
const ended = captured.find((e) => e.body?.id === generation.id && (e.body.usage || e.body.usageDetails));
assert(ended, 'generation never closed with token usage');
const totalTokens = ended.body.usage?.total ?? ended.body.usageDetails?.total ?? 0;
assert(totalTokens > 0, `generation total token usage is ${totalTokens}`);

const toolSpan = markerSpan();
assert(toolSpan, 'no marker-bearing tool span — the model did not read the marker file');
assert(toolSpan.traceId === trace.id, 'tool span is not parented under the turn trace');

// Turn-boundary metadata rides session events near process teardown — useful
// signal, but the exact flush timing is dsh's business: warn, don't gate.
if (!traceEvents.some((e) => e.body?.metadata?.endReason)) {
  console.log('::warning::turn trace has no endReason metadata');
}
if (!traceEvents.some((e) => JSON.stringify(e.body?.input ?? '').includes(markerFile))) {
  console.log('::warning::turn trace input does not mention the marker file');
}

console.log(
  `\nSCENARIO_OK (events=${captured.length}, traces=${traces.length}, generations=${generations.length}, spans=${spans().length})`,
);
server.close();
