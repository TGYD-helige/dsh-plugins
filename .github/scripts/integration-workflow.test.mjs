import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as integration from './integration/lib/ci-shared.mjs';

const workflow = readFileSync(new URL('../workflows/integration.yml', import.meta.url), 'utf8');

test('Langfuse release identifies the tested PR head instead of the pull_request_target base', () => {
  const keys = ['INTEGRATION_CHECKOUT_REF', 'GITHUB_SHA'];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.GITHUB_SHA = 'base-sha';
    process.env.INTEGRATION_CHECKOUT_REF = 'head-sha';
    assert.equal(integration.integrationRevision(), 'head-sha');
    delete process.env.INTEGRATION_CHECKOUT_REF;
    assert.equal(integration.integrationRevision(), 'base-sha');
    delete process.env.GITHUB_SHA;
    assert.equal(integration.integrationRevision(), 'local');
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('fork E2E uses one approval gate before running the exact PR revision with secrets', () => {
  assert.match(workflow, /\n {2}pull_request_target:\n/);
  assert.doesNotMatch(workflow, /\n {2}pull_request:\n/);
  assert.match(workflow, /group:.*github\.event\.pull_request\.number \|\| github\.ref/);
  assert.match(
    workflow,
    /INTEGRATION_CHECKOUT_REPOSITORY:.*github\.event\.pull_request\.head\.repo\.full_name/,
  );
  assert.match(workflow, /INTEGRATION_CHECKOUT_REF:.*github\.event\.pull_request\.head\.sha/);

  const approval = workflow.match(
    /^ {2}integration-approval:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m,
  )?.[0];
  assert.ok(approval, 'secret-backed scenarios need a shared approval job');
  assert.match(
    approval,
    /head\.repo\.full_name != github\.repository && 'fork-integration' \|\| 'integration'/,
  );
  assert.match(approval, /deployment: false/);
  assert.doesNotMatch(approval, /actions\/checkout|secrets\./);

  const scenario = workflow.match(/^ {2}scenario:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m)?.[0];
  assert.match(scenario, /needs: \[detect, integration-approval\]/);
  for (const checkout of workflow.matchAll(
    / {6}- uses: actions\/checkout@v7\n([\s\S]*?)(?= {6}- |\n {2}[\w-]+:|$(?![\s\S]))/gm,
  )) {
    assert.match(checkout[1], /repository: \$\{\{ env\.INTEGRATION_CHECKOUT_REPOSITORY \}\}/);
    assert.match(checkout[1], /ref: \$\{\{ env\.INTEGRATION_CHECKOUT_REF \}\}/);
    assert.match(checkout[1], /persist-credentials: false/);
    assert.match(
      checkout[1],
      /allow-unsafe-pr-checkout: \$\{\{ github\.event_name == 'pull_request_target' \}\}/,
    );
  }
});

test('every job using repository secrets waits for approval, including native inbox live checks', () => {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n') + 7).split(/(?=^ {2}[\w-]+:\n)/m);
  const secretJobs = jobs.filter((job) => job.includes('secrets.'));
  assert.ok(secretJobs.length > 0);
  for (const job of secretJobs) {
    assert.match(
      job,
      /^ {4}needs: (?:integration-approval|\[[^\n]*integration-approval[^\n]*\])$/m,
      `${job.split('\n')[0]} can access secrets before approval`,
    );
  }
  assert.doesNotMatch(workflow, /github\.event_name != 'pull_request'/);
});

test('missing Stage B credentials fail the job instead of reporting a successful E2E', () => {
  assert.doesNotMatch(workflow, /name: Skipped — Stage B/);
  const failure = workflow.match(
    / {6}- name: Fail — Stage B secrets unavailable\n[\s\S]*? {8}run: \|\n((?: {10}.*\n)+)/,
  );
  assert.ok(failure, 'missing credentials must have an explicit failure step');
  assert.match(failure[0], /if: env\.DSH_SECRETS_AVAILABLE != 'true'/);
  const result = spawnSync('bash', ['-e', '-c', failure[1]], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
});

test('integration scenarios use the dsh version pinned by the workspace', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const version = manifest.devDependencies['@deepseek-ai/dsh-agent'];
  const langfuseShared = readFileSync(
    new URL('./integration/lib/langfuse-shared.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(workflow.includes(`DSH_CLI_VERSION: ${version}`), 'CI must install the tested dsh CLI');
  assert.ok(
    langfuseShared.includes(`envOr(process.env.DSH_CLI_VERSION, '${version}')`),
    'local hook scenarios must default to the tested dsh version',
  );
});

test('http provider skips service startup but still runs its HTTP integration', () => {
  const backends = workflow.match(
    /^ {2}scenario-backends:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m,
  )?.[0];
  assert.ok(backends, 'scenario-backends job must exist');
  const startup = backends.match(
    / {6}- name: Start service database \([\s\S]*?(?= {6}- name: Stage B)/,
  )?.[0];
  assert.ok(startup, 'service startup step must exist');
  assert.match(startup, /if: matrix\.provider != 'http'/);
  for (const provider of ['sqlite', 'mysql', 'postgresql', 'sqlserver', 'redis']) {
    assert.match(startup, new RegExp(`^ {12}${provider}\\)`, 'm'));
  }

  const stage = backends.match(/ {6}- name: Stage B — run scenario\n(?: {8}.*\n)+/)?.[0];
  assert.ok(stage, 'HTTP integration must retain its Stage B step');
  assert.doesNotMatch(stage, /if:/);
  assert.match(
    stage,
    /run: node "\.github\/scripts\/integration\/\$\{\{ matrix\.package \}\}\.mjs"/,
  );
});
