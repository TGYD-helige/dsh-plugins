#!/usr/bin/env node

import { evaluateMetadataTrace } from './lib/langfuse-metadata-check.mjs';
import { runScenario, subagentPrompt } from './lib/langfuse-shared.mjs';

await runScenario({
  tag: 'metadata',
  name: 'request metadata propagation',
  metadata: true,
  prompt: subagentPrompt,
  evaluate: evaluateMetadataTrace,
});
