import assert from 'node:assert/strict';
import { LangfuseReporter } from '../../../../packages/dsh-langfuse/lib/client.js';
import { requireEnv } from './ci-shared.mjs';

// Real self-hosted read-back, without an LLM or harness boot. Synthetic IO only.
requireEnv(['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']);
const baseUrl = process.env.LANGFUSE_BASE_URL.replace(/\/+$/, '');
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const headers = { authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}` };
const reporter = new LangfuseReporter({ publicKey, secretKey, baseUrl, environment: 'ci', captureMedia: false });
const sessionId = `dsh-trace-io-${Date.now()}`;
const input = 'synthetic trace input';
const output = 'synthetic trace output';
const fromTimestamp = new Date(Date.now() - 1000).toISOString();
let deadline;

async function read(path, params) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/public/${path}?${new URLSearchParams(params)}`, {
      headers, signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
    });
  } catch {
    throw new Error(`${path} request failed`);
  }
  // A newly exported observation can remain absent until ingestion settles.
  if (response.status === 404 && path.startsWith('observations/')) return null;
  if (!response.ok) {
    throw Object.assign(new Error(`${path} query returned HTTP ${response.status}`), {
      fatal: response.status >= 400 && response.status < 500 && response.status !== 429,
      retryAfterMs: response.status === 429 ? Number(response.headers.get('retry-after')) * 1000 : 0,
    });
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new Error(`${path} query returned invalid JSON data`);
  }
}

async function verify(traceId, observationId, expectedInput, expectedOutput) {
  let state = 'no read-back yet';
  while (Date.now() < deadline) {
    let waitMs = 5000;
    try {
      const toTimestamp = new Date().toISOString();
      const observation = await read(`observations/${observationId}`);
      const traces = await read('traces', { sessionId, fromTimestamp, toTimestamp, fields: 'core,io', limit: '10' });
      assert.ok(Array.isArray(traces.data), 'traces query returned invalid data');
      const trace = traces.data.find((row) => row.id === traceId);
      state = {
        observationTraceMatches: observation?.traceId === traceId,
        observationInputMatches: observation?.id === observationId && observation?.input === expectedInput,
        observationOutputMatches: observation?.output === expectedOutput,
        traceInputMatches: trace?.input === input,
        traceOutputMatches: trace?.output === output,
      };
      if (Object.values(state).every(Boolean)) return;
    } catch (error) {
      if (error.fatal) throw error;
      state = error.message;
      if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) waitMs = error.retryAfterMs;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, Math.max(0, deadline - Date.now()))));
  }
  assert.fail(`Trace/observation IO did not converge (${observationId}): ${JSON.stringify(state)}`);
}

try {
  await reporter.ready;
  const root = reporter.openTrace({ name: 'dsh-trace-io-check', sessionId });
  assert.ok(root, 'SDK must initialize');
  const { traceId, spanId } = root.otelSpan.spanContext();
  reporter.updateSpan(root, { input });
  const child = reporter.startSpan(root, { name: 'synthetic-child', input: 'step input' });
  reporter.endSpan(child, { output: 'step output' });
  // Export children before ending the root, as in a long-running turn.
  await reporter.flush();
  reporter.endSpan(root, { output });
  await reporter.flush();
  deadline = Date.now() + 120_000;
  await verify(traceId, spanId, input, output);

  // Export the external observation only after its owner's IO is visible.
  const external = reporter.openTrace({
    name: 'synthetic-external', sessionId,
    context: { traceparent: `00-${traceId}-${spanId}-01` },
  });
  assert.ok(external);
  reporter.updateSpan(external, { input: 'external observation input' });
  reporter.endSpan(external, { output: 'external observation output' });
  await reporter.flush();
  await verify(traceId, external.otelSpan.spanContext().spanId,
    'external observation input', 'external observation output');
  console.log(`self-hosted Trace/root IO and external ownership read-back passed: ${traceId}`);
} finally {
  await reporter.shutdown();
}
