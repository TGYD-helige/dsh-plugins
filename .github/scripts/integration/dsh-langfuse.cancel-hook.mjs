#!/usr/bin/env node

/** Delayed cancellation hooks must remain under the cancelled turn in real Langfuse. */
import { evaluateCancelHookTrace, runScenario } from './lib/langfuse-shared.mjs';

await runScenario({
  tag: 'cancel-hook',
  name: 'UserCancel after the next turn starts',
  cancelHook: true,
  prompt: (markerFile) => `请用工具读取当前目录下的 ${markerFile}，并把它的内容原样复述给我`,
  evaluate: evaluateCancelHookTrace,
});
