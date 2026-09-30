#!/usr/bin/env node
// Baut alle TypeScript-Pakete über Projekt-Referenzen und danach Zusatzschritte der Pakete.
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.json']);
// Pakete mit eigenem Nachbau-Schritt (z. B. Browser-Bundles) definieren "build:extra".
for (const base of ['packages', 'apps']) {
  const dir = join(root, base);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const pkgFile = join(dir, name, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    if (pkg.scripts?.['build:extra']) run('npm', ['run', 'build:extra', '--silent'], join(dir, name));
  }
}

// Story 22.7 (T3): Das gebaute Studio gehört ins veröffentlichte CLI-Paket (`files`: "studio"),
// damit `npx @agentic-video/cli studio` ohne Repo-Checkout funktioniert. Die CLI sucht es unter
// packages/cli/studio (neben dist/).
const studioDist = join(root, 'apps', 'studio', 'dist');
const cliStudio = join(root, 'packages', 'cli', 'studio');
if (!existsSync(join(studioDist, 'index.html'))) {
  console.error('apps/studio/dist/index.html fehlt nach dem Build; das CLI-Paket braucht das Studio.');
  process.exit(1);
}
rmSync(cliStudio, { recursive: true, force: true });
cpSync(studioDist, cliStudio, { recursive: true });
