#!/usr/bin/env node

import { readFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const marker = payload.prompt?.match(/\bci-marker-hook-[\w-]+\.txt\b/)?.[0];
if (payload.hook_event_name !== 'UserPromptSubmit' || !marker) {
  throw new Error('unexpected hook payload');
}
if (readFileSync(marker, 'utf8') !== `${marker.slice(0, -4)}-content\n`) {
  throw new Error('marker content did not match');
}

// Codex forwards plain stdout into the next LLM request. The bridge persists
// bounded stderr (but not stdout) in hook/result, which Langfuse reports.
process.stdout.write('ci-hook-context-verification');
process.stderr.write('hook-script-result: marker-verified');
