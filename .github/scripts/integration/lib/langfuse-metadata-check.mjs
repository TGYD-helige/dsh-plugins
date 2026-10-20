import assert from 'node:assert/strict';
import { apply as applyMetadataBridge } from './metadata-context-bridge.mjs';
import { capturedToObservations, evaluateSubagentTrace } from './langfuse-shared.mjs';
import { integrationModel } from './ci-shared.mjs';

function objectValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Check the top-level metadata returned by Langfuse, across the whole child tree. */
export function evaluateMetadataTrace(observations, codeword) {
  const problems = evaluateSubagentTrace(observations, codeword);
  const root = observations.find((o) => o.name === 'dsh-turn' && !o.parentObservationId);
  if (!root) return problems;
  const requestId = root.metadata?.requestId;
  if (typeof requestId !== 'string' || !requestId.startsWith('metadata-request:')) {
    problems.push('root has no request metadata identity');
  }
  for (const observation of observations) {
    const metadata = observation.metadata ?? {};
    const need = (condition, message) => {
      if (!condition) problems.push(`${observation.name}: ${message}`);
    };
    need(metadata.projectId === 'metadata-project', 'project metadata is missing or mutated');
    need(metadata.workspaceId === 'metadata-workspace', 'workspace metadata is missing');
    need(metadata.requestId === requestId, 'request metadata did not propagate');
    const routing = objectValue(metadata.routing);
    need(routing?.region === 'original-region', 'nested metadata was not snapshotted');
    need(routing?.credential === '[REDACTED]', 'nested credential was not redacted');
    need(JSON.stringify(objectValue(metadata.labels)) === '["original-label"]',
      'nested array was not snapshotted');
    need(metadata.optional === null, 'null metadata was lost');
    need(metadata.empty === '', 'empty metadata was lost');
    // Langfuse v3's read API JSON-parses top-level metadata strings. Exact
    // export types are checked separately against the actual OTLP payload.
    need(String(metadata.numericString) === '123', 'numeric string metadata value changed');
    need(metadata.attempt === 2, 'number metadata changed type');
    need(metadata.interactive === true, 'boolean metadata changed type');
    if (observation.type === 'TOOL') {
      need(metadata.callId && metadata.callId !== 'caller-shadow', 'native callId was overwritten');
      need(metadata.toolName && metadata.toolName !== 'caller-shadow', 'native toolName was overwritten');
    }
    if (observation.name === 'llm-request') {
      need(metadata.provider && metadata.provider !== 'caller-shadow', 'native provider was overwritten');
    }
  }
  if (Number(root.metadata?.turn) < 0) problems.push('native turn was overwritten');
  if (JSON.stringify(observations).includes('sk-lf-metadata-private')) {
    problems.push('metadata leaked a credential');
  }
  return problems;
}

/** Real Session + tool runtime + SDK wire checks; no LLM or Langfuse credentials. */
export async function checkMetadataWire({ require, connection, captured }) {
  const { apply } = await import('../../../../packages/dsh-langfuse/lib/index.js');
  const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
  const { SessionStore } = await import(require.resolve('@deepseek-ai/dsh-session'));
  const { createRequire } = await import('node:module');
  const toolRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'));
  const { default: SystemPrompt } = await import(toolRequire.resolve('@deepseek-ai/dsh-system-prompt'));
  const { default: ToolRuntime, defineTool } = await import(require.resolve('@deepseek-ai/dsh-tools'));
  const ctx = new Context();
  const offset = captured.length;
  const marker = 'ci-marker-metadata-sdk';
  try {
    new SessionStore(ctx);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await apply(ctx, { ...connection, enabled: true, traceName: 'dsh-turn', captureContent: true });
    await ctx.plugin({ name: 'metadata-context-fixture', apply: applyMetadataBridge });
    const first = ctx.sessions.create();
    const second = ctx.sessions.create();
    const streamFor = async (session) => {
      const stream = ctx.waterfall('llm/stream', {
        provider: 'metadata-provider',
        model: integrationModel(),
        sessionId: session.id,
        messages: [{ role: 'user', content: [{ type: 'text', text: marker }] }],
        signal: new AbortController().signal,
      }, async function* () {
        yield { type: 'text-delta', index: 0, text: 'metadata answer' };
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      });
      for await (const _ of stream) { /* drain the real waterfall */ }
    };
    const execute = (session, name, callId) => ctx.tools.execute({
      name, arguments: { path: marker }, callId, agent: { id: session.id },
      signal: new AbortController().signal,
    });
    const output = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    };
    ctx.tools.register(defineTool({
      name: 'read', description: 'read the fixture marker',
      parameters: { path: { type: 'string', required: true } },
      output, execute: () => marker,
    }));
    ctx.tools.register(defineTool({
      name: 'subagent', description: 'delegate a scripted child session',
      parameters: { path: { type: 'string', required: true } },
      output,
      execute: async () => {
        const child = ctx.sessions.create(undefined, {
          meta: { parentSession: first.id, origin: 'subagent', delegationDepth: 1 },
        });
        const info = { id: child.id, runId: `run-${child.id}`, provider: 'spawn', local: true };
        ctx.emit('subagent/start', info);
        child.append('turn/start', { turn: 0 });
        await streamFor(child);
        assert.equal((await execute(child, 'read', 'child-call')).isError, false);
        child.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
        ctx.emit('subagent/end', { ...info, stopReason: 'completed' });
        return marker;
      },
    }));
    first.append('turn/start', { turn: 0 });
    second.append('turn/start', { turn: 0 });
    await Promise.all([streamFor(first), streamFor(second)]);
    assert.equal((await execute(first, 'subagent', 'delegate-call')).isError, false);
    assert.equal((await execute(second, 'read', 'other-call')).isError, false);
    for (const session of [first, second]) {
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    }
    await ctx.parallel('session/flush', first);
    const observations = capturedToObservations(captured.slice(offset));
    const firstRoot = observations.find((o) => o.name === 'dsh-turn' && o.sessionId === first.id);
    const firstTree = observations.filter((o) => o.traceId === firstRoot?.traceId);
    assert.deepEqual(evaluateMetadataTrace(firstTree, marker), []);
    const secondTree = observations.filter((o) => o.sessionId === second.id);
    assert.ok(secondTree.length >= 4, 'the overlapping session must export its own observations');
    for (const observation of secondTree) {
      assert.equal(observation.metadata.requestId, `metadata-request:${second.id}`);
      assert.notEqual(observation.traceId, firstRoot.traceId);
    }
    for (const span of captured.slice(offset)) {
      const metadata = span.attributes.find((a) => a.key === 'langfuse.observation.metadata');
      assert.ok(metadata, 'custom metadata must cross the real OTLP boundary');
      assert.equal(JSON.parse(metadata.value.stringValue).numericString, '123');
    }
    assert.doesNotMatch(JSON.stringify(captured.slice(offset)),
      /sk-lf-metadata-private|mutated-after-emission/);

    const nextOffset = captured.length;
    first.append('turn/start', { turn: 1 });
    await streamFor(first);
    assert.equal((await execute(first, 'read', 'next-call')).isError, false);
    first.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await ctx.parallel('session/flush', first);
    const next = capturedToObservations(captured.slice(nextOffset));
    assert.ok(next.length >= 4, 'the next turn must export model and tool observations');
    for (const observation of next) {
      assert.equal(observation.metadata?.requestId, undefined, 'request metadata is consumed once');
      assert.equal(observation.metadata?.projectId, undefined, 'request metadata must not leak to the next turn');
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
