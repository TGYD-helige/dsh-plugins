#!/usr/bin/env node

/**
 * dsh-langfuse base leg: one direct tool round-trip over the OpenAI-format
 * route with thinking at max effort, verified in Langfuse (real mode) or
 * against the in-process fake endpoint (fake mode). See lib/langfuse-shared.mjs
 * for the contract and the machinery.
 */

import { evaluateReasoning, evaluateTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  tag: 'base',
  name: 'direct read (thinking at max)',
  prompt: (markerFile) => `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`,
  evaluate: (obs, cw) => [...evaluateTrace(obs, cw), ...evaluateReasoning(obs)],
});
