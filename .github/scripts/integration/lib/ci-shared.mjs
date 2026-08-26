/**
 * Shared helpers for the integration scenarios: required-env validation, the
 * proxy-stripped env for LLM-carrying processes, and the logged spawnSync
 * runner.
 */
import { spawnSync } from 'node:child_process';

export function requireEnv(names) {
  for (const name of names) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
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
