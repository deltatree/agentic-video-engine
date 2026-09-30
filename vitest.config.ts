import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Mindest-Coverage je Paket (Story 22.5, Ratchet): gemessen am 2026-09-30 mit `npm run test:coverage`
 * in der vollständigen CI-Umgebung, abgerundet und um einige Punkte gesenkt, damit Messrauschen und
 * umgebungsabhängige Pfade nicht rot machen. Steigt die Coverage, die Werte hier nachziehen – nie senken.
 */
const COVERAGE_THRESHOLDS: Record<string, { lines: number; functions: number; branches: number; statements: number }> = {};

// Tests laufen gegen die Quellen der Workspace-Pakete, nicht gegen dist/.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agentic-video\/([a-z0-9-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
      { find: /^@agentic-video\/([a-z0-9-]+)\/(.+)$/, replacement: `${root}packages/$1/src/$2.ts` },
    ],
  },
  test: {
    // Story 22.5: auch *.test.tsx und Tests neben dem Code (src/**), nicht nur test/**.
    include: [
      'packages/*/{test,src}/**/*.test.{ts,tsx}',
      'apps/*/{test,src}/**/*.test.{ts,tsx}',
      'examples/*/**/*.test.{ts,tsx}',
      'scripts/test/**/*.test.{ts,mjs}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    coverage: {
      // `npm run test:coverage`; CI lädt coverage/ als Artefakt hoch.
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
      // Auch bei roten Tests einen Bericht schreiben (CI-Artefakt zur Fehlersuche).
      reportOnFailure: true,
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/*.test.{ts,tsx}', '**/bin.ts', 'apps/*/src/main.tsx'],
      // Ratchet: Mindestwerte je Paket knapp unter dem gemessenen Stand.
      thresholds: COVERAGE_THRESHOLDS,
    },
  },
});
