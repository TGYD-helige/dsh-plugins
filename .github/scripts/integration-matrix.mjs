/**
 * Integration matrix discovery: every `.github/scripts/integration/<pkg>.mjs`
 * becomes one matrix entry for `packages/<pkg>` — the full end-to-end leg
 * (real dsh profile + one LLM query). A sibling `<pkg>.providers` file
 * (one provider per line) adds backend-only legs `{ package, provider }`:
 * no dsh boot, no LLM, just db push + real backend writes/reads against a
 * service database — they need no secrets, so fork PRs get them too.
 * Adding a package's E2E later is dropping its scenario script in.
 *
 * Outputs (GITHUB_OUTPUT):
 *   matrix         — { include: [{ package, provider? }] } for the scenario job
 *   has_scenarios  — 'true' | 'false'
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

const scenariosDir = '.github/scripts/integration';

const include = [];
for (const d of readdirSync(scenariosDir, { withFileTypes: true })) {
  if (!d.isFile() || !d.name.endsWith('.mjs')) continue;
  const pkg = d.name.slice(0, -'.mjs'.length);
  if (!existsSync(`packages/${pkg}/package.json`)) {
    console.log(`::warning::scenario ${d.name} has no packages/${pkg} — skipped`);
    continue;
  }
  include.push({ package: pkg });
  const providersFile = `${scenariosDir}/${pkg}.providers`;
  if (existsSync(providersFile)) {
    for (const provider of readFileSync(providersFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)) {
      include.push({ package: pkg, provider });
    }
  }
}
include.sort((a, b) => a.package.localeCompare(b.package) || (a.provider ?? '').localeCompare(b.provider ?? ''));

const matrix = { include };
console.log(`scenarios: ${include.map((e) => [e.package, e.provider].filter(Boolean).join('/')).join(', ') || '(none)'}`);
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify(matrix)}\nhas_scenarios=${include.length > 0}\n`,
);
