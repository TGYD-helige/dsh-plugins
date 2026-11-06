import { evaluateSubagentTrace, runScenario, subagentPrompt } from './lib/langfuse-shared.mjs';

await runScenario({
  telemetryBackend: 'langfuse',
  tag: 'telemetry-langfuse-subagent',
  name: 'langfuse nested subagent',
  prompt: subagentPrompt,
  evaluate: evaluateSubagentTrace,
});
