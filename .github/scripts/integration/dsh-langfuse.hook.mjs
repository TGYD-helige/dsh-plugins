#!/usr/bin/env node

/** Run a Codex hook script, then verify its context and result in Langfuse. */

import { evaluateHookTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  tag: 'hook',
  name: 'UserPromptSubmit hook',
  hook: true,
  prompt: (markerFile) => `请只回复文件名 ${markerFile}，不要调用工具`,
  evaluate: evaluateHookTrace,
});
