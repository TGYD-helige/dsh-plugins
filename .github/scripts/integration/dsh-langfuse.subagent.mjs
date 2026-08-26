#!/usr/bin/env node

/**
 * dsh-langfuse subagent leg: one query that must delegate to the `subagent`
 * tool, verified as a nested delegation-span → subagent-span → child
 * generation/tool-span tree inside the parent's single trace (real mode) or
 * against the in-process fake endpoint (fake mode). See
 * lib/langfuse-shared.mjs for the contract and the machinery.
 */

import { evaluateSubagentTrace, runScenario } from './lib/langfuse-shared.mjs';

runScenario({
  tag: 'subagent',
  phases: [
    {
      name: 'subagent delegation',
      suffix: '-sub',
      prompt: (markerFile) =>
        `请调用 subagent 工具，委派一个子代理用工具读取当前目录下的 ${markerFile} 并把内容原样复述，不要自己读取`,
      evaluate: evaluateSubagentTrace,
    },
  ],
}).catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
