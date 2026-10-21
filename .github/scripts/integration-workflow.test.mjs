import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/integration.yml', import.meta.url), 'utf8');

test('fork E2E uses one approval gate before running the exact PR revision with secrets', () => {
  assert.match(workflow, /\n  pull_request_target:\n/);
  assert.doesNotMatch(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /group:.*github\.event\.pull_request\.number \|\| github\.ref/);
  assert.match(workflow, /INTEGRATION_CHECKOUT_REPOSITORY:.*github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(workflow, /INTEGRATION_CHECKOUT_REF:.*github\.event\.pull_request\.head\.sha/);

  const approval = workflow.match(/^  integration-approval:\n[\s\S]*?(?=^  [\w-]+:|$(?![\s\S]))/m)?.[0];
  assert.ok(approval, 'secret-backed scenarios need a shared approval job');
  assert.match(approval, /head\.repo\.full_name != github\.repository && 'fork-integration' \|\| 'integration'/);
  assert.match(approval, /deployment: false/);
  assert.doesNotMatch(approval, /actions\/checkout|secrets\./);

  const scenario = workflow.match(/^  scenario:\n[\s\S]*?(?=^  [\w-]+:|$(?![\s\S]))/m)?.[0];
  assert.match(scenario, /needs: \[detect, integration-approval\]/);
  for (const checkout of workflow.matchAll(/      - uses: actions\/checkout@v7\n([\s\S]*?)(?=      - |\n  [\w-]+:|$(?![\s\S]))/gm)) {
    assert.match(checkout[1], /repository: \$\{\{ env\.INTEGRATION_CHECKOUT_REPOSITORY \}\}/);
    assert.match(checkout[1], /ref: \$\{\{ env\.INTEGRATION_CHECKOUT_REF \}\}/);
    assert.match(checkout[1], /persist-credentials: false/);
    assert.match(checkout[1], /allow-unsafe-pr-checkout: \$\{\{ github\.event_name == 'pull_request_target' \}\}/);
  }
});

test('every job using repository secrets waits for approval, including native inbox live checks', () => {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n') + 7).split(/(?=^  [\w-]+:\n)/m);
  const secretJobs = jobs.filter((job) => job.includes('secrets.'));
  assert.ok(secretJobs.length > 0);
  for (const job of secretJobs) {
    assert.match(job, /^    needs: (?:integration-approval|\[[^\n]*integration-approval[^\n]*\])$/m,
      `${job.split('\n')[0]} can access secrets before approval`);
  }
  assert.doesNotMatch(workflow, /github\.event_name != 'pull_request'/);
});

test('missing Stage B credentials fail the job instead of reporting a successful E2E', () => {
  assert.doesNotMatch(workflow, /name: Skipped — Stage B/);
  const failure = workflow.match(/      - name: Fail — Stage B secrets unavailable\n[\s\S]*?        run: \|\n((?:          .*\n)+)/);
  assert.ok(failure, 'missing credentials must have an explicit failure step');
  assert.match(failure[0], /if: env\.DSH_SECRETS_AVAILABLE != 'true'/);
  const result = spawnSync('bash', ['-e', '-c', failure[1]], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
});
