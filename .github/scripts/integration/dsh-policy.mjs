/**
 * dsh-policy integration scenario: boot the dsh headless profile with the
 * packed plugin and one real LLM query ($DSH_INTEGRATION_MODEL, default
 * deepseek-v4-flash, through the integration gateway), then assert from the
 * model's own answer that
 *
 *   1. an uncovered command still executes (policy pass-through default), and
 *   2. a denied command never ran — its `message` could only reach the model
 *      as the materialized tool error produced by the pre-execute gate.
 *
 * Matching semantics (segments, priorities, overrides, ask fail-closed) are
 * covered by the unit and pipeline tests; this leg proves the plugin wires
 * into a real dsh boot.
 *
 * Contract with .github/workflows/integration.yml:
 *   env in : DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL
 *   env opt: DSH_INTEGRATION_MODEL, DSH_HOME (default <workdir>/dsh-home),
 *            DSH_CLI (default 'dsh'), RUNNER_TEMP (default os.tmpdir())
 *   exit   : non-zero on any failure
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrationModel, netEnv, requireEnv, run } from './lib/ci-shared.mjs';

const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-policy-e2e');
mkdirSync(workDir, { recursive: true });
const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
const dsh = process.env.DSH_CLI ?? 'dsh';

const { DSH_INTEGRATION_BASE_URL, DSH_INTEGRATION_API_KEY, DSH_PKG_TARBALL } = process.env;
requireEnv(['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY', 'DSH_PKG_TARBALL']);
const expectedModel = integrationModel();

const dshHomeEnv = { DSH_HOME: dshHome };

// 1. Install the packed bundle (idempotent — the workflow's Stage A already
//    did it once). The dsh-* peers ship with the profile itself.
run(dsh, ['plugin', '--profile', 'headless', 'add', resolve(DSH_PKG_TARBALL)], { cwd: workDir, env: dshHomeEnv });

// 2. Enable the plugin through the profile's user patch layer (an id-targeted
//    row replaces the bundle row's whole config). The scenario pins one deny
//    rule with a unique message — that string can only reach the model as the
//    tool error the pre-execute gate materializes. The agent-default-model
//    row pins the integration model; llm-deepseek disables thinking (with
//    reasoning on, this gateway stochastically garbles tool calls — observed
//    in CI) and caps output for smaller-cap gateways.
const DENY_MESSAGE = 'npm is not allowed by dsh-policy E2E';
const patchPath = join(dshHome, 'profiles', 'headless', 'cordis.patch.yml');
writeFileSync(
  patchPath,
  `# dsh-policy integration scenario: one deny rule over the default allow.
- id: policy
  config:
    enabled: true
    rules:
      - tool: '*'
        decision: allow
        priority: 20
      - tool: bash
        decision: deny
        commandPrefix: npm
        priority: 200
        message: '${DENY_MESSAGE}'

- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${expectedModel}

- id: llm-deepseek
  config:
    thinking: disabled
    # Scenarios need only short answers; dsh's 256000 default is rejected by
    # smaller-cap models (glm-5.3-flash caps max_tokens at 131072).
    maxTokens: 16384
`,
);
console.log(`--- ${patchPath} ---\n${readFileSync(patchPath, 'utf8')}`);

// 3. One real query: the echo half proves an uncovered command still runs
//    under an enabled policy; the npm half can only mention the deny message
//    if the gate fired and the materialized error reached the model.
const prompt =
  '请依次用 bash 工具执行两条命令并分别汇报结果：1) echo hello-from-ci 2) npm --version。如果某条命令被拒绝，请原样引用拒绝原因。';

// deepseek-v4-flash through the gateway stochastically garbles or skips tool
// calls (observed in CI), so attempts retry until both signals land.
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`\n$ dsh --profile headless "${prompt}" (attempt ${attempt})`);
  const query = spawnSync(dsh, ['--profile', 'headless', prompt], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 8 * 60_000,
    env: {
      ...netEnv(),
      ...dshHomeEnv,
      DSH_TELEMETRY_DISABLED: '1',
      // Ephemeral CI workspace: never stall on tool approval prompts. This is
      // dsh's own permission knob — the policy plugin's deny fires regardless.
      DSH_PERMISSION_MODE: 'danger-full-access',
      DEEPSEEK_BASE_URL: DSH_INTEGRATION_BASE_URL,
      DEEPSEEK_API_KEY: DSH_INTEGRATION_API_KEY,
    },
  });
  process.stdout.write(query.stdout ?? '');
  process.stderr.write(query.stderr ?? '');
  if (query.error) throw query.error;
  if (query.status !== 0) throw new Error(`dsh headless exited ${query.status}`);
  const out = query.stdout ?? '';
  const echoRan = out.includes('hello-from-ci');
  const npmDenied = out.includes(DENY_MESSAGE);
  if (echoRan && npmDenied) {
    console.log(`\nSCENARIO_OK (echo executed; npm denied with the policy message)`);
    process.exit(0);
  }
  console.log(
    `::warning::attempt ${attempt} incomplete: echo ran=${echoRan}, npm deny visible=${npmDenied}`,
  );
}

throw new Error('attempts exhausted: the policy gate did not show up in the run');
