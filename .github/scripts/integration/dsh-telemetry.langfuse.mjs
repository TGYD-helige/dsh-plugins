import { evaluateReasoning, evaluateTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  telemetryBackend: 'langfuse',
  tag: 'telemetry-langfuse',
  name: 'langfuse unified tracing',
  prompt: (file) => `请用工具读取当前目录下的 ${file}，并把它的内容原样复述给我`,
  evaluate: (observations, marker) => [
    ...evaluateTrace(observations, marker),
    ...evaluateReasoning(observations),
  ],
});
