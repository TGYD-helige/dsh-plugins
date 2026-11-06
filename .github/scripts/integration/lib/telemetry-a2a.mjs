/** Packed telemetry + A2A bundles, real inbox/task path and backend API read-back. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { a2aClient, assert, bootA2a, stopA2a, THINKING_OFF } from './a2a-shared.mjs';
import { requireEnv, run } from './ci-shared.mjs';
import { runVerification } from './langfuse-shared.mjs';
import { runPhoenixVerification } from './phoenix-shared.mjs';

export async function runTelemetryA2a(backend) {
  requireEnv(['DSH_TELEMETRY_COLLECTOR_TARBALL', 'DSH_TELEMETRY_A2A_TARBALL', 'DSH_PKG_TARBALL']);
  requireEnv(
    backend === 'phoenix'
      ? ['PHOENIX_API_KEY', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_PROJECT_NAME']
      : ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
  );
  const tag = `telemetry-${backend}-a2a`;
  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), `dsh-a2a-e2e-${tag}`);
  const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
  mkdirSync(workDir, { recursive: true });
  const dsh = process.env.DSH_CLI || 'dsh';
  run(
    dsh,
    [
      'plugin',
      '--profile',
      'web',
      'add',
      ...[
        process.env.DSH_TELEMETRY_COLLECTOR_TARBALL,
        process.env.DSH_TELEMETRY_A2A_TARBALL,
        process.env.DSH_PKG_TARBALL,
      ].map((file) => resolve(file)),
      '@opentelemetry/api@1.9.1',
      '@opentelemetry/sdk-trace-node@2.10.0',
      '@opentelemetry/resources@2.10.0',
      '@opentelemetry/exporter-trace-otlp-proto@0.221.0',
    ],
    { cwd: workDir, env: { DSH_HOME: dshHome } },
  );
  process.env.DSH_PKG_TARBALL = process.env.DSH_TELEMETRY_A2A_TARBALL;
  const marker = `ci-marker-${tag}-${randomUUID()}`;
  writeFileSync(join(workDir, `${marker}.txt`), marker);
  const startedAt = new Date().toISOString();
  let proc;
  try {
    const boot = await bootA2a({
      tag,
      inbox: true,
      reuse: true,
      extraPatch: `${THINKING_OFF}\n- id: telemetry\n  config:\n    enabled: true\n    backend: ${backend}\n\n- id: session-title-llm\n  disabled: true\n`,
    });
    proc = boot.proc;
    const client = a2aClient(boot.a2a, { signal: AbortSignal.timeout(240_000) });
    const contextId = randomUUID();
    const { res, body } = await client.rpc('SendMessage', {
      message: client.userMessage(`请用工具读取 ${marker}.txt 并复述内容`, { contextId }),
      configuration: { returnImmediately: true },
    });
    assert(res.ok && !body.error, 'SendMessage must succeed');
    const taskId = body.result.task.id;
    let completed = false;
    for (let i = 0; i < 120; i++) {
      const result = await client.rpc('GetTask', { id: taskId });
      const state = result.body.result?.status?.state;
      assert(
        !['TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'].includes(state),
        'task must not fail',
      );
      if (state === 'TASK_STATE_COMPLETED') {
        completed = true;
        break;
      }
      await delay(1000);
    }
    assert(completed, 'A2A task did not complete');
    await stopA2a(proc);
    proc = undefined;
    const evaluate = (observations) => {
      const task = observations.find((o) => o.name === 'a2a-task');
      const turn = observations.find(
        (o) => o.name === 'dsh-turn' && o.parentObservationId === task?.id,
      );
      const generation = observations.find(
        (o) => o.type === 'GENERATION' && o.parentObservationId === turn?.id,
      );
      const tool = observations.find(
        (o) => o.type === 'TOOL' && JSON.stringify(o.input).includes(marker),
      );
      return [
        ...(!task?.endTime ? ['missing completed A2A task root'] : []),
        ...(!turn?.endTime ? ['missing task-owned turn'] : []),
        ...(!generation?.usageDetails?.total ? ['missing task generation usage'] : []),
        ...(!tool?.endTime ? ['missing task tool'] : []),
      ];
    };
    const verify = backend === 'phoenix' ? runPhoenixVerification : runVerification;
    const result = await verify({
      baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      fromStartTime: startedAt,
      toStartTime: new Date().toISOString(),
      codeword: marker,
      evaluate,
    });
    assert(result.ok, result.state);
    console.log(`SCENARIO_OK (${backend} real A2A task API read-back)`);
  } finally {
    if (proc) await stopA2a(proc);
  }
}
