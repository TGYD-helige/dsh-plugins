/**
 * Shared machinery for the dsh-policy integration legs. A leg is a thin
 * script declaring its rules and expected signals; `runPolicyScenario` boots
 * the dsh headless profile with the packed plugin, runs one real LLM query
 * ($DSH_INTEGRATION_MODEL, default deepseek-v4-flash, through the integration
 * gateway), and asserts every `expectPresent` string lands in the answer —
 * deny/ask messages can only reach the model as the tool errors the
 * pre-execute gate materializes, so quoting them proves the gate fired.
 *
 * Matching semantics (segments, priorities, overrides, fail-closed ask) are
 * covered by the unit and pipeline tests; these legs prove the plugin wires
 * into a real dsh boot, one check per behavior.
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
import { integrationModel, netEnv, requireEnv, run } from './ci-shared.mjs';

export async function runPolicyScenario({ tag, name, rulesYaml, prompt, expectPresent, prepare, verify }) {
  try {
    await scenarioMain({ tag, name, rulesYaml, prompt, expectPresent, prepare, verify });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

async function scenarioMain({ tag, name, rulesYaml, prompt, expectPresent, prepare, verify }) {
  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), `dsh-policy-${tag}-e2e`);
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

  // 2. Enable the plugin through the profile's user patch layer (an
  //    id-targeted row replaces the bundle row's whole config). The
  //    agent-default-model row pins the integration model; llm-deepseek
  //    disables thinking (with reasoning on, this gateway stochastically
  //    garbles tool calls — observed in CI) and caps output for smaller-cap
  //    gateways.
  const patchPath = join(dshHome, 'profiles', 'headless', 'cordis.patch.yml');
  writeFileSync(
    patchPath,
    `# dsh-policy integration scenario (${tag}): ${name}.
- id: policy
  config:
    enabled: true
    rules:
${rulesYaml}

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

  // 3. deepseek-v4-flash through the gateway stochastically garbles or skips
  //    tool calls (observed in CI), so attempts retry until every expected
  //    signal lands. prepare() runs before EVERY attempt and must be
  //    idempotent — it is also the retry cleanup (e.g. removing side-effect
  //    files from a previous attempt).
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (prepare) prepare(workDir);
    console.log(`\n$ dsh --profile headless "${prompt}" (attempt ${attempt})`);
    const query = spawnSync(dsh, ['--profile', 'headless', prompt], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 8 * 60_000,
      env: {
        ...netEnv(),
        ...dshHomeEnv,
        DSH_TELEMETRY_DISABLED: '1',
        // Ephemeral CI workspace: never stall on tool approval prompts. This
        // is dsh's own permission knob — the policy plugin's rules fire
        // regardless (the ask leg relies on fail-closed here).
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
    const missing = expectPresent.filter((signal) => !out.includes(signal));
    const problems = [
      ...missing.map((signal) => `missing signal: ${signal}`),
      // Ground-truth checks beyond the answer text (e.g. filesystem side effects).
      ...(verify ? verify(workDir, out) : []),
    ];
    if (problems.length === 0) {
      console.log(`\nSCENARIO_OK (${tag}: ${name})`);
      return;
    }
    console.log(`::warning::attempt ${attempt} failed: ${problems.join(' | ')}`);
  }

  throw new Error(`${tag}: attempts exhausted — the policy gate did not show up in the run`);
}
