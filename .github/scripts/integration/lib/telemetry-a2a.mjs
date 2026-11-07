/** Packed telemetry + A2A bundles, real inbox/task path and backend API read-back. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { a2aClient, assert, bootA2a, stopA2a, THINKING_OFF } from './a2a-shared.mjs';
import { integrationRevision, requireEnv, run } from './ci-shared.mjs';
import { runVerification, verifyLangfuseSession } from './langfuse-shared.mjs';
import { runPhoenixVerification, verifyPhoenixSessionIO } from './phoenix-shared.mjs';

export async function runTelemetryA2a(backend) {
  requireEnv(['DSH_TELEMETRY_A2A_TARBALL', 'DSH_PKG_TARBALL']);
  requireEnv(
    backend === 'phoenix'
      ? ['PHOENIX_API_KEY', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_PROJECT_NAME']
      : ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
  );
  if (backend === 'phoenix') process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION ??= 'gzip';
  const tag = `telemetry-${backend}-a2a`;
  const tags = [
    'ci',
    `scenario:${tag}`,
    `run:${process.env.GITHUB_RUN_ID || 'local'}`,
    `attempt:${process.env.GITHUB_RUN_ATTEMPT || '1'}`,
  ];
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
      ...[process.env.DSH_TELEMETRY_A2A_TARBALL, process.env.DSH_PKG_TARBALL].map((file) =>
        resolve(file),
      ),
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
      extraPatch: `${THINKING_OFF}\n- id: telemetry\n  config:\n    enabled: true\n    backend: ${backend}\n    environment: ci\n    release: ${JSON.stringify(integrationRevision())}\n    tags: ${JSON.stringify(tags)}\n\n- id: session-title-llm\n  disabled: true\n`,
    });
    proc = boot.proc;
    const contextId = randomUUID();
    async function runTask(prompt) {
      const client = a2aClient(boot.a2a, { signal: AbortSignal.timeout(240_000) });
      const { res, body } = await client.rpc('SendMessage', {
        message: client.userMessage(prompt, { contextId, messageId: randomUUID() }),
        configuration: { returnImmediately: true },
      });
      assert(res.ok && !body.error, 'SendMessage must succeed');
      const taskId = body.result.task.id;
      for (let i = 0; i < 120; i++) {
        const result = await client.rpc('GetTask', { id: taskId });
        const state = result.body.result?.status?.state;
        assert(
          !['TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'].includes(state),
          'task must not fail',
        );
        if (state === 'TASK_STATE_COMPLETED') return;
        await delay(1000);
      }
      assert(false, 'A2A task did not complete');
    }
    const taskPrompt = (file) =>
      `请用 read 工具读取绝对路径 ${JSON.stringify(join(workDir, `${file}.txt`))}，原样返回内容后结束，不要搜索其他文件。`;
    const firstPrompt = taskPrompt(marker);
    await runTask(firstPrompt);
    // Read back task spans before the CLI's bounded SIGTERM shutdown.
    const evaluate = (observations, codeword) => {
      const task = observations.find((o) => o.name === 'a2a-task');
      const turn = observations.find(
        (o) => o.name === 'agent:turn' && o.parentObservationId === task?.id,
      );
      const generation = observations.find(
        (o) => o.type === 'GENERATION' && o.parentObservationId === turn?.id,
      );
      const tool = observations.find(
        (o) => o.type === 'TOOL' && JSON.stringify(o.input).includes(codeword),
      );
      return [
        ...(!task?.endTime ? ['missing completed A2A task root'] : []),
        ...(task?.parentObservationId ? ['A2A task root must not have a parent'] : []),
        ...(!JSON.stringify(task?.input ?? '').includes(codeword) ? ['missing task input'] : []),
        ...(!task?.output ? ['missing task output'] : []),
        ...(!turn?.endTime ? ['missing task-owned turn'] : []),
        ...(!generation?.usageDetails?.total ? ['missing task generation usage'] : []),
        ...(!tool?.endTime ? ['missing task tool'] : []),
      ];
    };
    const verify = backend === 'phoenix' ? runPhoenixVerification : runVerification;
    const connection = {
      baseUrl: process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
    };
    const result = await verify({
      ...connection,
      fromStartTime: startedAt,
      toStartTime: new Date().toISOString(),
      codeword: marker,
      evaluate,
    });
    assert(result.ok, result.state);
    const firstRoot = result.trace.find((span) => span.name === 'a2a-task');
    if (backend === 'phoenix') {
      await verifyPhoenixSessionIO(contextId, firstPrompt, firstRoot.output);
    }
    const secondMarker = `${marker}-follow-up`;
    writeFileSync(join(workDir, `${secondMarker}.txt`), secondMarker);
    await runTask(taskPrompt(secondMarker));
    const second = await verify({
      ...connection,
      fromStartTime: startedAt,
      toStartTime: new Date().toISOString(),
      codeword: secondMarker,
      evaluate,
    });
    assert(second.ok, second.state);
    const lastRoot = second.trace.find((span) => span.name === 'a2a-task');
    assert(lastRoot.traceId !== firstRoot.traceId, 'separate tasks must keep separate trace IDs');
    if (backend === 'phoenix') {
      assert(
        lastRoot.sessionId === contextId && firstRoot.sessionId === contextId,
        'tasks must retain their session',
      );
      await verifyPhoenixSessionIO(contextId, firstPrompt, lastRoot.output);
    } else {
      await verifyLangfuseSession({
        ...connection,
        sessionId: contextId,
        traceIds: [firstRoot.traceId, lastRoot.traceId],
        release: integrationRevision(),
        tags,
      });
    }
    await stopA2a(proc);
    proc = undefined;
    console.log(`SCENARIO_OK (${backend} real A2A task API read-back)`);
  } finally {
    if (proc) await stopA2a(proc);
  }
}
