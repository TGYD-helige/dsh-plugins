import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stopA2a } from './integration/lib/a2a-shared.mjs';
import * as integration from './integration/lib/ci-shared.mjs';

const workflow = readFileSync(new URL('../workflows/integration.yml', import.meta.url), 'utf8');

test('every published plugin has unit tests and a discoverable integration scenario', () => {
  const packages = new URL('../../packages/', import.meta.url);
  const scenarios = new URL('./integration/', import.meta.url);
  for (const name of readdirSync(packages)) {
    const manifestPath = new URL(`${name}/package.json`, packages);
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private) continue;
    assert.equal(manifest.scripts?.test, 'vitest run', `${name} must run its unit tests`);
    assert.ok(
      readdirSync(scenarios).some(
        (file) => file.endsWith('.mjs') && (file === `${name}.mjs` || file.startsWith(`${name}.`)),
      ),
      `${name} needs a discoverable integration scenario`,
    );
  }
});

test('the Integration gate covers every job and rejects failed, cancelled or skipped work', () => {
  const pending = workflow.match(/^ {2}status:\n[\s\S]*?(?=^ {2}[\w-]+:)/m)?.[0];
  assert.ok(pending, 'full runs must invalidate earlier success before testing');
  assert.match(pending, /if:.*inputs\.scenario == ''/);
  assert.match(pending, /statuses: write/);
  assert.match(pending, /state=pending -f context='Integration required'/);
  assert.doesNotMatch(pending, /needs:|actions\/checkout|pnpm|secrets\./);
  const gate = workflow.match(/^ {2}gate:\n[\s\S]*$/m)?.[0];
  assert.ok(gate, 'Integration needs a fixed summary gate');
  assert.match(gate, /if:.*always\(\).*inputs\.scenario == ''/);
  const required = [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):\n/gm)]
    .map((match) => match[1])
    .filter((name) => name !== 'gate');
  const dependencies = gate
    .match(/needs: \[([^\]]+)\]/)[1]
    .split(',')
    .map((id) => id.trim());
  assert.deepEqual(dependencies.sort(), required.sort());
  const script = gate.match(/run: \|\n((?: {10}.*\n|\n)+)/)?.[1].replace(/^ {10}/gm, '');
  assert.ok(script);
  const needs = Object.fromEntries(required.map((id) => [id, { result: 'success' }]));
  needs.detect.outputs = { has_scenarios: 'true', has_backends: 'true' };
  const run = () =>
    spawnSync('bash', ['-e', '-c', script], {
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
      encoding: 'utf8',
    });
  assert.equal(run().status, 0);
  for (const id of required) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      needs[id].result = result;
      assert.notEqual(run().status, 0, `${id}: ${result} must block merging`);
    }
    needs[id].result = 'success';
  }
  needs.detect.outputs.has_scenarios = 'false';
  assert.notEqual(run().status, 0, 'an empty scenario matrix cannot pass');
  needs.detect.outputs = {};
  assert.notEqual(run().status, 0, 'missing discovery outputs cannot pass');
  assert.doesNotMatch(gate, /actions\/checkout|pnpm|secrets\./);
  assert.match(gate, /statuses: write/);
  assert.match(gate, /statuses\/\$TARGET_SHA/);
  assert.match(gate, /context='Integration required'/);
});

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

test('new backend secrets are scoped to the exact telemetry backend', () => {
  for (const key of ['PHOENIX_API_KEY', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_PROJECT_NAME'])
    assert.ok(
      workflow.includes(
        `${key}: \${{ startsWith(matrix.name, 'dsh-telemetry.phoenix') && secrets.${key} || '' }}`,
      ),
    );
  for (const key of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'])
    assert.ok(
      workflow.includes(
        `(matrix.package == 'dsh-langfuse' || startsWith(matrix.name, 'dsh-telemetry.langfuse')) && secrets.${key} || ''`,
      ),
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

test('reasoning validation follows the source stream instead of requiring the model to think', async () => {
  const { evaluateReasoning } = await import('./integration/lib/langfuse-shared.mjs');
  const generation = { id: 'g', type: 'GENERATION', output: 'answer' };
  const request = {
    type: 'SPAN',
    name: 'llm-request',
    parentObservationId: 'g',
    output: [{ type: 'text-delta', text: 'answer' }],
  };
  assert.deepEqual(evaluateReasoning([generation, request], []), []);
  assert.deepEqual(
    evaluateReasoning(
      [
        {
          ...generation,
          metadata: { purpose: 'session-title' },
          output: { thinking: [{ type: 'thinking', content: 'title reasoning' }] },
        },
        { ...request, output: [{ type: 'reasoning-delta', text: 'title reasoning' }] },
      ],
      [],
    ),
    [],
  );
  assert.ok(evaluateReasoning([generation, request], ['source reasoning']).length > 0);
  request.output = [
    { type: 'reasoning-delta', text: 'source ' },
    { type: 'reasoning-delta', text: 'reasoning' },
  ];
  assert.ok(
    evaluateReasoning([generation, request], ['source reasoning']).length > 0,
    'display loss must fail',
  );
  generation.output = { thinking: [{ type: 'thinking', content: 'source reasoning' }] };
  assert.deepEqual(evaluateReasoning([generation, request], ['source reasoning']), []);
  assert.ok(
    evaluateReasoning([generation, request], ['different reasoning']).length > 0,
    'changed content must fail',
  );
  assert.ok(
    evaluateReasoning([generation, request], []).length > 0,
    'unexpected content must fail',
  );
});

test('subagent verification requires a successful completed read of the fixture', async () => {
  const { evaluateSubagentTrace } = await import('./integration/lib/langfuse-shared.mjs');
  const marker = 'ci-subagent-read';
  const tree = [
    { id: 'root', type: 'SPAN', name: 'dsh-turn', endTime: 1 },
    {
      id: 'delegate',
      type: 'TOOL',
      name: 'tool:subagent',
      parentObservationId: 'root',
      endTime: 1,
    },
    { id: 'child', type: 'SPAN', name: 'subagent', parentObservationId: 'delegate', endTime: 1 },
    {
      id: 'llm',
      type: 'GENERATION',
      parentObservationId: 'child',
      model: integration.integrationModel(),
      endTime: 1,
    },
    {
      id: 'read',
      type: 'TOOL',
      name: 'tool:read',
      parentObservationId: 'child',
      endTime: 1,
      input: { file_path: `/work/${marker}.txt` },
      output: `${marker}-content`,
    },
  ];
  assert.deepEqual(evaluateSubagentTrace(tree, marker), []);
  assert.ok(
    evaluateSubagentTrace(
      [...tree, ...Array.from({ length: 4 }, (_, i) => ({ ...tree[3], id: `extra-${i}` }))],
      marker,
    ).includes('fixture subagent exceeded four LLM calls'),
    'a one-file read must not pass after an extended search loop',
  );
  assert.ok(
    evaluateSubagentTrace(
      [
        ...tree,
        { ...tree[1], id: 'second-delegate' },
        { ...tree[2], id: 'second-child', parentObservationId: 'second-delegate' },
        ...Array.from({ length: 4 }, (_, i) => ({
          ...tree[3],
          id: `second-${i}`,
          parentObservationId: 'second-child',
        })),
      ],
      marker,
    ).includes('fixture subagent exceeded four LLM calls'),
    'repeated delegations must share the fixture call budget',
  );
  for (const update of [
    { level: 'ERROR', output: `cannot read /work/${marker}.txt` },
    { statusCode: 'ERROR', output: `cannot read /work/${marker}.txt` },
    { endTime: null },
    { output: undefined },
    { name: 'tool:bash' },
  ]) {
    assert.ok(
      evaluateSubagentTrace([...tree.slice(0, -1), { ...tree.at(-1), ...update }], marker).length,
      'failed, unfinished or unrelated tools must not satisfy the read scenario',
    );
  }
});

test('Langfuse session verification checks both task traces and CI identity through the session API', async (t) => {
  const { verifyLangfuseSession } = await import('./integration/lib/langfuse-shared.mjs');
  const trace = {
    id: 'first',
    sessionId: 'session',
    environment: 'ci',
    release: 'head',
    tags: ['ci', 'run:1'],
  };
  let body = { id: 'session', traces: [trace, { ...trace, id: 'second' }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), 'https://langfuse.invalid/api/public/sessions/session');
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const options = {
    baseUrl: 'https://langfuse.invalid',
    publicKey: 'pk-fixture',
    secretKey: 'sk-fixture',
    sessionId: 'session',
    traceIds: ['first', 'second'],
    release: 'head',
    tags: ['ci', 'run:1'],
  };
  await verifyLangfuseSession(options);
  body = { ...body, traces: [trace] };
  await assert.rejects(verifyLangfuseSession(options), /missing task trace/);
  body = { ...body, traces: [trace, { ...trace, id: 'second', tags: [] }] };
  await assert.rejects(verifyLangfuseSession(options));
});

test('reasoning evidence reads current durable model streams and fails on missing evidence', async () => {
  const { readReasoningSource } = await import('./integration/lib/langfuse-shared.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'reasoning-source-'));
  const sessions = join(directory, 'sessions', 'workspace', 'session');
  mkdirSync(sessions, { recursive: true });
  const write = (rows) =>
    writeFileSync(join(sessions, 'session.v4.jsonl'), rows.map(JSON.stringify).join('\n'));
  const settled = (time, texts) => ({
    type: 'assistant/message',
    time,
    data: {
      stream: [
        { type: 'reasoning-chunks', time0: time, index: 0, dt: texts.slice(1).map(() => 0), texts },
      ],
    },
  });
  try {
    write([
      settled(1000, ['old']),
      settled(3000, ['source ', 'reasoning']),
      { ...settled(3500, ['failed attempt reasoning']), type: 'assistant/attempt' },
    ]);
    assert.deepEqual(readReasoningSource(directory, new Date(2000).toISOString()), [
      'source reasoning',
      'failed attempt reasoning',
    ]);
    write([
      {
        type: 'assistant/message',
        time: 3000,
        data: {
          stream: [{ type: 'text-chunks', time0: 3000, index: 0, dt: [], texts: ['answer'] }],
        },
      },
    ]);
    assert.deepEqual(readReasoningSource(directory, new Date(2000).toISOString()), []);
    assert.throws(
      () => readReasoningSource(directory, new Date(4000).toISOString()),
      /settled model stream/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Phoenix rejects an A2A root that points to a missing parent', async () => {
  const { evaluatePhoenixSemantics } = await import('./integration/lib/phoenix-shared.mjs');
  const root = {
    id: 'task-root',
    name: 'a2a-task',
    spanKind: 'AGENT',
    type: 'SPAN',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:00:01Z',
    parentObservationId: '0000000000000001',
  };
  assert.deepEqual(evaluatePhoenixSemantics([root]), ['missing parent of a2a-task']);
  assert.deepEqual(evaluatePhoenixSemantics([{ ...root, parentObservationId: null }]), []);
});

test('Phoenix session verification requires the first input and last output', async (t) => {
  const { verifyPhoenixSessionIO } = await import('./integration/lib/phoenix-shared.mjs');
  const oldEndpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT;
  const oldKey = process.env.PHOENIX_API_KEY;
  process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://phoenix.test/v1/traces';
  process.env.PHOENIX_API_KEY = 'unit-test-key';
  let firstInput = null;
  let lastOutput = { value: 'task completed' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer unit-test-key');
    if (String(url).endsWith('/v1/sessions/task-session'))
      return Response.json({
        data: { id: 'UHJvamVjdFNlc3Npb246MQ==', session_id: 'task-session' },
      });
    assert.equal(String(url), 'http://phoenix.test/graphql');
    assert.match(JSON.parse(options.body).query, /firstInput/);
    return Response.json({ data: { node: { firstInput, lastOutput } } });
  });
  try {
    await assert.rejects(
      () => verifyPhoenixSessionIO('task-session', 'read ci-marker.txt', 'task completed'),
      /session first input/,
    );
    firstInput = { value: 'read ci-marker.txt' };
    await verifyPhoenixSessionIO('task-session', 'read ci-marker.txt', 'task completed');
    lastOutput = { value: 'previous task response' };
    await assert.rejects(
      () => verifyPhoenixSessionIO('task-session', 'read ci-marker.txt', 'task completed'),
      /session last output/,
    );
    lastOutput = null;
    await assert.rejects(
      () => verifyPhoenixSessionIO('task-session', 'read ci-marker.txt', 'task completed'),
      /session last output/,
    );
  } finally {
    if (oldEndpoint === undefined) delete process.env.PHOENIX_COLLECTOR_ENDPOINT;
    else process.env.PHOENIX_COLLECTOR_ENDPOINT = oldEndpoint;
    if (oldKey === undefined) delete process.env.PHOENIX_API_KEY;
    else process.env.PHOENIX_API_KEY = oldKey;
  }
});
