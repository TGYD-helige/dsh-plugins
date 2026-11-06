/** Real shared protobuf exporter → loopback receiver, no backend/LLM credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { adapters } from '../../../../packages/dsh-telemetry/lib/adapters/index.js';
import { TelemetryReporter } from '../../../../packages/dsh-telemetry/lib/core/otel.js';

const root = await protobuf.load(fileURLToPath(new URL('./otlp-trace.proto', import.meta.url)));
const Request = root.lookupType('ExportTraceServiceRequest');
const captured = [];
let responsesSent = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers['content-type'], 'application/x-protobuf');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Request.toObject(Request.decode(Buffer.concat(chunks)), { longs: String });
    captured.push({ path: req.url, auth: req.headers.authorization, payload });
    if (req.url.startsWith('/slow/')) await delay(6000);
    responsesSent++;
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
  } catch {
    res.writeHead(400).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const attributes = (values) =>
  Object.fromEntries(
    values.map(({ key, value }) => [
      key,
      value.stringValue ??
        value.intValue ??
        value.boolValue ??
        value.arrayValue?.values.map((v) => v.stringValue),
    ]),
  );
try {
  for (const [backend, prefix] of [
    ['phoenix', ''],
    ['langfuse', ''],
    ['phoenix', '/prefix'],
    ['langfuse', '/prefix'],
    ['phoenix', '/slow'],
  ]) {
    const reporter = new TelemetryReporter(
      {
        backend,
        endpoint: `http://127.0.0.1:${server.address().port}${prefix}`,
        apiKey: 'phoenix-private',
        publicKey: 'pk-test',
        secretKey: 'sk-test',
        project: 'otlp-test',
        captureContent: true,
      },
      adapters[backend],
    );
    try {
      await reporter.ready;
      const parent = reporter.openTrace({
        name: 'turn',
        sessionId: 's',
        startTime: new Date('2026-01-01T00:00:00Z'),
        context: { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
      });
      const child = reporter.startGeneration(parent, {
        name: 'llm',
        model: 'test',
        input: { messages: [{ role: 'user', content: 'hello phoenix-private sk-test' }] },
      });
      reporter.endGeneration(child, {
        output: 'world',
        usage: { inputTokens: 2, outputTokens: 3 },
        level: 'ERROR',
      });
      reporter.endSpan(
        parent,
        { output: 'external owner must retain trace IO' },
        new Date('2026-01-01T00:00:01Z'),
      );
      await reporter.flush();
      assert.equal(
        responsesSent,
        captured.length,
        'flush must wait for a collector taking longer than five seconds',
      );
      const batch = captured.at(-1);
      assert.equal(
        batch.path,
        backend === 'phoenix' ? `${prefix}/v1/traces` : `${prefix}/api/public/otel/v1/traces`,
      );
      assert.equal(
        batch.auth,
        backend === 'phoenix'
          ? 'Bearer phoenix-private'
          : `Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`,
      );
      const resources = batch.payload.resourceSpans;
      if (backend === 'phoenix')
        assert.equal(
          attributes(resources[0].resource.attributes)['openinference.project.name'],
          'otlp-test',
        );
      const spans = resources.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
      assert.equal(spans.length, 2);
      const llm = spans.find((s) => s.name === 'llm');
      const turn = spans.find((s) => s.name === 'turn');
      assert.equal(Buffer.from(turn.traceId).toString('hex'), '11111111111111111111111111111111');
      assert.equal(Buffer.from(turn.parentSpanId).toString('hex'), '2222222222222222');
      assert.deepEqual(llm.traceId, turn.traceId);
      assert.deepEqual(llm.parentSpanId, turn.spanId);
      assert.equal(turn.startTimeUnixNano, '1767225600000000000');
      assert.equal(turn.endTimeUnixNano, '1767225601000000000');
      assert.equal(llm.status.code, 2);
      const attrs = attributes(llm.attributes);
      assert.equal(
        attrs[backend === 'phoenix' ? 'openinference.span.kind' : 'langfuse.observation.type'],
        backend === 'phoenix' ? 'LLM' : 'generation',
      );
      assert.ok(
        !JSON.stringify(batch.payload).includes(
          backend === 'phoenix' ? 'phoenix-private' : 'sk-test',
        ),
      );
      assert.equal(attributes(turn.attributes)['langfuse.trace.output'], undefined);
    } finally {
      await reporter.shutdown();
    }
  }
  console.log(
    'OTLP_OK (both adapters: protobuf, auth, resource, IDs, parents, clocks, status, redaction)',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
