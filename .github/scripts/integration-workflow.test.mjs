import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stopA2a } from './integration/lib/a2a-shared.mjs';
import * as integration from './integration/lib/ci-shared.mjs';

const workflow = readFileSync(new URL('../workflows/integration.yml', import.meta.url), 'utf8');

test('native inbox model E2E is discovered as a packed-plugin gateway scenario', () => {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-model-matrix-'));
  try {
    const output = join(directory, 'output');
    const result = spawnSync(process.execPath, ['.github/scripts/integration-matrix.mjs'], {
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const line = readFileSync(output, 'utf8')
      .split('\n')
      .find((value) => value.startsWith('matrix='));
    const matrix = JSON.parse(line.slice('matrix='.length));
    assert.ok(
      matrix.include.some((leg) => leg.name === 'dsh-a2a.inbox-api' && leg.package === 'dsh-a2a'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('A2A cleanup accepts a child that already exited', async (t) => {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completed = false;
  void stopA2a(child).then(() => {
    completed = true;
  });
  await new Promise(setImmediate);
  assert.equal(completed, true, 'cleanup must not wait for a second exit event');
});

test('A2A cleanup does not keep the scenario alive with its timeout', () => {
  const helper = new URL('./integration/lib/a2a-shared.mjs', import.meta.url).href;
  const script = `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { stopA2a } from ${JSON.stringify(helper)};
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)']);
    await once(child.stdout, 'data');
    await stopA2a(child);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 3000,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('A2A cleanup does not hide a child that crashed before cleanup', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)']);
  await once(child, 'exit');
  await assert.rejects(stopA2a(child), /code 7/);
});

test('A2A cleanup rejects a child that crashes during SIGTERM handling', async () => {
  const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM", () => process.exit(7)); process.stdout.write("ready"); setInterval(() => {}, 1000)',
  ]);
  await once(child.stdout, 'data');
  await assert.rejects(stopA2a(child), /code 7/);
});

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

test('HTTP suite runs in the base scenario while redis stays the sole backend provider', () => {
  const providers = readFileSync(
    new URL('./integration/dsh-a2a.providers', import.meta.url),
    'utf8',
  );
  assert.equal(providers, 'redis\n');

  const scenario = readFileSync(new URL('./integration/dsh-a2a.mjs', import.meta.url), 'utf8');
  assert.match(scenario, /function runHttpSuite\(\)/);
  const http = scenario.match(/if \(provider === 'http'\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(http, 'standalone DSH_PROVIDER=http must remain available');
  assert.match(http, /runHttpSuite\(\)/);
  assert.match(
    scenario,
    /if \(provider === 'redis'\) \{\s*await redisLeg\(\);\s*process\.exit\(0\);\s*\}/,
  );

  const baseEntry = scenario.slice(
    scenario.indexOf('if (provider) throw'),
    scenario.indexOf('const { a2a, proc, workDir }'),
  );
  assert.match(baseEntry, /runHttpSuite\(\)/, 'base scenario must run HTTP tests by default');
});

test('A2A protocol regressions run without the secret-backed approval gate', () => {
  const job = workflow.match(/^ {2}a2a-protocol:\n[\s\S]*?(?=^ {2}[\w-]+:|$(?![\s\S]))/m)?.[0];
  assert.ok(job, 'protocol bindings need a standalone E2E job');
  assert.doesNotMatch(job, /secrets\.|integration-approval/);
  assert.match(job, /DSH_PROVIDER: http/);
  assert.match(job, /node \.github\/scripts\/integration\/dsh-a2a\.mjs/);
  assert.match(job, /check-inbox\.mjs -t 'official protocol bindings'/);
});

test('telemetry Phoenix secrets are step-scoped to Phoenix legs', () => {
  for (const key of ['PHOENIX_API_KEY', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_PROJECT_NAME']) {
    assert.ok(
      workflow.includes(
        `${key}: \u0024{{ startsWith(matrix.name, 'dsh-telemetry.phoenix') && secrets.${key} || '' }}`,
      ),
    );
  }
});

test('Phoenix API validation distinguishes agent and chain types and requires indexed messages', async () => {
  const { phoenixObservation, evaluatePhoenixSemantics } = await import(
    './integration/lib/phoenix-shared.mjs'
  );
  const root = phoenixObservation({
    name: 'dsh-turn',
    span_kind: 'CHAIN',
    context: { trace_id: 't', span_id: 's' },
    attributes: {},
  });
  assert.ok(evaluatePhoenixSemantics([root]).some((problem) => problem.includes('AGENT')));
  const llm = phoenixObservation({
    name: 'llm-call',
    span_kind: 'LLM',
    context: { trace_id: 't', span_id: 'l' },
    attributes: {
      'input.value': JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }),
      'llm.token_count.prompt': 2,
      'llm.token_count.completion': 3,
      'llm.token_count.total': 5,
    },
  });
  assert.ok(evaluatePhoenixSemantics([llm]).some((problem) => problem.includes('message.role')));
});

test('manual integration can select one exact scenario and rejects unknown names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'selected-scenario-'));
  try {
    const output = join(directory, 'output');
    const result = spawnSync(process.execPath, ['.github/scripts/integration-matrix.mjs'], {
      env: {
        ...process.env,
        INTEGRATION_SCENARIO: 'dsh-telemetry.phoenix-a2a',
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const matrix = JSON.parse(
      readFileSync(output, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('matrix='))
        .slice(7),
    );
    assert.deepEqual(matrix.include, [
      { package: 'dsh-telemetry', name: 'dsh-telemetry.phoenix-a2a' },
    ]);
    const bad = spawnSync(process.execPath, ['.github/scripts/integration-matrix.mjs'], {
      env: { ...process.env, INTEGRATION_SCENARIO: 'unknown', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real hook fixture accepts marker names for both telemetry backends', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telemetry-hook-marker-'));
  try {
    for (const tag of ['hook', 'telemetry-phoenix-hook', 'telemetry-langfuse-hook']) {
      const marker = `ci-marker-${tag}-1-1`;
      writeFileSync(join(directory, `${marker}.txt`), `${marker}-content\n`);
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./integration/lib/hook-script.mjs', import.meta.url))],
        {
          cwd: directory,
          input: JSON.stringify({
            hook_event_name: 'UserPromptSubmit',
            prompt: `read ${marker}.txt`,
          }),
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'ci-hook-context-verification');
      assert.equal(result.stderr, 'hook-script-result: marker-verified');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Phoenix 21 read-back decodes flattened metadata fields', async () => {
  const { phoenixObservation } = await import('./integration/lib/phoenix-shared.mjs');
  const span = phoenixObservation({
    name: 'hook:UserPromptSubmit',
    span_kind: 'CHAIN',
    context: { trace_id: 't', span_id: 's' },
    attributes: {
      'metadata.dialect': 'codex',
      'metadata.point': 'UserPromptSubmit',
      'metadata.durationMs': 12,
    },
  });
  assert.deepEqual(span.metadata, { dialect: 'codex', point: 'UserPromptSubmit', durationMs: 12 });
});

test('unpublished telemetry dependencies use local companion archives without requiring the new package on main', () => {
  const pack = workflow.match(
    / {6}- name: Pack shared telemetry and A2A companions\n[\s\S]*?(?=\n {6}- name:)/,
  )?.[0];
  assert.ok(pack, 'missing local companion packaging');
  assert.ok(
    pack.includes("hashFiles('packages/dsh-telemetry/package.json') != ''"),
    'main must work before the telemetry package exists',
  );
  assert.match(pack, /pnpm pack --pack-destination/);
  const install = workflow.match(
    / {6}- name: Stage A — bundle composes into the headless profile\n[\s\S]*?(?=\n {6}#)/,
  )?.[0];
  assert.ok(
    install?.includes('dsh plugin --profile headless add "${companions[@]}" "$DSH_PKG_TARBALL"'),
    'install local archives together rather than resolving unpublished workspace dependencies from npm',
  );
});

test('a packed plugin resolves its unpublished dependency offline through a local file reference', () => {
  const directory = mkdtempSync(join(tmpdir(), 'local-telemetry-dependency-'));
  try {
    const archives = {};
    for (const [label, manifest] of [
      ['core', { name: '@amaster.ai/dsh-telemetry', version: '0.1.0' }],
      [
        'plugin',
        {
          name: '@amaster.ai/dsh-langfuse',
          version: '0.1.0',
          dependencies: { '@amaster.ai/dsh-telemetry': '0.1.0' },
        },
      ],
    ]) {
      const source = join(directory, label);
      mkdirSync(join(source, 'package'), { recursive: true });
      writeFileSync(join(source, 'package/package.json'), JSON.stringify(manifest));
      writeFileSync(join(source, 'package/index.js'), 'export const preserved = true;');
      const archive = join(directory, `${label}.tgz`);
      execFileSync('tar', ['-czf', archive, '-C', source, 'package']);
      archives[label] = archive;
    }
    const install = (name) => {
      const consumer = join(directory, name);
      mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), '{"private":true}');
      return spawnSync(
        'pnpm',
        [
          'add',
          '--offline',
          '--ignore-scripts',
          '--registry=https://local-telemetry.invalid/',
          archives.core,
          archives.plugin,
        ],
        { cwd: consumer, encoding: 'utf8' },
      );
    };
    const before = install('before');
    assert.notEqual(
      before.status,
      0,
      'semver dependency must reproduce the registry-resolution failure',
    );
    assert.match(before.stdout + before.stderr, /ERR_PNPM_NO_OFFLINE_META/);
    const linked = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./link-local-telemetry.mjs', import.meta.url)),
        archives.plugin,
        archives.core,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(linked.status, 0, linked.stderr);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', archives.plugin, 'package/package.json'], { encoding: 'utf8' }),
    );
    assert.equal(manifest.dependencies['@amaster.ai/dsh-telemetry'], `file:${archives.core}`);
    assert.equal(
      execFileSync('tar', ['-xOzf', archives.plugin, 'package/index.js'], { encoding: 'utf8' }),
      'export const preserved = true;',
    );
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'plugin/package/package.json'), 'utf8')).dependencies[
        '@amaster.ai/dsh-telemetry'
      ],
      '0.1.0',
    );
    const after = install('after');
    assert.equal(after.status, 0, after.stdout + after.stderr);
    const unchanged = readFileSync(archives.core);
    const noDependency = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./link-local-telemetry.mjs', import.meta.url)),
        archives.core,
        archives.core,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(noDependency.status, 0, noDependency.stderr);
    assert.deepEqual(
      readFileSync(archives.core),
      unchanged,
      'archives without this dependency remain unchanged',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
