#!/usr/bin/env node

import { runScenario } from './lib/langfuse-shared.mjs';
import { evaluateMetadataTrace } from './lib/langfuse-metadata-check.mjs';

await runScenario({
  tag: 'metadata',
  name: 'request metadata propagation',
  metadata: true,
  prompt: (markerFile) =>
    `请调用 subagent 工具，委派一个子代理用工具读取当前目录下的 ${markerFile} 并把内容原样复述，不要自己读取`,
  evaluate: evaluateMetadataTrace,
});
