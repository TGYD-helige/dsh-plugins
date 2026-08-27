/**
 * Shared machinery for the dsh-a2a integration legs: boot the `web` profile
 * with the packed plugin enabled (headless exits after one query and can't
 * serve HTTP), a tiny JSON-RPC/SSE client for the A2A endpoint, and the
 * process teardown contract. Each leg is `.github/scripts/integration/dsh-a2a.<scenario>.mjs`.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { netEnv, requireEnv, run } from './ci-shared.mjs';

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

export async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`http ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

/**
 * Install the bundle into the web profile, write the user patch (plugin
 * enabled on a free port + model pinned to deepseek-v4-flash; legs pass
 * extraPatch for e.g. the thinking rows), boot `dsh web`, and wait for the
 * agent card to answer.
 */
export async function bootA2a({ tag, extraPatch = '' }) {
  requireEnv(['DSH_INTEGRATION_BASE_URL', 'DSH_INTEGRATION_API_KEY', 'DSH_PKG_TARBALL']);
  const workDir = join(process.env.RUNNER_TEMP ?? tmpdir(), `dsh-a2a-e2e-${tag}`);
  mkdirSync(workDir, { recursive: true });
  const dshHome = process.env.DSH_HOME ?? join(workDir, 'dsh-home');
  const dsh = process.env.DSH_CLI ?? 'dsh';
  const a2aPort = await freePort();

  run(dsh, ['plugin', '--profile', 'web', 'add', resolve(process.env.DSH_PKG_TARBALL)], {
    cwd: workDir,
    env: { DSH_HOME: dshHome },
  });

  // An id-targeted row replaces the bundle row's whole config; the template
  // file is one top-level YAML array, so rewrite it wholesale.
  const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
  writeFileSync(
    patchPath,
    `# dsh-a2a integration leg (${tag})
- id: a2a
  config:
    enabled: true
    host: 127.0.0.1
    port: ${a2aPort}
    basePath: /a2a
    cwd: ${workDir}
    card:
      name: ci-a2a-agent

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

${extraPatch}`,
  );
  console.log(`--- ${patchPath} ---\n${readFileSync(patchPath, 'utf8')}`);

  const proc = spawn(dsh, ['--profile', 'web', '--port', '0'], {
    cwd: workDir,
    env: {
      ...netEnv(),
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      // Ephemeral CI workspace: never stall on tool approval prompts.
      DSH_PERMISSION_MODE: 'danger-full-access',
      DEEPSEEK_BASE_URL: process.env.DSH_INTEGRATION_BASE_URL,
      DEEPSEEK_API_KEY: process.env.DSH_INTEGRATION_API_KEY,
    },
  });
  proc.stdout.on('data', (d) => process.stdout.write(d));
  proc.stderr.on('data', (d) => process.stderr.write(d));

  const a2a = `http://127.0.0.1:${a2aPort}`;
  await waitFor(`${a2a}/.well-known/agent-card.json`, 120_000);
  return { a2a, proc, workDir };
}

/** SIGTERM, escalate to SIGKILL after 15s, fail loudly on a hung shutdown. */
export async function stopA2a(proc) {
  proc.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolveExit) => proc.once('exit', () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 15_000)),
  ]);
  if (!exited) {
    proc.kill('SIGKILL');
    throw new Error('dsh web did not exit within 15s of SIGTERM');
  }
}

/** A minimal A2A JSON-RPC client over the plugin endpoint. */
export function a2aClient(a2a) {
  let id = 0;
  const userMessage = (text, extra = {}) => ({
    kind: 'message',
    messageId: `m-${++id}`,
    role: 'user',
    parts: [{ kind: 'text', text }],
    ...extra,
  });
  const call = (method, params) =>
    fetch(`${a2a}/a2a/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `r-${++id}`, method, params }),
    });
  return {
    userMessage,
    rpc: async (method, params) => {
      const res = await call(method, params);
      return { res, body: await res.json() };
    },
    /** Raw streaming response — caller reads the body (whole or incrementally). */
    stream: call,
  };
}

/** Read a streaming response to the end and return its A2A events. */
export async function readEvents(res) {
  return (await res.text())
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)))
    .map((f) => f.result)
    .filter(Boolean);
}

/** The text of a task result's final status message (blocking message/send answer). */
export function textOf(task) {
  return (task?.status?.message?.parts ?? [])
    .filter((p) => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

/** The patch rows most legs want: thinking off (the gateway garbles tool calls with it). */
export const THINKING_OFF = `- id: llm-deepseek
  config:
    thinking: disabled
`;

/** Thinking at max effort, for the reasoning-stream leg (no tools in that leg). */
export const THINKING_MAX = `- id: llm-deepseek
  config:
    thinking: enabled
    reasoningEffort: max
`;
