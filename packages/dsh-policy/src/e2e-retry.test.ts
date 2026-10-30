import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scenario = fileURLToPath(
  new URL('../../../.github/scripts/integration/dsh-policy.bash.mjs', import.meta.url),
);

describe('policy bash integration retry boundary', () => {
  it('never retries away a denied command that reached the filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-policy-retry-test-'));
    try {
      const fakeDsh = join(dir, 'fake-dsh');
      const state = join(dir, 'attempts');
      writeFileSync(
        fakeDsh,
        `#!/bin/sh
if [ "$1" = "plugin" ]; then exit 0; fi
attempt="$(cat "$FAKE_DSH_STATE" 2>/dev/null || echo 0)"
attempt=$((attempt + 1))
echo "$attempt" > "$FAKE_DSH_STATE"
touch ci-allowed.txt
if [ "$attempt" -eq 1 ]; then
  touch ci-blocked.txt
  exit 0
fi
printf '%s\n' 'touch ci-blocked is denied by dsh-policy E2E'
`,
      );
      chmodSync(fakeDsh, 0o755);
      mkdirSync(join(dir, 'dsh-home', 'profiles', 'headless'), { recursive: true });
      const result = spawnSync(process.execPath, [scenario], {
        encoding: 'utf8',
        env: {
          ...process.env,
          DSH_CLI: fakeDsh,
          DSH_HOME: join(dir, 'dsh-home'),
          DSH_INTEGRATION_BASE_URL: 'http://integration.invalid',
          DSH_INTEGRATION_API_KEY: 'test-key',
          DSH_PKG_TARBALL: join(dir, 'plugin.tgz'),
          FAKE_DSH_STATE: state,
          RUNNER_TEMP: dir,
        },
      });
      expect(result.status).toBe(1);
      expect(readFileSync(state, 'utf8').trim()).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
