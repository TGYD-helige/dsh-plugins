#!/usr/bin/env node

// Real dsh + packed bundle. CI forwards requests to the integration LLM;
// DSH_SUBAGENT_E2E_FAKE=1 uses a deterministic local LLM transport for development.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrationModel, netEnv, requireEnv, run } from './lib/ci-shared.mjs';

requireEnv(['DSH_PKG_TARBALL']);
const fake = process.env.DSH_SUBAGENT_E2E_FAKE === '1';
if (!fake) requireEnv(['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY']);
const workDir = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'dsh-subagent-filesystem-'));
const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
const dsh = process.env.DSH_CLI ?? 'dsh';
const model = integrationModel();
const roleMarker = `role-${randomUUID()}`;
const appMarker = `application-${randomUUID()}`;
const evidence = `inventory-${randomUUID()}`;
const task = 'Read the supporting inventory evidence. Return your configured role marker, inherited application marker, literal template example, and evidence verbatim.';
const definition = join(workDir, 'agents', 'inventory-analyst.md');
const evidencePath = join(workDir, 'agents', 'resources', 'token.txt');
mkdirSync(join(workDir, 'agents', 'resources'), { recursive: true });
writeFileSync(evidencePath, evidence);
writeFileSync(definition, `---
name: inventory-analyst
description: Investigate inventory discrepancies using the supporting evidence.
---
You are the inventory analyst. Your role marker is ${roleMarker}.
The literal template example is {{inventory_literal}}; repeat it unchanged.
Read resources/token.txt relative to this role definition with a tool before reporting.
Report your role marker, inherited application marker, literal template example and the evidence verbatim.
`);

run(dsh, ['plugin', '--profile', 'headless', 'add', resolve(process.env.DSH_PKG_TARBALL)], { cwd: workDir, env: { DSH_HOME: dshHome } });
writeFileSync(join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'), `
- id: subagent-filesystem
  config:
    enabled: true
- id: system-prompt
  config:
    personaPrefix: 'Application marker: ${appMarker}. Preserve this marker in specialist reports.'
- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${model}
- id: llm-deepseek
  config:
    thinking: disabled
    maxTokens: 16384
`);

let requests = [];
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (body.messages) requests.push(body);
    if (!fake) {
      const upstream = await fetch(`${process.env.DSH_INTEGRATION_BASE_URL.replace(/\/$/, '')}${req.url}`, {
        method: req.method,
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.DSH_INTEGRATION_API_KEY, authorization: `Bearer ${process.env.DSH_INTEGRATION_API_KEY}`, 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01' },
        body: req.method === 'GET' ? undefined : raw,
        signal: AbortSignal.timeout(240_000),
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      return;
    }
    const messages = body.messages ?? [];
    const child = JSON.stringify(body.system).includes(roleMarker);
    const results = messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []);
    const hasResult = results.length > 0;
    let delta;
    if (hasResult) {
      const toolText = JSON.stringify(results);
      assert(toolText.includes(evidence), `Evidence must arrive through a real tool result: ${toolText}`);
      delta = { content: `${roleMarker} ${appMarker} {{inventory_literal}} ${evidence}` };
    } else {
      const args = child
        ? { file_path: evidencePath }
        : { prompt: task, description: 'Check inventory evidence', run_in_background: false };
      const toolName = child ? 'read' : 'subagent_inventory_analyst';
      const direct = body.tools?.some((t) => t.name === toolName);
      const call = direct
        ? { name: toolName, arguments: JSON.stringify(args) }
        : { name: 'run_code', arguments: JSON.stringify({ code: `return await tools.${toolName}(${JSON.stringify(args)})`, description: child ? 'Read inventory evidence' : 'Delegate inventory check' }) };
      delta = { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: call }] };
    }
    const call = delta.tool_calls?.[0];
    const block = call ? { type: 'tool_use', id: call.id, name: call.function.name, input: {} } : { type: 'text', text: '' };
    const events = [
      { type: 'message_start', message: { id: randomUUID(), type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: call.function.arguments } : { type: 'text_delta', text: delta.content } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch (error) {
    if (fake) console.error(error.message);
    res.writeHead(502);
    res.end('E2E gateway request failed');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));

try {
  for (let attempt = 1; attempt <= (fake ? 1 : 3); attempt++) {
    requests = [];
    const output = await new Promise((done, reject) => {
      const child = spawn(dsh, ['--profile', 'headless', `Use subagent_inventory_analyst to delegate this task: ${task}. Return its report verbatim. Do not read evidence yourself.`], {
        cwd: workDir,
        timeout: 8 * 60_000,
        env: { ...netEnv(), DSH_HOME: dshHome, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, DEEPSEEK_API_KEY: 'local-e2e-proxy' },
      });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; process.stdout.write(chunk); });
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? done(text) : reject(new Error(`dsh exited ${code}`)));
    });
    try {
      const childRequests = requests.filter((r) => JSON.stringify(r.system).includes(roleMarker));
      assert(childRequests.length > 0, 'The role must reach a child system prompt');
      const first = childRequests[0];
      const system = JSON.stringify(first.system);
      assert(system.includes(appMarker), 'Inherited application persona must survive');
      assert(system.includes('DeepSeek Harness'), 'Harness instructions must survive');
      assert(system.includes('{{inventory_literal}}'), 'Markdown template braces must stay literal');
      assert(system.includes(join(workDir, 'agents')), 'The role resource directory must reach the child');
      const users = JSON.stringify(first.messages.filter((m) => m.role === 'user'));
      assert(users.includes(task), 'The task must remain user content');
      assert(!users.includes(roleMarker), 'Role instructions must not become a user-task prefix');
      assert(childRequests.some((r) => r.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && JSON.stringify(b.content).includes(evidence)))), 'The specialist must read its supporting evidence through a tool');
      assert(requests.some((r) => !JSON.stringify(r.system).includes(roleMarker)), 'The role must remain child-scoped');
      for (const marker of [roleMarker, appMarker, evidence, '{{inventory_literal}}']) assert(output.includes(marker), `Missing report evidence: ${marker}`);
      console.log(`SCENARIO_OK (Markdown specialist + inherited persona + resource read; ${fake ? 'local deterministic transport' : 'real LLM'})`);
      break;
    } catch (error) {
      if (attempt === (fake ? 1 : 3)) throw error;
      console.log(`::warning::attempt ${attempt}: ${error.message}`);
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
