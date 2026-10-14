#!/usr/bin/env node

/** Real tool hooks and process output, read back from the Langfuse API. */
import { evaluateToolHookTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  tag: 'tool-hooks',
  name: 'BeforeTool/AfterTool context and parenting',
  toolHooks: true,
  prompt: (markerFile) => `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`,
  evaluate: evaluateToolHookTrace,
});
