/** Synthetic plugin overhead; workers measure no receiver CPU and use no external credentials. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import protobuf from 'protobufjs';
import { apply, Config } from '../../../../packages/dsh-telemetry/lib/index.js';

const modes = [
  'disabled',
  'phoenix-content-off',
  'phoenix-content-on',
  'langfuse-content-off',
  'langfuse-content-on',
];
const workload = {
  warmupTurns: 16,
  samples: 5,
  turnsPerSample: 64,
  chunksPerTurn: 128,
  chunkBytes: 64,
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function worker(mode, port) {
  assert.ok(modes.includes(mode));
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.equal(typeof globalThis.gc, 'function', 'worker requires --expose-gc');
  const ctx = new Context();
  const startup = performance.now();
  await apply(
    ctx,
    Config({
      enabled: mode !== 'disabled',
      backend: mode.startsWith('langfuse') ? 'langfuse' : 'phoenix',
      captureContent: mode.endsWith('-on'),
      maxPayloadBytes: 32 * 1024,
      endpoint: `http://127.0.0.1:${port}/${mode}/v1/traces`,
      apiKey: 'benchmark-only',
      publicKey: 'benchmark-only',
      secretKey: 'benchmark-only',
    }),
  );
  const startupMs = performance.now() - startup;
  const delta = { type: 'text-delta', index: 0, text: 'x'.repeat(workload.chunkBytes) };
  let sequence = 0;
  let peakHeapBytes = 0;
  async function turns(count) {
    for (let turn = 0; turn < count; turn++) {
      const session = { id: `session-${turn}`, header: { id: `session-${turn}` } };
      const event = (type, data) =>
        ctx.emit('session/event', session, {
          type,
          seq: ++sequence,
          time: Date.now(),
          data,
        });
      ctx.emit('telemetry/context', session.id, { metadata: { turn } });
      event('turn/start', { turn: 0 });
      event('user/message', { role: 'user', content: [{ type: 'text', text: 'benchmark' }] });
      let received = 0;
      for await (const chunk of ctx.waterfall(
        'llm/stream',
        {
          provider: 'synthetic',
          model: 'fixture',
          sessionId: session.id,
          messages: [],
        },
        async function* () {
          for (let index = 0; index < workload.chunksPerTurn; index++) yield delta;
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      )) {
        if (received < workload.chunksPerTurn) assert.equal(chunk, delta);
        received++;
      }
      assert.equal(received, workload.chunksPerTurn + 1);
      event('turn/end', { turn: 0, reason: { kind: 'completed' } });
      ctx.emit('session/disposed', session);
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    }
  }
  const samples = [];
  let shutdownMs;
  try {
    await turns(workload.warmupTurns);
    await ctx.parallel('session/flush', { id: 'checkpoint' });
    for (let sample = 0; sample < workload.samples; sample++) {
      globalThis.gc();
      const heapBeforeBytes = process.memoryUsage().heapUsed;
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      await turns(workload.turnsPerSample);
      const streamMs = performance.now() - started;
      const flushStart = performance.now();
      await ctx.parallel('session/flush', { id: 'checkpoint' });
      const flushMs = performance.now() - flushStart;
      const cpu = process.cpuUsage(cpuStart);
      globalThis.gc();
      const heapAfterGcBytes = process.memoryUsage().heapUsed;
      assert.ok(streamMs > 0 && Number.isFinite(streamMs));
      samples.push({
        streamMs,
        flushMs,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        turnsPerSecond: (workload.turnsPerSample * 1000) / streamMs,
        heapBeforeBytes,
        heapAfterGcBytes,
      });
    }
  } finally {
    const started = performance.now();
    await ctx.fiber.dispose();
    shutdownMs = performance.now() - started;
  }
  globalThis.gc();
  return {
    mode,
    startupMs,
    shutdownMs,
    samples,
    peakHeapBytes,
    heapAfterShutdownGcBytes: process.memoryUsage().heapUsed,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    medianStreamMs: median(samples.map((sample) => sample.streamMs)),
    medianCpuMs: median(samples.map((sample) => sample.cpuUserMs + sample.cpuSystemMs)),
    retainedHeapGrowthBytes: samples.at(-1).heapAfterGcBytes - samples[0].heapAfterGcBytes,
  };
}

if (process.argv[2] === '--worker') {
  console.log(JSON.stringify(await worker(process.argv[3], Number(process.argv[4]))));
} else {
  const root = await protobuf.load(fileURLToPath(new URL('./otlp-trace.proto', import.meta.url)));
  const Request = root.lookupType('ExportTraceServiceRequest');
  const received = new Map();
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['content-type'], 'application/x-protobuf');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const wire = Buffer.concat(chunks);
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(wire) : wire;
      const payload = Request.toObject(Request.decode(body));
      const spans = (payload.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
      );
      received.set(req.url, (received.get(req.url) ?? 0) + spans.length);
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const results = [];
  try {
    for (const mode of modes) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--expose-gc',
          fileURLToPath(import.meta.url),
          '--worker',
          mode,
          String(server.address().port),
        ],
        { timeout: 60_000 },
      );
      const result = JSON.parse(stdout);
      assert.equal(result.mode, mode);
      assert.equal(result.samples.length, workload.samples);
      const exportedSpans = received.get(`/${mode}/v1/traces`) ?? 0;
      assert.equal(
        exportedSpans,
        mode === 'disabled'
          ? 0
          : 3 * (workload.warmupTurns + workload.samples * workload.turnsPerSample),
      );
      const baseline = results[0] ?? result;
      result.exportedSpans = exportedSpans;
      result.streamTimeRatioVsDisabled = result.medianStreamMs / baseline.medianStreamMs;
      result.cpuRatioVsDisabled = result.medianCpuMs / baseline.medianCpuMs;
      results.push(result);
      console.log(
        `${mode}: ${result.medianStreamMs.toFixed(2)} ms stream, ${result.medianCpuMs.toFixed(2)} ms CPU, ${exportedSpans} spans`,
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  writeFileSync(
    'performance-metrics.json',
    `${JSON.stringify(
      {
        revision: process.env.GITHUB_SHA ?? null,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        workload,
        results,
        note: 'Synthetic local workload; receiver CPU excluded. Timings and GC/RSS observations have no fixed pass/fail threshold.',
      },
      null,
      2,
    )}\n`,
  );
}
