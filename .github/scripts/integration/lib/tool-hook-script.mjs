#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
const marker = JSON.stringify(input.arguments).match(/\bci-marker-tool-hooks-[\w-]+\.txt\b/)?.[0];
assert.ok(marker, 'tool hook must receive the marker path');
assert.ok(['BeforeTool', 'AfterTool'].includes(input.point));
assert.ok(input.callId && input.toolName);
const codeword = marker.slice(0, -4);
assert.equal(readFileSync(marker, 'utf8'), `${codeword}-content\n`);
if (input.point === 'AfterTool') {
  assert.equal(input.toolResult.isError, false, 'marker tool must succeed');
  assert.ok(JSON.stringify(input.toolResult.content).includes(`${codeword}-content`));
}
process.stdout.write(
  JSON.stringify({
    token: input.token,
    reason: 'marker-verified',
    additionalContext: codeword,
    continue: true,
    padding: 'x'.repeat(4200),
  }),
);
process.stderr.write(`marker-verified:${input.point}`);
