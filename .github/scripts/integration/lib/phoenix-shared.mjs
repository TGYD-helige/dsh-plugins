/** Phoenix API read-back, normalized to the existing backend-independent shape evaluators. */
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
    metadata: parse(attr('metadata')),
    sessionId: attr('session.id'),
    spanKind: kind,
    attributes,
    statusCode: span.status_code,
    startTime: span.start_time,
    endTime: span.end_time,
  };
}

export async function runPhoenixVerification({ fromStartTime, codeword, evaluate }) {
  const origin = process.env.PHOENIX_COLLECTOR_ENDPOINT.replace(/\/v1\/traces\/?$/, '').replace(
    /\/$/,
    '',
  );
  const project = encodeURIComponent(process.env.PHOENIX_PROJECT_NAME);
  const deadline = Date.now() + 5 * 60_000;
  let state = 'no matching Phoenix trace';
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
      for (const span of trace) {
        if (
          !span.startTime ||
          !span.endTime ||
          Date.parse(span.endTime) < Date.parse(span.startTime)
        )
          problems.push('invalid timestamps');
        if (
          span.parentObservationId &&
          !trace.some((parent) => parent.id === span.parentObservationId) &&
          span.name !== 'a2a-task'
        )
          problems.push(`missing parent of ${span.name}`);
      }
      if (!problems.length) return { ok: true, state: 'Phoenix API read-back verified' };
      state = problems.join('; ');
    }
    await delay(Math.min(10_000, Math.max(0, deadline - Date.now())));
  }
  return { ok: false, state };
}

/** Preserve backend semantics that the cross-backend display normalization cannot express. */
export function evaluatePhoenixSemantics(observations) {
  const problems = [];
  for (const span of observations) {
    const expectedKind =
      span.name === 'dsh-turn' || span.name === 'a2a-task' || span.name?.startsWith('subagent')
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
    if (span.type !== 'GENERATION') continue;
    const attributes = span.attributes;
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
