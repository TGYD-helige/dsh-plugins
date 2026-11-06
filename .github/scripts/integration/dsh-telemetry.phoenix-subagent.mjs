import { evaluateSubagentTrace, runScenario, subagentPrompt } from './lib/langfuse-shared.mjs';

await runScenario({
  telemetryBackend: 'phoenix',
  tag: 'telemetry-phoenix-subagent',
  name: 'phoenix nested subagent',
  prompt: subagentPrompt,
  evaluate: evaluateSubagentTrace,
});
