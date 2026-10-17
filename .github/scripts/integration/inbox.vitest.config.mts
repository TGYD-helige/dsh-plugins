import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['.github/scripts/integration/dsh-a2a.inbox.spec.ts'], testTimeout: 15000 } });
