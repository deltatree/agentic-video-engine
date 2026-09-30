#!/usr/bin/env node
// Hilfen für die npm-Veröffentlichung (Story 22.7, Entscheidung T3).
//
//   node scripts/release-packages.mjs order              Veröffentlichte Pakete in Abhängigkeitsreihenfolge (Ordner je Zeile)
//   node scripts/release-packages.mjs sync-version       Version aller Pakete und ihrer @agentic-video/*-Abhängigkeiten = Root-Version
//   node scripts/release-packages.mjs check-tag <tag>    Prüft, dass <tag> gleich v<Root-Version> ist
//   node scripts/release-packages.mjs check              Prüft publishConfig, files und Versionen aller Pakete
//
// Veröffentlicht werden alle Pakete unter packages/* ohne "private": true.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@agentic-video/';
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** Veröffentlichte Workspace-Pakete: { dir, file, pkg }. */
export function publishedPackages() {
  const base = join(root, 'packages');
  return readdirSync(base)
    .map((name) => ({ dir: `packages/${name}`, file: join(base, name, 'package.json') }))
    .filter((p) => existsSync(p.file))
    .map((p) => ({ ...p, pkg: JSON.parse(readFileSync(p.file, 'utf8')) }))
    .filter((p) => p.pkg.private !== true)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Topologische Reihenfolge: jedes Paket nach seinen @agentic-video/*-Abhängigkeiten. */
export function dependencyOrder(packages = publishedPackages()) {
  const byName = new Map(packages.map((p) => [p.pkg.name, p]));
  const order = [];
  const state = new Map();
  const visit = (p, path) => {
    if (state.get(p.pkg.name) === 2) return;
    if (state.get(p.pkg.name) === 1) throw new Error(`Dependency cycle: ${[...path, p.pkg.name].join(' -> ')}`);
    state.set(p.pkg.name, 1);
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(p.pkg[field] ?? {})) {
        const target = byName.get(dep);
        if (target !== undefined) visit(target, [...path, p.pkg.name]);
      }
    }
    state.set(p.pkg.name, 2);
    order.push(p);
  };
  for (const p of packages) visit(p, []);
  return order;
}

function rootVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/** Setzt Version und interne Abhängigkeiten aller Pakete auf die Root-Version. */
export function syncVersion(version = rootVersion()) {
  let changed = 0;
  for (const p of publishedPackages()) {
    const next = { ...p.pkg, version };
    for (const field of DEP_FIELDS) {
      if (next[field] === undefined) continue;
      next[field] = Object.fromEntries(Object.entries(next[field]).map(([k, v]) => [k, k.startsWith(SCOPE) ? version : v]));
    }
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (text !== `${JSON.stringify(p.pkg, null, 2)}\n`) {
      writeFileSync(p.file, text);
      changed++;
    }
  }
  return changed;
}

/** Findet Fehler in den Veröffentlichungs-Metadaten. */
export function checkPackages(version = rootVersion()) {
  const errors = [];
  for (const p of publishedPackages()) {
    const where = `${p.dir}/package.json`;
    if (p.pkg.publishConfig?.access !== 'public') errors.push(`${where}: publishConfig.access must be "public"`);
    if (p.pkg.publishConfig?.provenance !== true) errors.push(`${where}: publishConfig.provenance must be true`);
    if (!Array.isArray(p.pkg.files) || !p.pkg.files.includes('dist')) errors.push(`${where}: files must include "dist"`);
    if (p.pkg.version !== version) errors.push(`${where}: version ${p.pkg.version} differs from the root version ${version}`);
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(p.pkg[field] ?? {})) {
        if (dep.startsWith(SCOPE) && range !== version) errors.push(`${where}: ${field}.${dep} is "${range}", expected "${version}"`);
      }
    }
  }
  const cli = publishedPackages().find((p) => p.pkg.name === '@agentic-video/cli');
  if (cli === undefined || !cli.pkg.files.includes('studio')) errors.push('packages/cli/package.json: files must include "studio" (the built Studio)');
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'order') {
    process.stdout.write(`${dependencyOrder().map((p) => p.dir).join('\n')}\n`);
  } else if (command === 'sync-version') {
    const changed = syncVersion();
    process.stdout.write(`Version ${rootVersion()} in ${String(changed)} package(s) set.\n`);
  } else if (command === 'check-tag') {
    const expected = `v${rootVersion()}`;
    if (arg !== expected) {
      process.stderr.write(`Tag ${String(arg)} does not match the root version (${expected}). Bump "version" in package.json first.\n`);
      process.exit(1);
    }
  } else if (command === 'check') {
    const errors = checkPackages();
    if (errors.length > 0) {
      process.stderr.write(`Release metadata is not ready:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write(`${String(publishedPackages().length)} packages ready to publish.\n`);
  } else {
    process.stderr.write('Usage: node scripts/release-packages.mjs <order|sync-version|check-tag <tag>|check>\n');
    process.exit(2);
  }
}
