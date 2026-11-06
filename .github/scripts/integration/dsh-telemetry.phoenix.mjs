import { evaluateTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  telemetryBackend: 'phoenix',
  tag: 'telemetry-phoenix',
  name: 'phoenix unified tracing',
  prompt: (file) => `请用工具读取当前目录下的 ${file}，并把它的内容原样复述给我`,
  reasoning: true,
  evaluate: evaluateTrace,
});
