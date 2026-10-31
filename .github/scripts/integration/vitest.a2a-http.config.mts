import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../packages/dsh-a2a/package.json', import.meta.url));
const { defineConfig } = await import(require.resolve('vitest/config'));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    {
      name: 'dsh-a2a-integration-dependencies',
      resolveId(source) {
        if (
          source === 'vitest' ||
          source.startsWith('@a2a-js/') ||
          source.startsWith('@grpc/') ||
          source.startsWith('@deepseek-ai/')
        ) {
          return require.resolve(source);
        }
      },
    },
  ],
  test: {
    include: ['dsh-a2a.http.spec.ts', 'dsh-a2a.bridge-http.spec.ts', 'dsh-a2a.native-inbox.spec.ts'],
  },
});
