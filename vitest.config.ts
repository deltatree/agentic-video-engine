import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests laufen gegen die Quellen der Workspace-Pakete, nicht gegen dist/.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agentic-video\/([a-z0-9-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
      { find: /^@agentic-video\/([a-z0-9-]+)\/(.+)$/, replacement: `${root}packages/$1/src/$2.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'examples/*/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
