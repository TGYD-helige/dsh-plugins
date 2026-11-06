/** Real shared protobuf exporter → loopback receiver, no backend/LLM credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
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
    const wire = Buffer.concat(chunks);
    const compression = req.headers['content-encoding'];
    const decoded = compression === 'gzip' ? gunzipSync(wire) : wire;
    const payload = Request.toObject(Request.decode(decoded), { longs: String });
    captured.push({
      path: req.url,
      auth: req.headers.authorization,
      payload,
      compression,
      bytes: wire.length,
    });
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
  for (const [backend, prefix, taskRoot = false] of [
    ['phoenix', ''],
    ['langfuse', ''],
    ['phoenix', '/prefix'],
    ['langfuse', '/prefix'],
    ['phoenix', '/slow'],
    ['phoenix', '/compressed'],
    ['phoenix', '/task', true],
    ['langfuse', '/task', true],
  ]) {
    const previousCompression = process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION;
    if (prefix === '/compressed') process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION = 'gzip';
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
        traceId: taskRoot ? '33333333333333333333333333333333' : undefined,
        context: taskRoot
          ? undefined
          : { traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
      });
      if (taskRoot) reporter.updateSpan(parent, { input: 'task prompt' });
      const child = reporter.startGeneration(parent, {
        name: 'llm',
        model: 'test',
        input: {
          messages: [
            {
              role: 'user',
              content:
                prefix === '/compressed'
                  ? 'large prompt '.repeat(10_000)
                  : 'hello phoenix-private sk-test',
            },
          ],
        },
      });
      reporter.endGeneration(child, {
        output: 'world',
        usage: { inputTokens: 2, outputTokens: 3 },
        level: 'ERROR',
      });
      reporter.endSpan(
        parent,
        { output: taskRoot ? 'task answer' : 'external owner must retain trace IO' },
        new Date('2026-01-01T00:00:01Z'),
      );
      await reporter.flush();
      assert.equal(
        responsesSent,
        captured.length,
        'flush must wait for a collector taking longer than five seconds',
      );
      const batch = captured.at(-1);
      if (prefix === '/compressed') {
        assert.equal(batch.compression, 'gzip');
        assert.ok(batch.bytes < 4096, 'large repetitive prompts should compress before transport');
        assert.ok(JSON.stringify(batch.payload).includes('large prompt '));
      }
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
      assert.equal(
        Buffer.from(turn.traceId).toString('hex'),
        taskRoot ? '33333333333333333333333333333333' : '11111111111111111111111111111111',
      );
      assert.equal(
        Buffer.from(turn.parentSpanId ?? []).toString('hex'),
        taskRoot ? '' : '2222222222222222',
      );
      if (taskRoot) {
        const rootAttrs = attributes(turn.attributes);
        assert.equal(
          rootAttrs[backend === 'phoenix' ? 'input.value' : 'langfuse.observation.input'],
          'task prompt',
        );
        assert.equal(
          rootAttrs[backend === 'phoenix' ? 'output.value' : 'langfuse.observation.output'],
          'task answer',
        );
      }
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
      assert.equal(
        attributes(turn.attributes)['langfuse.trace.output'],
        taskRoot && backend === 'langfuse' ? 'task answer' : undefined,
      );
    } finally {
      await reporter.shutdown();
      if (previousCompression === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION;
      else process.env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION = previousCompression;
    }
  }
  console.log(
    'OTLP_OK (both adapters: protobuf, auth, resource, IDs, parents, clocks, status, redaction)',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
