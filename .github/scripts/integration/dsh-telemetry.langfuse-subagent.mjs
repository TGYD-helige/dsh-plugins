import { evaluateSubagentTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  telemetryBackend: 'langfuse',
  tag: 'telemetry-langfuse-subagent',
  name: 'langfuse nested subagent',
  prompt: (file) =>
    `请调用 subagent 工具，委派一个子代理用工具读取当前目录下的 ${file} 并把内容原样复述，不要自己读取`,
  evaluate: evaluateSubagentTrace,
});
