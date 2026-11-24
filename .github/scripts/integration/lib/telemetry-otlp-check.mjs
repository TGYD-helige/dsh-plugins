/** Real shared protobuf exporter → loopback receiver, no backend/LLM credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import protobuf from 'protobufjs';
import { adapters } from '../../../../packages/dsh-telemetry/lib/adapters/index.js';
import { TelemetryReporter } from '../../../../packages/dsh-telemetry/lib/core/otel.js';
import { apply, Config } from '../../../../packages/dsh-telemetry/lib/index.js';

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
    if (req.url.startsWith('/limited/') && wire.length > 512 * 1024) {
      res.writeHead(413).end();
      return;
    }
    if (req.url.startsWith('/mixed/')) {
      const spans = payload.resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) => spans),
      );
      if (spans.some(({ name }) => name === 'queued failure')) {
        res.writeHead(401).end();
        return;
      }
      await delay(1250);
    }
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
        value.doubleValue ??
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
        startTime: new Date('2026-01-01T00:00:00Z'),
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
        completionStartTime: new Date('2026-01-01T00:00:00.250Z'),
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
      assert.equal(llm.events.length, 1);
      assert.equal(llm.events[0].name, 'first_token');
      assert.equal(llm.events[0].timeUnixNano, '1767225600250000000');
      assert.equal(attributes(llm.attributes)['llm.time_to_first_token_seconds'], 0.25);
      assert.equal(Number(attributes(llm.events[0].attributes).time_to_first_token_ms), 250);
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
  const ctx = new Context();
  let finishLocalWrite;
  const localWrite = new Promise((resolve) => {
    finishLocalWrite = resolve;
  });
  ctx.on('session/flush', () => localWrite);
  await apply(
    ctx,
    Config({
      enabled: true,
      backend: 'phoenix',
      endpoint: `http://127.0.0.1:${server.address().port}/slow/checkpoint`,
    }),
  );
  const baseline = captured.length;
  try {
    const session = { id: 'checkpoint', header: { id: 'checkpoint' } };
    const completeTurn = (turn) => {
      const event = (type, data, offset) =>
        ctx.emit('session/event', session, {
          type,
          seq: 3 * turn + offset,
          time: Date.now(),
          data,
        });
      event('turn/start', { turn }, 1);
      event('user/message', { role: 'user', content: [{ type: 'text', text: 'checkpoint' }] }, 2);
      event('turn/end', { turn, reason: { kind: 'completed' } }, 3);
    };
    completeTurn(0);
    for (let attempts = 0; captured.length === baseline && attempts < 300; attempts++)
      await delay(10);
    assert.equal(captured.at(-1).path, '/slow/checkpoint/v1/traces');
    assert.equal(responsesSent, baseline);
    completeTurn(1);
    let checkpointCompleted = false;
    const checkpointStarted = performance.now();
    const checkpoint = ctx.parallel('session/flush', session).then(() => {
      checkpointCompleted = true;
    });
    await delay(0);
    assert.equal(checkpointCompleted, false);
    finishLocalWrite();
    await checkpoint;
    assert.equal(responsesSent, baseline, 'checkpoint must complete before the collector responds');
    console.log(
      `OTLP_CHECKPOINT_OK (${Math.round(performance.now() - checkpointStarted)} ms while collector response is pending)`,
    );
  } finally {
    finishLocalWrite();
    await ctx.fiber.dispose();
  }
  assert.equal(responsesSent, baseline + 2, 'graceful shutdown must drain both exports');
  const reporterAt = (prefix) =>
    new TelemetryReporter(
      {
        backend: 'phoenix',
        endpoint: `http://127.0.0.1:${server.address().port}/${prefix}`,
        captureContent: true,
      },
      adapters.phoenix,
    );
  const limited = reporterAt('limited');
  try {
    await limited.ready;
    const responsesBefore = responsesSent;
    for (const name of ['first turn', 'second turn'])
      limited.endSpan(limited.openTrace({ name }), { input: 'x'.repeat(300 * 1024) });
    await limited.flush();
    const sizes = captured.slice(-3).map(({ bytes }) => bytes);
    assert.ok(sizes[0] > 512 * 1024 && sizes.slice(1).every((size) => size <= 512 * 1024));
    assert.equal(responsesSent, responsesBefore + 2, 'both split requests must be accepted');
  } finally {
    await limited.shutdown();
  }
  const mixed = reporterAt('mixed');
  try {
    await mixed.ready;
    const responsesBefore = responsesSent;
    const requestsBefore = captured.length;
    mixed.endSpan(mixed.openTrace({ name: 'in flight' }));
    for (let attempts = 0; captured.length === requestsBefore && attempts < 300; attempts++)
      await delay(10);
    assert.equal(captured.at(-1).path, '/mixed/v1/traces');
    mixed.endSpan(mixed.openTrace({ name: 'queued failure' }));
    await mixed.shutdown();
    assert.equal(captured.length, requestsBefore + 2);
    assert.equal(responsesSent, responsesBefore + 1, 'shutdown must await the earlier success');
  } finally {
    await mixed.shutdown();
  }
  console.log(
    'OTLP_OK (both adapters: protobuf, auth, resource, IDs, parents, clocks, status, redaction)',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
