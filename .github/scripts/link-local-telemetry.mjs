/** Resolve the unpublished workspace dependency from a CI archive, leaving publish metadata alone. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [archive, companion] = process.argv.slice(2).map((file) => resolve(file));
const directory = mkdtempSync(join(tmpdir(), 'local-telemetry-archive-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  const manifestPath = join(directory, 'package/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.dependencies?.['@amaster.ai/dsh-telemetry']) {
    manifest.dependencies['@amaster.ai/dsh-telemetry'] = `file:${companion}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
