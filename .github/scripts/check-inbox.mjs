/** Exercise the inbox using only the installed official npm runtime. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const build = spawnSync('pnpm', ['--filter', '@amaster.ai/dsh-telemetry', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--config',
    '.github/scripts/integration/inbox.vitest.config.mts',
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
