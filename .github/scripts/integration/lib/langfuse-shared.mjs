/**
 * Shared machinery for the dsh-langfuse integration legs. A leg is a thin
 * script declaring its case; `runScenario` does the rest:
 *
 * - real mode (LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY present): boot the
 *   dsh headless profile with the packed plugin pointed at the REAL Langfuse
 *   project, run each phase's seeded LLM query (deepseek-v4-flash, a marker
 *   file forces a tool round-trip), then poll the v1 Observations API until
 *   the ingested trace shows the expected shape — the data is really in
 *   Langfuse.
 * - fake mode (LANGFUSE_* absent): same boot against an in-process fake
 *   ingestion endpoint with in-memory assertions, so the leg still proves the
 *   plugin wiring without a Langfuse instance. Note fork PRs never reach
 *   these scripts at all — Stage B is gated on the DSH_INTEGRATION_* secrets,
 *   which forks don't receive; fake mode covers LANGFUSE-keyless same-repo
 *   runs and local development.
 *
 * The query runs via async spawn: in fake mode the endpoint lives in THIS
 * process, so the event loop must stay responsive while dsh runs.
 *
 * Contract with .github/workflows/integration.yml:
 *   env in : DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL
 *   env opt: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL,
 *            DSH_HOME (default <workdir>/dsh-home), DSH_CLI (default 'dsh'),
 *            RUNNER_TEMP (default os.tmpdir()),
 *            GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT (codeword uniqueness)
 *   exit   : non-zero on any failure
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Real-Langfuse verification (v1 Observations API — v2 observations is
// cloud/self-hosted-v4 only, and the deprecated /api/public/traces read path
// is never used; works on self-hosted v3 and cloud alike). Ingestion lands
// piecemeal, so a poll that finds the trace but not the full shape is
// retried, never failed immediately; 429s honor Retry-After (org-shared rate
// limits); other 4xx are unhealable client errors and fail fast with a
// bounded slice of the validation body. Ported from pi's
// telemetry-langfuse-verify.mjs.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';
const VERIFY_DEADLINE_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;
const EXPECTED_MODEL = 'deepseek-v4-flash';

// Non-empty trimmed value or fallback — GitHub injects unset secrets as '',
// which `??` would happily keep.
function envOr(value, fallback) {
  return value?.trim() || fallback;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** The llm-request span's collected chunk stream (its output), or []. */
function requestChunks(observations) {
  const requestSpan = observations.find((o) => o.type === 'SPAN' && o.name === 'llm-request');
  return Array.isArray(requestSpan?.output) ? requestSpan.output : [];
}

// Returns a list of problems; empty list means the trace fully matches.
export function evaluateTrace(observations, codeword) {
  const spans = observations.filter((o) => o.type === 'SPAN');
  const generations = observations.filter((o) => o.type === 'GENERATION');
  const problems = [];
  const need = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const generation = generations.find(
    // The plugin renames generations to `llm-call [<first line>]` at close,
    // so match by prefix — and skip purpose calls (`metadata.purpose`), which
    // share the prefix form (`llm-call [session-title]`).
    (o) => o.name?.startsWith('llm-call') && o.metadata?.purpose == null,
  );
  need(generation, 'missing main "llm-call*" generation');
  if (generation) {
    need(
      generation.model === EXPECTED_MODEL,
      `generation model is ${generation.model ?? 'null'}, expected ${EXPECTED_MODEL}`,
    );
    need(generation.endTime != null, 'generation "llm-call" has no endTime (never completed)');
    need(
      generation.parentObservationId == null,
      'generation "llm-call" is not parented at the trace root',
    );
    const total = generation.usage?.total ?? generation.usageDetails?.total ?? 0;
    need(total > 0, `generation "llm-call" total token usage is ${total}`);
  }

  const toolSpan = spans.find(
    (o) => o.name?.startsWith('tool:') && JSON.stringify(o.input ?? '').includes(codeword),
  );
  need(toolSpan, 'missing codeword-bearing "tool:*" span');
  if (toolSpan) {
    need(toolSpan.endTime != null, `"${toolSpan.name}" span has no endTime (never completed)`);
    need(
      toolSpan.parentObservationId == null,
      `"${toolSpan.name}" span is not parented at the trace root`,
    );
  }

  const requestSpan = spans.find((o) => o.name === 'llm-request');
  need(requestSpan, 'missing nested "llm-request" span');
  if (requestSpan && generation) {
    need(
      requestSpan.parentObservationId === generation.id,
      '"llm-request" span is not parented under the generation',
    );
    need(requestSpan.endTime != null, '"llm-request" span has no endTime (never completed)');
    need(requestChunks(observations).length > 0, '"llm-request" span has no response chunks');
  }
  return problems;
}

// Reasoning content lands as reasoning-delta chunks in the llm-request span's
// raw stream output. The scenario runs thinking at max effort, so it must be
// there.
export function evaluateReasoning(observations) {
  return requestChunks(observations).some((c) => c?.type === 'reasoning-delta')
    ? []
    : ['"llm-request" span output has no reasoning-delta chunk (thinking should be enabled at max)'];
}

// The subagent shape: the delegation tool call, the subagent span parented
// under it, and the child's own generation + tool span nested one level
// deeper — all inside the ONE parent trace (a child leaking its own trace
// fails the delegation-span check).
export function evaluateSubagentTrace(observations, codeword) {
  const spans = observations.filter((o) => o.type === 'SPAN');
  const generations = observations.filter((o) => o.type === 'GENERATION');
  const problems = [];
  const need = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const delegation = spans.find((o) => o.name?.startsWith('tool:subagent'));
  need(delegation, 'missing delegation "tool:subagent*" span');
  if (delegation) {
    need(delegation.endTime != null, 'delegation span has no endTime (never completed)');
    need(
      delegation.parentObservationId == null,
      'delegation span is not parented at the trace root',
    );
  }

  const subSpan = spans.find((o) => o.name === 'subagent' || o.name?.startsWith('subagent:'));
  need(subSpan, 'missing "subagent" span');
  if (subSpan && delegation) {
    need(
      subSpan.parentObservationId === delegation.id,
      '"subagent" span is not parented under the delegation span',
    );
    need(subSpan.endTime != null, '"subagent" span has no endTime (never completed)');
  }

  const childGeneration = generations.find((o) => subSpan && o.parentObservationId === subSpan.id);
  need(childGeneration, 'no generation nested under the "subagent" span');
  if (childGeneration) {
    need(
      childGeneration.model === EXPECTED_MODEL,
      `child generation model is ${childGeneration.model ?? 'null'}, expected ${EXPECTED_MODEL}`,
    );
    need(childGeneration.endTime != null, 'child generation has no endTime (never completed)');
  }

  const childTool = spans.find(
    (o) =>
      subSpan &&
      o.parentObservationId === subSpan.id &&
      o.name?.startsWith('tool:') &&
      JSON.stringify(o.input ?? '').includes(codeword),
  );
  need(childTool, 'no codeword-bearing tool span under the "subagent" span');
  return problems;
}

// Fake-mode captures are upsert envelopes ({type, body} sharing observation
// ids); fold them into the observation shape the evaluators consume. Span and
// generation bodies never carry a `type` of their own, so it doubles as the
// observation kind.
function capturedToObservations(captured) {
  const byId = new Map();
  for (const e of captured) {
    if (!e.body?.id || !/^(span|generation)-/.test(e.type)) continue;
    const kind = e.type.startsWith('generation-') ? 'GENERATION' : 'SPAN';
    byId.set(e.body.id, { ...byId.get(e.body.id), ...e.body, type: kind });
  }
  return [...byId.values()];
}

// Polls the v1 Observations API until a codeworded generation's trace matches
// the expected shape or the deadline passes. Returns { ok, state }.
async function runVerification({ baseUrl, publicKey, secretKey, fromStartTime, codeword, evaluate }) {
  const origin = baseUrl.replace(/\/+$/, '');
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;

  async function fetchObservations(params) {
    const rows = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      // Small pages on purpose: the API docs warn that large page sizes
      // trigger request errors on some deployments.
      const query = new URLSearchParams({
        fromStartTime,
        limit: '100',
        page: String(page),
        ...params,
      });
      // A hung fetch must not outlive the polling deadline.
      const remaining = deadline - Date.now();
      const response = await fetch(`${origin}/api/public/observations?${query}`, {
        headers: { authorization: auth, accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(1000, remaining))),
      });
      // 4xx is a client error that never heals by retrying — fail fast, and
      // include a bounded slice of the validation body (it quotes the query,
      // never the auth header) so the CI log shows the actual complaint.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const detail = (await response.text()).slice(0, 300);
        throw Object.assign(
          new Error(`Langfuse observations query rejected (HTTP ${response.status}): ${detail}`),
          { fatal: true },
        );
      }
      if (response.status === 429) {
        // Rate limits are shared per organization — honor Retry-After
        // instead of burning the deadline on failures.
        const retryAfterSeconds = Number(response.headers.get('retry-after'));
        const retryAfterMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 120_000)
            : POLL_INTERVAL_MS;
        throw Object.assign(new Error('Langfuse rate limited the observations query (HTTP 429)'), {
          retryAfterMs,
        });
      }
      if (!response.ok) {
        // Status only — a 5xx body can carry request details or internals.
        throw new Error(`Langfuse observations query failed with HTTP ${response.status}`);
      }
      // Parse manually: response.json() error messages embed a snippet of the
      // response body, which must never reach the CI log.
      let body;
      try {
        body = JSON.parse(await response.text());
      } catch {
        throw new Error('Langfuse observations query returned invalid JSON');
      }
      rows.push(...(body.data ?? []));
      if (page >= (body.meta?.totalPages ?? 1)) return rows;
    }
    throw new Error(`Langfuse observations query exceeded ${MAX_PAGES} pages`);
  }

  let lastState = 'no candidate trace seen yet';
  while (true) {
    let waitMs = POLL_INTERVAL_MS;
    try {
      // Discovery: the turn's generation carries the codeword in its IO (the
      // prompt mentions the marker file; tool-call arguments repeat it). No
      // server-side name filter — generations are renamed `llm-call [<first
      // line>]` at close, so exact-name queries would miss them; the prefix
      // and the run-unique codeword do the filtering client-side.
      const candidates = await fetchObservations({ type: 'GENERATION' });
      const traceIds = [
        ...new Set(
          candidates
            .filter(
              (o) => o.name?.startsWith('llm-call') && JSON.stringify(o).includes(codeword),
            )
            .map((o) => o.traceId),
        ),
      ];

      for (const traceId of traceIds) {
        const observations = await fetchObservations({ traceId });
        console.log(`--- candidate trace ${traceId}: ${observations.length} observation(s) ---`);
        for (const o of observations) {
          console.log(`  ${o.type}:${o.name} parent=${o.parentObservationId ?? 'null'} end=${o.endTime ?? 'null'}`);
        }
        const problems = evaluate(observations, codeword);
        if (problems.length === 0) {
          return { ok: true, state: `trace ${traceId} matches the expected dsh-langfuse shape` };
        }
        lastState = `trace ${traceId} incomplete: ${problems.join('; ')}`;
        console.log(`  not complete yet: ${problems.join('; ')}`);
      }
      if (traceIds.length === 0) {
        lastState = 'no trace with the codeword seen yet';
      }
    } catch (error) {
      console.log(`Langfuse poll failed: ${error.message}`);
      lastState = `poll error: ${error.message}`;
      // Fatal errors (e.g. a route that does not exist) abort the whole
      // verification now instead of timing out the deadline.
      if (error.fatal) return { ok: false, state: lastState };
      if (error.retryAfterMs) waitMs = error.retryAfterMs;
    }

    if (Date.now() > deadline) {
      return { ok: false, state: lastState };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(waitMs, Math.max(0, deadline - Date.now()))),
    );
  }
}

// In-process fake Langfuse endpoint for the secrets-free mode: captures
// POST /api/public/ingestion batches in memory; anything else 404s loudly.
async function startFakeIngestion(captured) {
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
  return server;
}

/**
 * Run one leg to green: { tag, name, prompt, evaluate }. The marker file
 * `${codeword}.txt` is written into the workspace and its name is the
 * codeword the leg verifies on. Failures log `::error::` and exit non-zero.
 */
export async function runScenario(opts) {
  try {
    await scenarioMain(opts);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

async function scenarioMain({ tag, name, prompt, evaluate }) {
  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), `dsh-langfuse-${tag}-e2e`);
  mkdirSync(workDir, { recursive: true });
  const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
  const dsh = process.env.DSH_CLI ?? 'dsh';

  const { DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL } = process.env;
  for (const name of ['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY', 'DSH_PKG_TARBALL']) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }

  const publicKey = envOr(process.env.LANGFUSE_PUBLIC_KEY, '');
  const secretKey = envOr(process.env.LANGFUSE_SECRET_KEY, '');
  const realMode = Boolean(publicKey && secretKey);
  const baseUrl = envOr(process.env.LANGFUSE_BASE_URL, DEFAULT_BASE_URL);
  console.log(`mode: ${realMode ? `real Langfuse (${baseUrl})` : 'fake ingestion endpoint'}`);

  // Fake mode only: the capture sink the assertions read from.
  const captured = [];
  let pluginConnection;
  if (realMode) {
    // YAML-double-quoted scalars are JSON-compatible — keys can't break the
    // patch. NEVER log the patch in this mode: it carries the real keys.
    pluginConnection = {
      publicKey: JSON.stringify(publicKey),
      secretKey: JSON.stringify(secretKey),
      baseUrl: JSON.stringify(baseUrl),
    };
  } else {
    const fakeServer = await startFakeIngestion(captured);
    const fakeUrl = `http://127.0.0.1:${fakeServer.address().port}`;
    console.log(`fake langfuse ingestion at ${fakeUrl}`);
    pluginConnection = { publicKey: 'pk-lf-ci', secretKey: 'sk-lf-ci', baseUrl: fakeUrl };
  }

  // If the runner routes egress through a host-level proxy, fetch to the
  // gateway can break — drop proxy vars from the LLM-carrying process.
  const netEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)),
  );

  function run(cmd, args, env = {}) {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, {
      stdio: 'inherit',
      cwd: workDir,
      env: { ...process.env, ...env },
    });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${r.status}`);
  }

  const dshHomeEnv = { DSH_HOME: dshHome };

  // Install the packed bundle (idempotent — the workflow's Stage A already
  // did it once), then the langfuse peer: the profile template sets
  // autoInstallPeers: false, so runtime peers are added explicitly. The
  // dsh-* peers ship with the profile itself.
  run(dsh, ['plugin', '--profile', 'headless', 'add', resolve(DSH_PKG_TARBALL)], dshHomeEnv);
  run(dsh, ['plugin', '--profile', 'headless', 'add', 'langfuse@3.38.20'], dshHomeEnv);

  // Enable the plugin through the profile's user patch layer (an id-targeted
  // row replaces the bundle row's whole config). The agent-default-model row
  // pins deepseek-v4-flash; the llm-deepseek row turns thinking ON at max
  // effort — reasoning content must land in Langfuse (reasoning-delta chunks
  // in the raw stream). Caveat: reasoning enabled makes this gateway
  // stochastically garble or hang on tool calls (observed in CI) — the retry
  // loop absorbs it.
  const patchPath = join(dshHome, 'profiles', 'headless', 'cordis.patch.yml');
  writeFileSync(
    patchPath,
    `# dsh-langfuse integration scenario (${tag}): enable the plugin against ${realMode ? 'the real Langfuse' : 'the fake endpoint'}.
- id: langfuse
  config:
    enabled: true
    publicKey: ${pluginConnection.publicKey}
    secretKey: ${pluginConnection.secretKey}
    baseUrl: ${pluginConnection.baseUrl}

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

- id: llm-deepseek
  config:
    thinking: enabled
    reasoningEffort: max
`,
  );
  if (!realMode) console.log(`--- ${patchPath} ---\n${readFileSync(patchPath, 'utf8')}`);
  // The patch carries the real keys in real mode — it must not outlive the
  // scenario (CI uploads artifacts from the runner; process 'exit' also
  // covers the throw paths).
  process.once('exit', () => rmSync(patchPath, { force: true }));

  // Marker FILE NAMES are the codewords: they flow into tool-span inputs and
  // generation IO, and are unique per leg × CI run so concurrent legs against
  // the same Langfuse project can't cross-match.
  const runId = envOr(process.env.GITHUB_RUN_ID, 'local');
  const runAttempt = envOr(process.env.GITHUB_RUN_ATTEMPT, '1');
  const codeword = `ci-marker-${tag}-${runId}-${runAttempt}`;
  const runStartedAt = new Date(Date.now() - 60_000).toISOString();

  function runQuery(prompt) {
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

  // deepseek-v4-flash through the gateway stochastically garbles tool calls
  // (observed in CI), so attempts retry. Fake mode gates on the captured
  // shapes via the same evaluator; real mode gates on the Langfuse read-back.
  const maxAttempts = realMode ? 2 : 3;
  async function runPhase(prompt, codeword) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`\n(${name} attempt ${attempt}/${maxAttempts})`);
      captured.length = 0;
      await runQuery(prompt);
      let result;
      if (realMode) {
        result = await runVerification({
          baseUrl,
          publicKey,
          secretKey,
          fromStartTime: runStartedAt,
          codeword,
          evaluate,
        });
      } else {
        const problems = evaluate(capturedToObservations(captured), codeword);
        result =
          problems.length === 0
            ? { ok: true, state: 'captured shape matches' }
            : { ok: false, state: problems.join('; ') };
      }
      if (result.ok) return result;
      console.log(`::warning::${name} attempt ${attempt} did not verify: ${result.state}`);
    }
    return { ok: false, state: `${name}: attempts exhausted` };
  }

  const markerFile = `${codeword}.txt`;
  writeFileSync(join(workDir, markerFile), `${codeword}-content\n`);
  const result = await runPhase(prompt(markerFile), codeword);
  assert(result.ok, `${name} failed: ${result.state}`);

  if (!realMode) {
    // Fake mode: the loop already proved the shape; the trace itself is the
    // one thing the evaluators (observation-scoped) don't cover.
    console.log(`\n--- captured ${captured.length} ingestion events ---`);
    for (const e of captured) console.log(` ${e.type} ${JSON.stringify(e.body).slice(0, 160)}`);
    const trace = captured.find(
      (e) => e.type === 'trace-create' && e.body?.name === 'dsh-turn' && e.body?.sessionId,
    )?.body;
    assert(trace, 'no dsh-turn trace with a sessionId was ingested');
  }

  console.log(`\nSCENARIO_OK (${name}: ${result.state})`);
}
