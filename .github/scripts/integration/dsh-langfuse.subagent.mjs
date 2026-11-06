#!/usr/bin/env node

/**
 * dsh-langfuse subagent leg: one query that must delegate to the `subagent`
 * tool, verified as a nested delegation-span → subagent-span → child
 * generation/tool-span tree inside the parent's single trace (real mode) or
 * against the in-process fake endpoint (fake mode). See
 * lib/langfuse-shared.mjs for the contract and the machinery.
 */

import { evaluateSubagentTrace, runScenario, subagentPrompt } from './lib/langfuse-shared.mjs';

await runScenario({
  tag: 'subagent',
  name: 'subagent delegation',
  prompt: subagentPrompt,
  evaluate: evaluateSubagentTrace,
});
