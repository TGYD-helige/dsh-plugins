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
      const problems = evaluate(trace, codeword);
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
