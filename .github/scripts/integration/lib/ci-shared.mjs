/**
 * Shared helpers for the integration scenarios: required-env validation, the
 * proxy-stripped env for LLM-carrying processes, and the logged spawnSync
 * runner.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Opt-in observation of existing calls; the private fixture is outside package inventory. */
export function modelPerformancePatch(dshHome, profile = 'headless') {
  if (!process.env.DSH_MODEL_PERFORMANCE_OUTPUT) return '';
  const directory = join(dshHome, 'profiles', profile, 'ci-performance-fixture');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true }));
  const module = join(directory, 'model-performance-bridge.mjs');
  copyFileSync(new URL('./model-performance-bridge.mjs', import.meta.url), module);
  return `\n- insert:\n    - id: ci-model-performance\n      name: ${JSON.stringify(module)}\n`;
}

export function requireEnv(names) {
  for (const name of names) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
}

/**
 * The integration model: `$DSH_INTEGRATION_MODEL`, defaulting to the
 * gateway's deepseek-v4-flash. GitHub injects unset secrets as '', hence
 * trim-or-default rather than `??`.
 */
export function integrationModel() {
  return process.env.DSH_INTEGRATION_MODEL?.trim() || 'deepseek-v4-flash';
}

export function integrationRevision() {
  return process.env.INTEGRATION_CHECKOUT_REF?.trim() || process.env.GITHUB_SHA?.trim() || 'local';
}

// If the runner routes egress through a host-level proxy, fetch to the
// gateway can break — drop proxy vars from the LLM-carrying process.
export function netEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)),
  );
}

export function run(cmd, args, { cwd, env = {} } = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${r.status}`);
}
