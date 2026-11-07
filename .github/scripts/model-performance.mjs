/** Aggregate only CI observer records; this command never calls a model. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const finite = (values) => values.filter(Number.isFinite);
const sum = (values) => {
  const present = finite(values);
  return present.length ? present.reduce((total, value) => total + value, 0) : null;
};
const percentile = (values, fraction) => {
  const present = finite(values).sort((a, b) => a - b);
  return present.length ? present[Math.ceil(present.length * fraction) - 1] : null;
};

export function summarizeModelPerformance(calls) {
  const groups = new Map();
  for (const call of calls) {
    const key = JSON.stringify([call.provider, call.model, call.purpose]);
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  return {
    samples: calls.length,
    calls,
    groups: [...groups.values()].map((rows) => {
      const rated = rows.filter((row) => Number.isFinite(row.outputTokens) && row.decodeMs > 0);
      const outcomes = Object.create(null);
      for (const row of rows) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
      return {
        provider: rows[0].provider,
        requestedModel: rows[0].model,
        purpose: rows[0].purpose,
        calls: rows.length,
        outcomes,
        durationP50Ms: percentile(
          rows.map((row) => row.durationMs),
          0.5,
        ),
        durationP95Ms: percentile(
          rows.map((row) => row.durationMs),
          0.95,
        ),
        firstTokenP50Ms: percentile(
          rows.map((row) => row.firstTokenMs),
          0.5,
        ),
        firstTokenP95Ms: percentile(
          rows.map((row) => row.firstTokenMs),
          0.95,
        ),
        totalInputTokens: sum(rows.map((row) => row.totalInputTokens)),
        outputTokens: sum(rows.map((row) => row.outputTokens)),
        reasoningTokens: sum(rows.map((row) => row.reasoningTokens)),
        outputTokensPerSecond: rated.length
          ? (sum(rated.map((row) => row.outputTokens)) * 1000) /
            sum(rated.map((row) => row.decodeMs))
          : null,
      };
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.DSH_MODEL_PERFORMANCE_OUTPUT;
  const calls =
    path && existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const report = {
    revision: process.env.INTEGRATION_CHECKOUT_REF ?? process.env.GITHUB_SHA ?? 'local',
    scenario: process.env.DSH_MODEL_PERFORMANCE_SCENARIO,
    scenarioOutcome: process.env.DSH_MODEL_PERFORMANCE_OUTCOME,
    ...summarizeModelPerformance(calls),
  };
  writeFileSync('model-performance.json', `${JSON.stringify(report, null, 2)}\n`);
  const format = (value) => (Number.isFinite(value) ? value.toFixed(2) : 'n/a');
  const text = [
    '### Real-model performance',
    '',
    `Observed ${report.samples} existing model stream(s); no additional requests.`,
    '',
    '| Requested model / purpose | Calls | Duration p50/p95 ms | First token p50/p95 ms | Output tokens/s |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.groups.map(
      (group) =>
        `| ${String(group.requestedModel).replace(/[|\r\n]/g, ' ')} / ${String(group.purpose).replace(/[|\r\n]/g, ' ')} | ${group.calls} | ${format(group.durationP50Ms)} / ${format(group.durationP95Ms)} | ${format(group.firstTokenP50Ms)} / ${format(group.firstTokenP95Ms)} | ${format(group.outputTokensPerSecond)} |`,
    ),
    '',
    'Measured at dsh llm/stream, including consumer pacing. Missing tokens/timestamps remain n/a. See JSON for individual attempts and outcomes.',
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(
    `model performance: ${report.samples} call(s), ${report.groups.length} model/purpose group(s)`,
  );
}
