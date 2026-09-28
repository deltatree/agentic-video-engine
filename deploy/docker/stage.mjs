#!/usr/bin/env node
// Kopiert die Laufzeit-Dateien der Anwendung in einen Zielordner (Image-Build, Ziel "app").
//
// Aufruf: node deploy/docker/stage.mjs <quelle> <ziel>
//
// Kopiert werden: package.json und Lizenzdateien der Wurzel, node_modules (nach `npm prune
// --omit=dev`) und je Workspace-Paket die package.json plus alle Einträge aus "files".
// Quellcode, Tests und Build-Werkzeuge landen so nicht im Image.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [source, target] = process.argv.slice(2);
if (source === undefined || target === undefined) {
  process.stderr.write('Usage: node stage.mjs <source> <target>\n');
  process.exit(2);
}

const copy = (rel) => {
  const from = join(source, rel);
  if (!existsSync(from)) return;
  // Symlinks der Workspaces (node_modules/@agentic-video/* → ../../packages/*) bleiben relativ.
  cpSync(from, join(target, rel), { recursive: true, verbatimSymlinks: true, preserveTimestamps: false });
};

mkdirSync(target, { recursive: true });
for (const rel of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'node_modules']) copy(rel);

let count = 0;
for (const base of ['packages', 'apps']) {
  const dir = join(source, base);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    const pkgFile = join(dir, name, 'package.json');
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    copy(join(base, name, 'package.json'));
    for (const entry of Array.isArray(pkg.files) ? pkg.files : []) copy(join(base, name, entry));
    count++;
  }
}
process.stdout.write(`Staged ${String(count)} workspace packages into ${target}\n`);
