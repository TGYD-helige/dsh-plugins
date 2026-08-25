/**
 * Integration matrix discovery: every `.github/scripts/integration/<pkg>.mjs`
 * becomes one base-leg entry (full dsh + LLM query, environment-gated). A
 * sibling `<pkg>.providers` file (one provider per line) becomes backend-only
 * legs (service db + writes/reads, no secrets — always run, forks included).
 *
 * Outputs (GITHUB_OUTPUT):
 *   matrix          — [{ package }] for the `scenario` job
 *   backend_matrix  — [{ package, provider }] for the `scenario-backends` job
 *   has_scenarios / has_backends — 'true' | 'false'
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

const scenariosDir = '.github/scripts/integration';

const base = [];
const backends = [];
for (const d of readdirSync(scenariosDir, { withFileTypes: true })) {
  if (!d.isFile() || !d.name.endsWith('.mjs')) continue;
  const pkg = d.name.slice(0, -'.mjs'.length);
  if (!existsSync(`packages/${pkg}/package.json`)) {
    console.log(`::warning::scenario ${d.name} has no packages/${pkg} — skipped`);
    continue;
  }
  base.push({ package: pkg });
  const providersFile = `${scenariosDir}/${pkg}.providers`;
  if (existsSync(providersFile)) {
    for (const provider of readFileSync(providersFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      backends.push({ package: pkg, provider });
    }
  }
}
base.sort((a, b) => a.package.localeCompare(b.package));
backends.sort((a, b) => a.package.localeCompare(b.package) || a.provider.localeCompare(b.provider));

console.log(`base legs: ${base.map((e) => e.package).join(', ') || '(none)'}`);
console.log(`backend legs: ${backends.map((e) => `${e.package}/${e.provider}`).join(', ') || '(none)'}`);
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify({ include: base })}\n` +
    `backend_matrix=${JSON.stringify({ include: backends })}\n` +
    `has_scenarios=${base.length > 0}\n` +
    `has_backends=${backends.length > 0}\n`,
);
