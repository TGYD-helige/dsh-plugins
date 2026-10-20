import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyHookBridge } from './tool-hook-bridge.mjs';
import { apply as applyCancelBridge } from './cancel-hook-bridge.mjs';
import { createRequire } from 'node:module';
import { LangfuseReporter } from '../../../../packages/dsh-langfuse/lib/client.js';
import { appendHookEvent, apply } from '../../../../packages/dsh-langfuse/lib/index.js';
import {
  capturedToObservations,
  evaluateReasoning,
  evaluateTrace,
  evaluateToolHookTrace,
  evaluateCancelHookTrace,
  startFakeIngestion,
  runVerification,
} from './langfuse-shared.mjs';
import { integrationModel } from './ci-shared.mjs';
import { checkMetadataWire } from './langfuse-metadata-check.mjs';

// Real SDK + local OTLP receiver: no gateway, Langfuse account, or harness boot.
const require = createRequire(
  new URL('../../../../packages/dsh-langfuse/package.json', import.meta.url),
);
const { LangfuseOtelSpanAttributes: keys, propagateAttributes } = await import(
  require.resolve('@langfuse/tracing')
);
const api = await import(require.resolve('@opentelemetry/api'));
const sdkRequire = createRequire(require.resolve('@opentelemetry/sdk-trace-node'));
const { AsyncLocalStorageContextManager } = await import(
  sdkRequire.resolve('@opentelemetry/context-async-hooks')
);
const contextManager = new AsyncLocalStorageContextManager().enable();
assert.equal(api.context.setGlobalContextManager(contextManager), true);
const captured = [];
const server = await startFakeIngestion(captured);
process.env.LANGFUSE_TRACING_ENVIRONMENT = 'sk-lf-environment';
process.env.LANGFUSE_RELEASE = 'sk-lf-release';
const connection = {
  publicKey: 'pk-lf-sdk-fixture',
  secretKey: 'sk-lf-sdk-fixture',
  baseUrl: `http://127.0.0.1:${server.address().port}`,
};
const reporter = new LangfuseReporter({
  ...connection,
  captureMedia: false,
  redactFields: ['password'],
});
const attribute = (span, key) => {
  const value = span.attributes.find((a) => a.key === key)?.value;
  return value?.stringValue ?? value?.boolValue;
};
let ctx;
let hookWorkDir;
try {
  await reporter.ready;
  const ambient = {
    userId: 'sk-lf-ambient',
    tags: ['sk-lf-ambient'],
    metadata: { password: 'ambient-private' },
  };
  const root = propagateAttributes(ambient, () =>
    reporter.openTrace({ name: 'dsh-turn', sessionId: 'sdk-session' }),
  );
  assert.ok(root, 'SDK initialization must create a real observation');
  reporter.updateSpan(root, { input: { prompt: 'sdk-marker', password: 'private-value' } });
  const tool = propagateAttributes(ambient, () =>
    reporter.startSpan(root, {
      name: 'tool:read',
      asType: 'tool',
      input: { path: 'sdk-marker', password: 'private-value', 'sk-lf-dictionary': 'value' },
    }),
  );
  reporter.endSpan(tool, { output: 'read' });
  const generation = propagateAttributes(ambient, () =>
    reporter.startGeneration(root, {
      name: 'llm-call',
      model: integrationModel(),
      input: { messages: [{ role: 'user', content: 'sdk-marker' }] },
    }),
  );
  const request = reporter.startSpan(generation, { name: 'llm-request', input: { messages: [] } });
  reporter.endSpan(request, { output: [{ type: 'reasoning-delta', index: 0, text: 'check' }] });
  reporter.endGeneration(generation, {
    output: { role: 'assistant', content: 'answer', thinking: [{ type: 'thinking', content: 'check' }] },
    usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
  });
  reporter.endSpan(root, { output: 'sdk-answer' });
  const external = reporter.openTrace({
    name: 'sdk-external',
    context: {
      traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
    },
  });
  reporter.updateSpan(external, { input: 'observation input' });
  reporter.endSpan(external, { output: 'observation output' });
  await reporter.flush();
  assert.equal(captured.length, 5, 'all ended SDK observations must reach OTLP ingestion');
  const own = captured.find((span) => span.name === 'dsh-turn');
  const joined = captured.find((span) => span.name === 'sdk-external');
  assert.equal(attribute(own, keys.IS_APP_ROOT), true);
  assert.deepEqual(JSON.parse(attribute(own, keys.TRACE_INPUT)), {
    prompt: 'sdk-marker', password: '[REDACTED]',
  });
  assert.equal(attribute(own, keys.TRACE_OUTPUT), 'sdk-answer');
  assert.equal(attribute(own, keys.TRACE_INPUT), attribute(own, keys.OBSERVATION_INPUT));
  assert.equal(attribute(own, keys.TRACE_OUTPUT), attribute(own, keys.OBSERVATION_OUTPUT));
  assert.equal(
    attribute(joined, keys.IS_APP_ROOT),
    false,
    'an external parent must retain trace ownership',
  );
  assert.equal(joined.traceId, '1234567890abcdef1234567890abcdef');
  assert.equal(joined.parentSpanId, '1234567890abcdef');
  assert.equal(attribute(joined, keys.TRACE_NAME), undefined);
  assert.equal(attribute(joined, keys.TRACE_INPUT), undefined);
  assert.equal(attribute(joined, keys.TRACE_OUTPUT), undefined);
  assert.equal(
    attribute(
      captured.find((span) => span.name === 'tool:read'),
      keys.OBSERVATION_TYPE,
    ),
    'tool',
  );
  assert.doesNotMatch(JSON.stringify(captured), /sk-lf-|pk-lf-|private-value|ambient-private/);
  assert.ok(captured.every((span) => attribute(span, keys.ENVIRONMENT) === 'redacted'));
  const observations = capturedToObservations(captured);
  assert.deepEqual(evaluateTrace(observations, 'sdk-marker'), []);
  assert.deepEqual(evaluateReasoning(observations), []);
  const fromStartTime = new Date(Date.now() - 60_000).toISOString();
  const toStartTime = new Date().toISOString();
  const queries = [];
  const readback = createServer((request, response) => {
    const params = new URL(request.url, 'http://localhost').searchParams;
    queries.push(params);
    if (params.get('fromStartTime') !== fromStartTime || params.get('toStartTime') !== toStartTime) {
      response.writeHead(422).end('{"message":"bounded time range required"}');
      return;
    }
    response.setHeader('content-type', 'application/json');
    const rows = observations.map((o) => ({ ...o, traceId: 'sdk-trace' }));
    if (params.get('type') === 'GENERATION') rows.unshift({
      name: 'llm-call [session-title]', input: 'sdk-marker', traceId: 'purpose-trace',
      metadata: { purpose: 'session-title' },
    });
    response.end(JSON.stringify({ data: rows }));
  });
  await new Promise((resolve) => readback.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runVerification({
      baseUrl: `http://127.0.0.1:${readback.address().port}`,
      publicKey: 'fixture', secretKey: 'fixture', fromStartTime, toStartTime,
      codeword: 'sdk-marker', evaluate: evaluateTrace,
    });
    assert.equal(result.ok, true, result.state);
    assert.equal(queries.length, 2, 'discover once, then query that trace');
    assert.equal(queries[0].get('model'), integrationModel());
    assert.equal(queries[1].get('traceId'), 'sdk-trace');
  } finally {
    await new Promise((resolve) => readback.close(resolve));
  }

  const legacyTools = observations.map((observation) =>
    observation.type === 'TOOL' ? { ...observation, type: 'SPAN' } : observation,
  );
  assert.ok(
    evaluateTrace(legacyTools, 'sdk-marker').includes('tool observation must have type TOOL'),
  );
  await reporter.shutdown();
  const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
  ctx = new Context();
  let releaseImage;
  let imageReads = 0;
  const imageRead = new Promise((resolve) => { releaseImage = resolve; });
  const imageRef = { id: 'fixture-image', mediaType: 'image/png', bytes: 3 };
  ctx.provide('attachments', {
    readImage: () => { imageReads += 1; return imageRead; },
  });
  await apply(ctx, {
    ...connection,
    enabled: true,
    traceName: 'sdk-one-off',
    // The loopback fixture tests read latency; masked URLs avoid real media uploads.
    redactFields: ['url'],
    captureContent: true,
    captureMedia: true,
  });
  const stream = await ctx.waterfall('llm/stream', {
    provider: 'fixture', model: 'fixture',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: imageRef }] }],
    signal: new AbortController().signal,
  }, async function* () {
    yield { type: 'reasoning-delta', index: 0, text: 'Consider the file.' };
    yield { type: 'block-end', index: 1, block: {
      type: 'tool-call', id: 'sdk-call', name: 'read', arguments: '{"path":"marker"}',
    } };
    yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 5, reasoningTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  for await (const _ of stream) { /* drain */ }
  const completedAt = Date.now();
  const flushing = ctx.parallel('session/flush', { id: 'fixture' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  releaseImage({ ref: imageRef, data: Uint8Array.of(1, 2, 3) });
  await flushing;
  const timedSpan = captured.find((span) =>
    span.attributes.some((a) => a.key === 'langfuse.observation.model.name' && a.value.stringValue === 'fixture'),
  );
  assert.ok(Number(BigInt(timedSpan.endTimeUnixNano) / 1000000n) <= completedAt,
    'image projection must not extend the exported model completion time');
  const projected = capturedToObservations(captured).find((o) => o.model === 'fixture');
  assert.deepEqual(projected.output, {
    role: 'assistant', thinking: [{ type: 'thinking', content: 'Consider the file.' }],
    tool_calls: [{ id: 'sdk-call', type: 'function', function: { name: 'read', arguments: '{"path":"marker"}' } }],
  });
  assert.deepEqual(projected.usageDetails, {
    input: 10, cache_read_input_tokens: 2, output: 2, output_reasoning_tokens: 3, total: 17,
  });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const exec = { name: 'read', arguments: {}, callId: 'call', signal: new AbortController().signal };
  await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  const operation = ctx.waterfall('tools/execute', exec, () => pending).then((result) => {
    ctx.emit('tools/result', exec, result);
    return result;
  });
  await ctx.fiber.dispose();
  assert.equal(captured.length, 10, 'unload must export an agent-less tool and its root');
  const result = { isError: false, content: [{ type: 'image', attachment: {} }] };
  release(result);
  assert.equal(await operation, result);
  assert.equal(captured.length, 10, 'late completion must not export the same tool again');
  assert.equal(imageReads, 1, 'late completion must not start another image read');
  // Drive the separate E2E producer through the REAL tool runtime and script.
  const treeOffset = captured.length;
  hookWorkDir = mkdtempSync(join(tmpdir(), 'langfuse-tool-hooks-'));
  const hookCodeword = 'ci-marker-tool-hooks-sdk-1';
  const markerFile = `${hookCodeword}.txt`;
  writeFileSync(join(hookWorkDir, markerFile), `${hookCodeword}-content\n`);
  ctx = new Context();
  const { SessionStore: HookSessionStore } = await import(require.resolve('@deepseek-ai/dsh-session'));
  const toolRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'));
  const { default: SystemPrompt } = await import(toolRequire.resolve('@deepseek-ai/dsh-system-prompt'));
  const { default: ToolRuntime, defineTool } = await import(require.resolve('@deepseek-ai/dsh-tools'));
  new HookSessionStore(ctx);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await apply(ctx, { ...connection, enabled: true, traceName: 'dsh-turn', captureContent: true });
  await ctx.plugin({ name: 'tool-hooks-fixture', apply: applyHookBridge });
  const toolSession = ctx.sessions.create(undefined, { meta: { cwd: hookWorkDir } });
  toolSession.append('turn/start', { turn: 0 });
  ctx.tools.register(defineTool({
    name: 'read', description: 'read the marker file',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args) => readFileSync(join(hookWorkDir, args.path), 'utf8'),
  }));
  const hookStream = ctx.waterfall('llm/stream', { provider: 'fixture', model: integrationModel(),
    sessionId: toolSession.id, messages: [{ role: 'user', content: [{ type: 'text', text: markerFile }] }],
  }, async function* () {
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  for await (const _ of hookStream) { /* drain */ }
  const hookToolResult = await ctx.tools.execute({ name: 'read', arguments: { path: markerFile },
    callId: 'hook-call', agent: { id: toolSession.id }, signal: new AbortController().signal });
  assert.equal(hookToolResult.isError, false);
  toolSession.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
  await ctx.parallel('session/flush', toolSession);
  const treeSpans = captured.slice(treeOffset);
  const tree = capturedToObservations(treeSpans).map((observation, index) => ({
    ...observation,
    startTime: new Date(Number(BigInt(treeSpans[index].startTimeUnixNano) / 1000000n)).toISOString(),
    endTime: new Date(Number(BigInt(treeSpans[index].endTimeUnixNano) / 1000000n)).toISOString(),
  }));
  assert.deepEqual(evaluateToolHookTrace(tree, hookCodeword), []);
  // Each assertion must detect the specific E2E regression, not just accept a fixture.
  for (const mutate of [
    (hook) => { hook.parentObservationId = tree.find((o) => o.name === 'dsh-turn').id; },
    (hook) => { hook.input = undefined; },
    (hook) => { hook.output = { decision: 'pass', exitCode: 0 }; },
    (hook) => { hook.metadata.callId = 'wrong-call'; },
    (hook) => { hook.startTime = undefined; },
    (hook) => { hook.output.result.token = 'sk-lf-hook-fixture-private'; },
  ]) {
    const broken = structuredClone(tree);
    mutate(broken.find((o) => o.name === 'hook:AfterTool:verify-marker'));
    assert.ok(evaluateToolHookTrace(broken, hookCodeword).length > 0);
  }
  await ctx.fiber.dispose();
  // Exercise the CI cancellation producer and evaluator through real Session/SDK export.
  const cancelOffset = captured.length;
  ctx = new Context();
  const { SessionStore: CancelSessionStore } = await import(require.resolve('@deepseek-ai/dsh-session'));
  new CancelSessionStore(ctx);
  const cancelSession = ctx.sessions.create();
  const cancelCodeword = 'ci-marker-cancel-hook-sdk-1';
  ctx.provide('agents', { get: () => ({
    cancel: () => cancelSession.append('turn/end', { turn: 0, reason: { kind: 'aborted' } }),
    followup: () => cancelSession.append('turn/start', { turn: 1 }),
  }) });
  await apply(ctx, { ...connection, enabled: true, traceName: 'dsh-turn', captureContent: true });
  applyCancelBridge(ctx);
  cancelSession.append('turn/start', { turn: 0 });
  const cancelStream = ctx.waterfall('llm/stream', { provider: 'fixture', model: integrationModel(),
    sessionId: cancelSession.id, messages: [{ role: 'user', content: [{ type: 'text', text: `${cancelCodeword}.txt` }] }],
    signal: new AbortController().signal }, async function* () {
    yield { type: 'text-delta', index: 0, text: 'Reading marker.' };
  });
  for await (const _ of cancelStream) { /* drain */ }
  let hookReported = false;
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'hook/result') hookReported = true;
  });
  const cancelExec = { name: 'read', arguments: { path: `${cancelCodeword}.txt` },
    callId: 'cancel-call', agent: { id: cancelSession.id }, signal: new AbortController().signal };
  await ctx.waterfall('tools/pre-execute', cancelExec, async () => ({ kind: 'allow' }));
  await ctx.parallel('session/flush', cancelSession);
  assert.equal(hookReported, true, 'session/flush must wait for detached hook results before exit');
  ctx.emit('tools/result', cancelExec, { content: [], isError: true,
    error: { code: 'TOOL_ABORTED', message: 'Cancelled by the E2E fixture' } });
  await ctx.parallel('session/flush', cancelSession);
  const cancelTree = captured.slice(cancelOffset).map((span) => ({
    ...capturedToObservations([span])[0], traceId: span.traceId,
    level: attribute(span, 'langfuse.observation.level'),
    startTime: new Date(Number(BigInt(span.startTimeUnixNano) / 1_000_000n)).toISOString(),
    endTime: new Date(Number(BigInt(span.endTimeUnixNano) / 1_000_000n)).toISOString(),
  }));
  assert.deepEqual(evaluateCancelHookTrace(cancelTree, cancelCodeword), []);
  for (const mutate of [
    (root, hook) => { hook.parentObservationId = 'wrong-parent'; },
    (root, hook) => { hook.traceId = 'wrong-trace'; },
    (root) => { root.metadata.endReason = 'completed'; },
    (root, hook) => { hook.startTime = '2000-01-01T00:00:00Z'; },
    (root, hook) => { hook.input.nextTurn = 0; },
    (root, hook) => { hook.metadata.durationMs = 0; },
    (root, hook) => { hook.output.result = undefined; },
    (root) => { root.metadata.detachedHook = true; },
  ]) {
    const broken = structuredClone(cancelTree);
    mutate(broken.find((o) => o.name === 'dsh-turn'),
      broken.find((o) => o.name === 'hook:UserCancel:cancel-observer'));
    assert.ok(evaluateCancelHookTrace(broken, cancelCodeword).length > 0);
  }
  await ctx.fiber.dispose();

  // Real session producer + SDK export, including results after their parent ended.
  const hookOffset = captured.length;
  ctx = new Context();
  const { SessionStore } = await import(require.resolve('@deepseek-ai/dsh-session'));
  new SessionStore(ctx);
  await apply(ctx, { ...connection, enabled: true, traceName: 'dsh-turn', captureContent: false });
  const session = ctx.sessions.create();
  session.append('turn/start', { turn: 0 });
  const identity = { turn: 0, point: 'AfterAgent', handlerId: 'validator', invocationId: 'running' };
  assert.equal(appendHookEvent(session, 'hook/invoked', {
    ...identity, dialect: 'company-validator', name: 'PRIVATE HOOK', input: { text: 'PRIVATE INPUT' },
  }), true);
  session.append('turn/end', { turn: 0, reason: { kind: 'aborted' } });
  await ctx.parallel('session/flush', session);
  const endedTurn = structuredClone(captured.slice(hookOffset).find((s) => s.name === 'dsh-turn'));
  session.append('turn/start', { turn: 1 });
  assert.equal(appendHookEvent(session, 'hook/result', {
    ...identity, decision: 'pass', outcome: 'cancelled', signal: 'SIGTERM', durationMs: 12,
    stderrSummary: 'PRIVATE STDERR', stdout: 'PRIVATE STDOUT', stderr: 'PRIVATE STDERR',
    result: { additionalContext: 'PRIVATE RESULT' },
  }), true);
  const detached = { ...identity, point: 'UserCancel', invocationId: 'detached' };
  await Promise.resolve();
  assert.equal(appendHookEvent(session, 'hook/invoked', { ...detached, dialect: 'gemini' }), true);
  assert.equal(appendHookEvent(session, 'hook/result', {
    ...detached, decision: 'pass', outcome: 'success', exitCode: 0, durationMs: 3,
  }), true);
  await ctx.parallel('session/flush', session);
  const hookObservations = capturedToObservations(captured.slice(hookOffset));
  const runningHook = hookObservations.find((o) => o.metadata?.invocationId === 'running');
  const detachedHook = hookObservations.find((o) => o.metadata?.invocationId === 'detached');
  const turnRoot = hookObservations.find((o) => o.name === 'dsh-turn' && Number(o.metadata?.turn) === 0 && !o.metadata?.detachedHook);
  assert.ok(turnRoot);
  assert.equal(turnRoot.metadata.endReason, 'aborted');
  assert.equal(runningHook.parentObservationId, turnRoot.id);
  assert.equal(runningHook.output.outcome, 'cancelled');
  assert.equal(detachedHook.parentObservationId, turnRoot.id, 'delayed UserCancel must parent to the cancelled turn root');
  const exportedHook = captured.slice(hookOffset).find((s) => s.name === 'hook:UserCancel');
  assert.equal(exportedHook.traceId, endedTurn.traceId);
  assert.equal(exportedHook.parentSpanId, endedTurn.spanId);
  assert.ok(BigInt(exportedHook.startTimeUnixNano) >= BigInt(endedTurn.endTimeUnixNano));
  assert.equal(detachedHook.metadata.durationMs, '3');
  assert.deepEqual(captured.slice(hookOffset).filter((s) => s.name === 'dsh-turn'), [endedTurn],
    'late reporting must neither re-export nor change the ended root');
  assert.equal(detachedHook.output.outcome, 'success');
  assert.equal(hookObservations.length, 3, 'both hooks must export on the original root before session disposal');
  assert.doesNotMatch(JSON.stringify(captured.slice(hookOffset)), /PRIVATE/);
  await ctx.fiber.dispose();
  await checkMetadataWire({ require, connection, captured });
  console.log('real Langfuse SDK / OTLP checks passed');
} finally {
  if (hookWorkDir) rmSync(hookWorkDir, { recursive: true, force: true });
  await ctx?.fiber.dispose();
  await reporter.shutdown();
  await new Promise((resolve) => server.close(resolve));
  api.context.disable();
  contextManager.disable();
}
