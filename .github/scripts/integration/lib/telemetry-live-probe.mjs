/** Small real exporter probe: log status/latency only, never endpoint/auth/payload. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { adapters } from '../../../../packages/dsh-telemetry/lib/adapters/index.js';
import { TelemetryReporter } from '../../../../packages/dsh-telemetry/lib/core/otel.js';

export async function probeTelemetry(backend) {
  const adapter = adapters[backend];
  const config = { backend, captureContent: false };
  const connection = adapter.resolve(config, process.env);
  const known = new Set(['api', 'public', 'otel', 'v1', 'v2', 'traces']);
  const route = new URL(connection.endpoint).pathname
    .split('/')
    .map((segment) => (known.has(segment) ? segment : segment ? '*' : ''))
    .join('/');
  console.log(`OTLP probe ${backend}: normalized route ${route}`);
  const responses = [];
  const pending = new Set();
  const server = createServer((req, res) => {
    const forwarding = (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const started = Date.now();
      try {
        const response = await fetch(connection.endpoint, {
          method: 'POST',
          headers: { ...connection.headers, 'content-type': req.headers['content-type'] },
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(20_000),
        });
        responses.push(response.status);
        console.log(
          `OTLP probe ${backend}: content-type ${response.headers.get('content-type')}, allow ${(response.headers.get('allow') ?? '').replace(/[^A-Z, ]/g, '')}, redirected ${response.redirected}`,
        );
        console.log(
          `OTLP probe ${backend}: HTTP ${response.status}, ${Date.now() - started}ms, ${req.headers['content-type']}`,
        );
        const body = Buffer.from(await response.arrayBuffer());
        res
          .writeHead(response.status, {
            'content-type': response.headers.get('content-type') || 'application/x-protobuf',
          })
          .end(body);
      } catch {
        responses.push(0);
        console.log(`OTLP probe ${backend}: network/timeout failure`);
        res.writeHead(502).end();
      }
    })();
    pending.add(forwarding);
    void forwarding.finally(() => pending.delete(forwarding));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const reporter = new TelemetryReporter(config, {
    ...adapter,
    resolve: () => ({
      ...connection,
      endpoint: `http://127.0.0.1:${server.address().port}/v1/traces`,
    }),
  });
  try {
    await reporter.ready;
    const span = reporter.openTrace({ name: `ci-otel-probe-${backend}` });
    assert.ok(span, 'telemetry provider must initialize');
    reporter.endSpan(span);
    await reporter.flush();
    await Promise.all(pending);
    assert.deepEqual(responses, [200], 'real backend must accept the shared protobuf export');
  } finally {
    await reporter.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
}
