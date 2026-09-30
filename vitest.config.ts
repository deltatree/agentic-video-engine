import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Mindest-Coverage je Paket in Prozent (Story 22.5, Ratchet): gemessen am 2026-09-30 mit
 * `npm run test:coverage` in einer Umgebung ohne Docker, Piper, whisper.cpp und Blender (CI deckt mehr ab),
 * abgerundet und um 5 Punkte gesenkt, damit Messrauschen und umgebungsabhängige Pfade nicht rot machen.
 * renderer-three/-pixi laufen überwiegend im Browser und sind hier kaum messbar.
 * Steigt die Coverage, die Werte nachziehen – nie senken.
 */
const COVERAGE_THRESHOLDS: Record<string, { lines: number; functions: number; branches: number; statements: number }> = {
  'apps/studio/src/**': { lines: 26, functions: 22, branches: 18, statements: 25 },
  'packages/agent/src/**': { lines: 85, functions: 83, branches: 63, statements: 79 },
  'packages/anime/src/**': { lines: 83, functions: 83, branches: 67, statements: 79 },
  'packages/assets/src/**': { lines: 82, functions: 88, branches: 68, statements: 79 },
  'packages/audio/src/**': { lines: 91, functions: 92, branches: 70, statements: 89 },
  'packages/benchmarks/src/**': { lines: 79, functions: 84, branches: 52, statements: 77 },
  'packages/cache/src/**': { lines: 83, functions: 85, branches: 64, statements: 80 },
  'packages/cli/src/**': { lines: 72, functions: 68, branches: 57, statements: 68 },
  'packages/compiler/src/**': { lines: 80, functions: 85, branches: 63, statements: 73 },
  'packages/components/src/**': { lines: 92, functions: 93, branches: 70, statements: 91 },
  'packages/compositor/src/**': { lines: 92, functions: 88, branches: 72, statements: 90 },
  'packages/core/src/**': { lines: 86, functions: 85, branches: 73, statements: 83 },
  'packages/ffmpeg/src/**': { lines: 84, functions: 80, branches: 69, statements: 81 },
  'packages/fonts/src/**': { lines: 88, functions: 90, branches: 65, statements: 82 },
  'packages/importers/src/**': { lines: 75, functions: 81, branches: 54, statements: 69 },
  'packages/mcp/src/**': { lines: 90, functions: 90, branches: 72, statements: 85 },
  'packages/motion-canvas-adapter/src/**': { lines: 89, functions: 84, branches: 70, statements: 85 },
  'packages/png/src/**': { lines: 87, functions: 95, branches: 57, statements: 83 },
  'packages/render/src/**': { lines: 82, functions: 78, branches: 65, statements: 79 },
  'packages/renderer-blender/src/**': { lines: 69, functions: 69, branches: 51, statements: 66 },
  'packages/renderer-browser/src/**': { lines: 50, functions: 48, branches: 49, statements: 48 },
  'packages/renderer-pixi/src/**': { lines: 15, functions: 14, branches: 17, statements: 15 },
  'packages/renderer-skia/src/**': { lines: 90, functions: 91, branches: 69, statements: 86 },
  'packages/renderer-three/src/**': { lines: 14, functions: 15, branches: 17, statements: 15 },
  'packages/sandbox/src/**': { lines: 82, functions: 81, branches: 57, statements: 78 },
  'packages/scheduler/src/**': { lines: 84, functions: 84, branches: 68, statements: 81 },
  'packages/schema/src/**': { lines: 89, functions: 87, branches: 77, statements: 87 },
  'packages/sdk/src/**': { lines: 79, functions: 79, branches: 57, statements: 73 },
  'packages/speech/src/**': { lines: 76, functions: 73, branches: 62, statements: 72 },
  'packages/subtitles/src/**': { lines: 93, functions: 93, branches: 77, statements: 90 },
  'packages/telemetry/src/**': { lines: 93, functions: 91, branches: 66, statements: 88 },
  'packages/templates/src/**': { lines: 95, functions: 95, branches: 68, statements: 89 },
  'packages/testing/src/**': { lines: 95, functions: 95, branches: 75, statements: 94 },
  'packages/timeline/src/**': { lines: 84, functions: 79, branches: 73, statements: 80 },
  'packages/worker/src/**': { lines: 72, functions: 65, branches: 58, statements: 71 },
};

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
