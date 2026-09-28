#!/usr/bin/env node
// Baut alle TypeScript-Pakete über Projekt-Referenzen und danach Zusatzschritte der Pakete.
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
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
