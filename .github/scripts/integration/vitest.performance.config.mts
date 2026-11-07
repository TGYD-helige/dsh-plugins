import { fileURLToPath } from 'node:url';
import base from './vitest.a2a-http.config.mts';

export default {
  ...base,
  test: {
    ...base.test,
    include: ['dsh-a2a.http.spec.ts', 'dsh-media.performance.spec.ts'],
    env: { DSH_PERFORMANCE_NETWORK: 'true' },
    testNamePattern: 'performance:',
    reporters: ['default', 'json'],
    outputFile: fileURLToPath(new URL('../../../performance-transport-results.json', import.meta.url)),
  },
};
