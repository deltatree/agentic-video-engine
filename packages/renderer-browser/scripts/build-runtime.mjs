#!/usr/bin/env node
// Bündelt die Seiten-Laufzeit mit esbuild:
// - dist/runtime.js: Laufzeit der Host-Seite (HTML-, Three- und Pixi-Layer).
// - dist/clock.js: virtuelle Uhr, die der Host per addInitScript in jedes Dokument lädt.
// Zwei Dateien, weil die Uhr in jedem iframe läuft und dort klein bleiben muss.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = join(pkg, '..');

// Workspace-Pakete aus den Quellen bündeln (wie in vitest.config.ts), damit kein dist/ nötig ist.
// Ihr Einstieg gilt als frei von Seiteneffekten, damit ungenutzte Module (z. B. Schemas) wegfallen.
const workspace = {
  name: 'workspace-sources',
  setup(b) {
    b.onResolve({ filter: /^@agentic-video\/[a-z0-9-]+$/ }, (args) => {
      const path = join(packages, args.path.slice('@agentic-video/'.length), 'src', 'index.ts');
      if (!existsSync(path)) return { errors: [{ text: `Workspace package source not found: ${path}` }] };
      return { path, sideEffects: false };
    });
  },
};

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
  plugins: [workspace],
};

await build({ ...common, entryPoints: [join(pkg, 'src/runtime/clock.ts')], outfile: join(pkg, 'dist/clock.js') });
await build({ ...common, entryPoints: [join(pkg, 'src/runtime/page.ts')], outfile: join(pkg, 'dist/runtime.js') });
