import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { LangfuseReporter } from '../../../../packages/dsh-langfuse/lib/client.js';
import { apply } from '../../../../packages/dsh-langfuse/lib/index.js';
import {
  capturedToObservations,
  evaluateReasoning,
  evaluateTrace,
  startFakeIngestion,
  runVerification,
} from './langfuse-shared.mjs';
import { integrationModel } from './ci-shared.mjs';

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
  const operation = ctx.waterfall(
    'tools/execute',
    { name: 'read', arguments: {}, callId: 'call', signal: new AbortController().signal },
    () => pending,
  );
  await ctx.fiber.dispose();
  assert.equal(captured.length, 10, 'unload must export an agent-less tool and its root');
  const result = { isError: false, content: [{ type: 'image', attachment: {} }] };
  release(result);
  assert.equal(await operation, result);
  assert.equal(captured.length, 10, 'late completion must not export the same tool again');
  assert.equal(imageReads, 1, 'late completion must not start another image read');
  console.log('real Langfuse SDK / OTLP checks passed');
} finally {
  await ctx?.fiber.dispose();
  await reporter.shutdown();
  await new Promise((resolve) => server.close(resolve));
  api.context.disable();
  contextManager.disable();
}
