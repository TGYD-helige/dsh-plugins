/** Run native inbox integration against an explicit DSH source checkout. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceRoot = process.env.DSH_SOURCE_ROOT;
if (!sourceRoot) throw new Error('Set DSH_SOURCE_ROOT to the DSH checkout with nativeInboxVersion 1.');
const root = resolve(sourceRoot);
const spec = fileURLToPath(new URL('./integration/dsh-a2a.inbox.spec.ts', import.meta.url));
const config = join(root, '.artifacts', 'native-inbox', 'vitest.config.mts');
mkdirSync(dirname(config), { recursive: true });
writeFileSync(config, `import { defineConfig } from 'vitest/config';
import ts from 'typescript';
import { resolve } from 'node:path';
import { standardDecoratorPlugin, vitestExecArgv } from ${JSON.stringify(pathToFileURL(join(root, 'vitest.shared.ts')).href)};
const { config } = ts.readConfigFile(${JSON.stringify(join(root, 'tsconfig.base.json'))}, ts.sys.readFile);
const alias = Object.entries(config.compilerOptions.paths).map(([name, paths]) => ({
  find: new RegExp('^' + name.replaceAll('/', '\\/').replaceAll('*', '(.*)') + '$'),
  replacement: resolve(${JSON.stringify(root)}, paths[0]).replaceAll('*', '$1'),
}));
export default defineConfig({
  resolve: { alias },
  plugins: [standardDecoratorPlugin()],
  test: { root: ${JSON.stringify(root)}, include: [${JSON.stringify(spec)}], execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts', './scripts/test-dom-environment.ts'], testTimeout: 15000 },
});
`);
const result = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DSH_SOURCE_ROOT: root },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
