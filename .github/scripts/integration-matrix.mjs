/**
 * Integration matrix discovery: every `.github/scripts/integration/<pkg>.mjs`
 * becomes one base-leg entry (full dsh + LLM query; secrets reach only
 * same-repo runs, fork PRs self-skip Stage B). A
 * package may split its scenario into several legs as `<pkg>.<scenario>.mjs`
 * (e.g. dsh-langfuse.subagent.mjs) — the package key is the part before the
 * first dot and all of a package's legs share its tarball. A sibling
 * `<pkg>.providers` file (one provider per line) adds backend-only legs
 * (service db + writes/reads, no secrets — always run, forks included).
 *
 * Outputs (GITHUB_OUTPUT):
 *   matrix          — [{ package, name }] for the `scenario` job (name = leg
 *                     label and scenario script basename; package = the
 *                     packed/tested package)
 *   backend_matrix  — [{ package, provider }] for the `scenario-backends` job
 *   has_scenarios / has_backends — 'true' | 'false'
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

const scenariosDir = '.github/scripts/integration';

const base = [];
const backends = [];
// Providers are per-PACKAGE: dedupe so multi-leg packages (<pkg>.<scenario>.mjs)
// don't register the same backend leg once per leg file.
const backendSeen = new Set();
for (const d of readdirSync(scenariosDir, { withFileTypes: true })) {
  if (!d.isFile() || !d.name.endsWith('.mjs')) continue;
  const leg = d.name.slice(0, -'.mjs'.length);
  const pkg = leg.split('.', 1)[0];
  if (!existsSync(`packages/${pkg}/package.json`)) {
    console.log(`::warning::scenario ${d.name} has no packages/${pkg} — skipped`);
    continue;
  }
  base.push({ package: pkg, name: leg });
  const providersFile = `${scenariosDir}/${pkg}.providers`;
  if (existsSync(providersFile)) {
    for (const provider of readFileSync(providersFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const key = `${pkg}/${provider}`;
      if (backendSeen.has(key)) continue;
      backendSeen.add(key);
      backends.push({ package: pkg, provider });
    }
  }
}
base.sort((a, b) => a.name.localeCompare(b.name));
backends.sort((a, b) => a.package.localeCompare(b.package) || a.provider.localeCompare(b.provider));

console.log(`base legs: ${base.map((e) => e.name).join(', ') || '(none)'}`);
console.log(`backend legs: ${backends.map((e) => `${e.package}/${e.provider}`).join(', ') || '(none)'}`);
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify({ include: base })}\n` +
    `backend_matrix=${JSON.stringify({ include: backends })}\n` +
    `has_scenarios=${base.length > 0}\n` +
    `has_backends=${backends.length > 0}\n`,
);
