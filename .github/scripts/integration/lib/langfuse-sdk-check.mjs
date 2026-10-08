import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LangfuseReporter } from '../../../../packages/dsh-langfuse/lib/client.js';
import { apply } from '../../../../packages/dsh-langfuse/lib/index.js';
import {
  capturedToObservations,
  evaluateReasoning,
  evaluateTrace,
  startFakeIngestion,
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
      input: { messages: [] },
    }),
  );
  const request = reporter.startSpan(generation, { name: 'llm-request', input: { messages: [] } });
  reporter.endSpan(request, { output: [{ type: 'reasoning-delta', index: 0, text: 'check' }] });
  reporter.endGeneration(generation, {
    output: { text: 'answer', reasoning: 'check' },
    usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
  });
  reporter.endSpan(root);
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
  const legacyTools = observations.map((observation) =>
    observation.type === 'TOOL' ? { ...observation, type: 'SPAN' } : observation,
  );
  assert.ok(
    evaluateTrace(legacyTools, 'sdk-marker').includes('tool observation must have type TOOL'),
  );
  await reporter.shutdown();
  const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
  ctx = new Context();
  ctx.provide('attachments', {
    readImage: () => {
      throw new Error('late image read after unload');
    },
  });
  await apply(ctx, {
    ...connection,
    enabled: true,
    traceName: 'sdk-one-off',
    captureContent: true,
    captureMedia: true,
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
  assert.equal(captured.length, 7, 'unload must export an agent-less tool and its root');
  const result = { isError: false, content: [{ type: 'image', attachment: {} }] };
  release(result);
  assert.equal(await operation, result);
  assert.equal(captured.length, 7, 'late completion must not export the same tool again');
  console.log('real Langfuse SDK / OTLP checks passed');
} finally {
  await ctx?.fiber.dispose();
  await reporter.shutdown();
  await new Promise((resolve) => server.close(resolve));
  api.context.disable();
  contextManager.disable();
}
