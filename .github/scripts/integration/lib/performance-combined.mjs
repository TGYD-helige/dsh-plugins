/** Real plugin composition, with a deterministic agent fixture instead of an LLM. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import protobuf from 'protobufjs';
import { Config as A2aConfig, apply as a2a } from '../../../../packages/dsh-a2a/lib/index.js';
import { apply as policy } from '../../../../packages/dsh-policy/lib/index.js';
import {
  Config as StorageConfig,
  apply as storage,
} from '../../../../packages/dsh-storage/lib/index.js';
import {
  Config as TelemetryConfig,
  apply as telemetry,
} from '../../../../packages/dsh-telemetry/lib/index.js';
import { performanceDatabase } from './performance-database.mjs';

const results = [];
const wireSchema = await protobuf.load(
  fileURLToPath(new URL('./otlp-trace.proto', import.meta.url)),
);
const Request = wireSchema.lookupType('ExportTraceServiceRequest');
for (const combined of [false, true]) {
  const ctx = new Context();
  const db = await performanceDatabase();
  await db.backend.close();
  await db.client.$disconnect();
  let exports = 0;
  let generations = 0;
  const receiver = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = Request.toObject(Request.decode(Buffer.concat(chunks)));
      for (const resource of payload.resourceSpans ?? [])
        for (const scope of resource.scopeSpans ?? [])
          for (const span of scope.spans ?? [])
            if (
              span.attributes?.some(
                (item) =>
                  item.key === 'openinference.span.kind' && item.value.stringValue === 'LLM',
              )
            )
              generations++;
      exports++;
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  let policyChecks = 0;
  let sequence = 0;
  ctx.provide('agents', {
    async create(options) {
      const session = { id: options.sessionId, header: { id: options.sessionId } };
      const emit = (type, data) =>
        ctx.emit('session/event', session, { type, seq: ++sequence, time: Date.now(), data });
      let work = Promise.resolve();
      const agent = {
        id: session.id,
        session,
        status: 'idle',
        options: {},
        followup(message) {
          ctx.emit('agent/inbox/inserted', { agent, message });
          ctx.emit('agent/inbox/claimed', { agent, message, turn: 0 });
          work = (async () => {
            emit('turn/start', { turn: 0 });
            emit('user/message', message);
            const decision = await ctx.waterfall(
              'tools/pre-execute',
              {
                agent,
                callId: `call-${session.id}`,
                name: 'bash',
                arguments: { command: 'echo safe' },
              },
              async () => ({ kind: 'allow' }),
            );
            assert.equal(decision.kind, 'allow');
            policyChecks++;
            for await (const _ of ctx.waterfall(
              'llm/stream',
              {
                sessionId: session.id,
                provider: 'fixture',
                model: 'fixture',
                messages: [],
              },
              async function* () {
                for (let i = 0; i < 32; i++) yield { type: 'text-delta', index: 0, text: 'answer' };
                yield { type: 'finish', reason: { kind: 'stop' } };
              },
            )) {
              /* the real collector sees every fixture chunk */
            }
            emit('assistant/message', {
              turn: 0,
              step: 0,
              message: {
                id: `reply-${session.id}`,
                role: 'assistant',
                content: [{ type: 'text', text: 'answer' }],
                source: { kind: 'model', provider: 'fixture', model: 'fixture' },
              },
            });
            emit('turn/end', { turn: 0, reason: { kind: 'completed' } });
            await ctx.parallel('session/flush', session);
          })();
          void work.catch(() => {});
        },
        whenIdle: () => work,
        cancel() {},
      };
      return {
        agent,
        async dispose() {
          await work;
          ctx.emit('session/disposed', session);
        },
      };
    },
  });
  try {
    if (combined) {
      await telemetry(
        ctx,
        TelemetryConfig({
          enabled: true,
          backend: 'phoenix',
          endpoint: `http://127.0.0.1:${receiver.address().port}/v1/traces`,
          apiKey: 'benchmark-only',
          project: 'performance',
          maxPayloadBytes: 4096,
        }),
      );
      storage(
        ctx,
        StorageConfig({
          enabled: true,
          database: { enabled: true, provider: 'sqlite', url: db.url },
        }),
      );
      await ctx.parallel('session/flush', { id: 'startup' });
      policy(ctx, {
        enabled: true,
        rules: [
          { tool: '*', decision: 'allow' },
          { tool: 'bash', decision: 'deny', commandPrefix: 'rm', priority: 10 },
        ],
      });
      assert.equal(
        (
          await ctx.waterfall(
            'tools/pre-execute',
            {
              name: 'bash',
              arguments: { command: 'rm /fixture' },
            },
            async () => ({ kind: 'allow' }),
          )
        ).kind,
        'deny',
      );
    }
    const server = await a2a(
      ctx,
      A2aConfig({ enabled: true, host: '127.0.0.1', port: 0, agent: { model: '' } }),
    );
    let started;
    let cpuAt;
    for (let batch = -1; batch < 8; batch++) {
      if (batch === 0) {
        started = performance.now();
        cpuAt = process.cpuUsage();
      }
      await Promise.all(
        Array.from({ length: 8 }, async (_, index) => {
          const response = await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: batch * 8 + index,
              method: 'SendMessage',
              params: {
                message: {
                  messageId: `message-${batch}-${index}`,
                  role: 'ROLE_USER',
                  parts: [{ text: 'fixture' }],
                },
              },
            }),
            signal: AbortSignal.timeout(10_000),
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(
            body.result?.task?.status?.state,
            'TASK_STATE_INPUT_REQUIRED',
            JSON.stringify(body),
          );
        }),
      );
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuAt);
    assert.equal(policyChecks, 72);
    await ctx.fiber.dispose();
    await db.client.$connect();
    const messages = await db.client.aiMessage.count();
    assert.equal(messages, combined ? 144 : 0);
    assert.equal(exports > 0, combined);
    assert.equal(generations, combined ? 72 : 0);
    results.push({
      mode: combined ? 'a2a-storage-telemetry-policy' : 'a2a-only',
      requests: 64,
      concurrency: 8,
      elapsedMs,
      requestsPerSecond: 64_000 / elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      rss: process.memoryUsage().rss,
      storedMessages: messages,
      exportRequests: exports,
      generations,
    });
  } finally {
    await ctx.fiber.dispose();
    receiver.closeAllConnections();
    await new Promise((resolve) => receiver.close(resolve));
    await db.close();
  }
}
writeFileSync(
  'performance-combined.json',
  JSON.stringify(
    {
      results,
      note: 'Synthetic agent, real plugins/HTTP/SQLite/OTLP. Client, server and receiver share this process; CPU is total fixture CPU.',
    },
    null,
    2,
  ),
);
console.log(
  'combined plugins: 64 settled tasks plus eight warmups, 144 mirrored messages and real exports verified',
);
