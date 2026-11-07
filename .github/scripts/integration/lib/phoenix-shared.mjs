/** Phoenix API read-back, normalized to the existing backend-independent shape evaluators. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export function phoenixObservation(span) {
  const attributes = span.attributes ?? {};
  const attr = (key) => attributes[key];
  const parse = (value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };
  const kind = span.span_kind ?? attr('openinference.span.kind');
  return {
    id: span.context.span_id,
    traceId: span.context.trace_id,
    parentObservationId: span.parent_id || null,
    name: span.name,
    type: kind === 'LLM' ? 'GENERATION' : kind === 'TOOL' ? 'TOOL' : 'SPAN',
    input: parse(attr('input.value')),
    output: parse(attr('output.value')),
    model: attr('llm.model_name'),
    usageDetails: { total: attr('llm.token_count.total') ?? 0 },
    // Phoenix decodes metadata JSON at ingestion, then flattens its fields in REST responses.
    metadata:
      parse(attr('metadata')) ??
      Object.fromEntries(
        Object.entries(attributes)
          .filter(([key]) => key.startsWith('metadata.'))
          .map(([key, value]) => [key.slice('metadata.'.length), value]),
      ),
    sessionId: attr('session.id'),
    spanKind: kind,
    attributes,
    events: span.events ?? [],
    statusCode: span.status_code,
    startTime: span.start_time,
    endTime: span.end_time,
  };
}

function phoenixOrigin() {
  return process.env.PHOENIX_COLLECTOR_ENDPOINT.replace(/\/v1\/traces\/?$/, '').replace(/\/$/, '');
}

export async function verifyPhoenixSessionIO(sessionId, expectedInput, expectedOutput) {
  const origin = phoenixOrigin();
  const headers = { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` };
  const response = await fetch(`${origin}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `Phoenix session read-back HTTP ${response.status}`);
  const session = await response.json();
  assert.equal(session.data.session_id, sessionId);
  const result = await fetch(`${origin}/graphql`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      query: `query { node(id: ${JSON.stringify(session.data.id)}) { ... on ProjectSession { firstInput { value } lastOutput { value } } } }`,
    }),
  });
  assert.ok(result.ok, `Phoenix session IO HTTP ${result.status}`);
  const body = await result.json();
  assert.ok(!body.errors?.length, 'Phoenix session IO query failed');
  const input = body.data?.node?.firstInput?.value;
  const output = body.data?.node?.lastOutput?.value;
  assert.ok(typeof input === 'string' && input === expectedInput, 'missing session first input');
  assert.ok(
    typeof output === 'string' && output.trim() && output === expectedOutput,
    'missing session last output',
  );
}

export async function runPhoenixVerification({ fromStartTime, codeword, evaluate }) {
  const origin = phoenixOrigin();
  const project = encodeURIComponent(process.env.PHOENIX_PROJECT_NAME);
  const deadline = Date.now() + 5 * 60_000;
  let state = 'no matching Phoenix trace';
  let versionReported = false;
  while (Date.now() < deadline) {
    const observations = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({
        limit: '100',
        start_time: fromStartTime,
        end_time: new Date().toISOString(),
      });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`${origin}/v1/projects/${project}/spans?${query}`, {
        headers: { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
      // A new project may not be visible until the first batch has ingested.
      if (response.status === 404) break;
      if (!response.ok) throw new Error(`Phoenix read-back HTTP ${response.status}`);
      if (!versionReported) {
        const version = response.headers.get('x-phoenix-server-version');
        console.log(
          `Phoenix server version: ${version && /^[a-zA-Z0-9.+_-]{1,60}$/.test(version) ? version : 'not reported'}`,
        );
        versionReported = true;
      }
      const body = await response.json();
      observations.push(...body.data.map(phoenixObservation));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    const traces = new Set(
      observations
        .filter((o) => JSON.stringify([o.input, o.output]).includes(codeword))
        .map((o) => o.traceId),
    );
    for (const traceId of traces) {
      const trace = observations.filter((o) => o.traceId === traceId);
      const problems = [...evaluate(trace, codeword), ...evaluatePhoenixSemantics(trace)];
      if (!problems.length) return { ok: true, state: 'Phoenix API read-back verified', trace };
      state = problems.join('; ');
    }
    await delay(Math.min(10_000, Math.max(0, deadline - Date.now())));
  }
  return { ok: false, state };
}

/** Preserve backend semantics that the cross-backend display normalization cannot express. */
export function evaluatePhoenixSemantics(observations) {
  const problems = [];
  const ids = new Set(observations.map((span) => span.id));
  for (const span of observations) {
    if (!span.startTime || !span.endTime || Date.parse(span.endTime) < Date.parse(span.startTime))
      problems.push('invalid timestamps');
    if (span.parentObservationId && !ids.has(span.parentObservationId))
      problems.push(`missing parent of ${span.name}`);
    const expectedKind =
      span.name === 'dsh-turn' ||
      span.name === 'agent:turn' ||
      span.name === 'a2a-task' ||
      span.name?.startsWith('subagent')
        ? 'AGENT'
        : span.name?.startsWith('hook:') || span.name === 'llm-request'
          ? 'CHAIN'
          : span.type === 'GENERATION'
            ? 'LLM'
            : span.type === 'TOOL'
              ? 'TOOL'
              : undefined;
    if (expectedKind && span.spanKind !== expectedKind)
      problems.push(`${span.name} must have OpenInference kind ${expectedKind}`);
    if (span.type === 'TOOL') {
      if (span.attributes['tool.name'] !== span.metadata?.toolName || !span.metadata?.toolName)
        problems.push('missing clean tool name');
      if (span.attributes['tool.id'] !== span.metadata?.callId || !span.metadata?.callId)
        problems.push('missing tool call ID');
    }
    if (span.type !== 'GENERATION') continue;
    if (
      span.metadata?.source !== 'compaction/summary' &&
      span.output &&
      (typeof span.output === 'string' ||
        span.output.content ||
        span.output.thinking?.length ||
        span.output.tool_calls?.length)
    ) {
      const firstTokens = (span.events ?? []).filter((event) => event.name === 'first_token');
      const at = Date.parse(firstTokens[0]?.timestamp);
      if (
        firstTokens.length !== 1 ||
        !Number.isFinite(at) ||
        at < Date.parse(span.startTime) ||
        at > Date.parse(span.endTime)
      )
        problems.push('missing or invalid first token event');
    }
    const attributes = span.attributes;
    if (span.input?.provider && attributes['llm.system'] !== span.input.provider)
      problems.push('missing LLM system/provider');
    const messages = [
      ...(span.input?.system ? [{ role: 'system', content: span.input.system }] : []),
      ...(Array.isArray(span.input?.messages) ? span.input.messages : []),
    ];
    for (const [i, message] of messages.entries()) {
      const prefix = `llm.input_messages.${i}.message`;
      if (attributes[`${prefix}.role`] !== message.role) problems.push(`missing ${prefix}.role`);
      if (message.toolCallId && attributes[`${prefix}.tool_call_id`] !== message.toolCallId)
        problems.push('tool result linkage missing');
      const calls = Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool-call')
        : [];
      for (const [j, call] of calls.entries()) {
        const prefixCall = `${prefix}.tool_calls.${j}.tool_call`;
        if (
          attributes[`${prefixCall}.id`] !== call.id ||
          attributes[`${prefixCall}.function.name`] !== call.name ||
          attributes[`${prefixCall}.function.arguments`] !== call.arguments
        )
          problems.push('input tool call mapping missing');
      }
    }
    const output = span.output;
    const calls = output?.tool_calls ?? [];
    for (const [i, call] of calls.entries()) {
      if (attributes[`llm.output_messages.0.message.tool_calls.${i}.tool_call.id`] !== call.id)
        problems.push('output tool call ID missing');
    }
    const text = typeof output === 'string' ? output : output?.content;
    if (typeof text === 'string' && attributes['llm.output_messages.0.message.content'] !== text)
      problems.push('assistant message content missing');
    const input = Number(attributes['llm.token_count.prompt']);
    const completion = Number(attributes['llm.token_count.completion']);
    const total = Number(attributes['llm.token_count.total']);
    if (Number.isFinite(total) && input + completion !== total)
      problems.push('Phoenix inclusive token totals disagree');
    const reasoning = Number(attributes['llm.token_count.completion_details.reasoning'] ?? 0);
    if (reasoning > completion) problems.push('reasoning exceeds completion tokens');
  }
  return problems;
}
