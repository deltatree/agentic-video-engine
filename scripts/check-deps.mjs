#!/usr/bin/env node
// Prüft die gerichteten Paketabhängigkeiten (AD-14, NFR-1).
// Erlaubt ist nur, was in ALLOWED steht; Zyklen sind verboten.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@agentic-video/';

/** Erlaubte direkte Abhängigkeiten je Paket (Kanten aus ARCHITECTURE-SPINE, transitiv erweitert, wo sinnvoll). */
export const ALLOWED = JSON.parse(readFileSync(join(root, 'scripts', 'dependency-rules.json'), 'utf8'));

const errors = [];
const graph = new Map();
const pkgDir = join(root, 'packages');
const dirs = [
  ...readdirSync(pkgDir).map((n) => ['packages', n]),
  ...(existsSync(join(root, 'apps')) ? readdirSync(join(root, 'apps')).map((n) => ['apps', n]) : []),
];

function importsOf(dir) {
  const out = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e)) {
        // Kommentare (z. B. TSDoc-Beispiele) sind keine Abhängigkeiten.
        const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](@agentic-video\/[a-z0-9-]+)/g)) out.add(m[1].slice(SCOPE.length));
      }
    }
  };
  if (existsSync(join(dir, 'src'))) walk(join(dir, 'src'));
  return out;
}

for (const [base, name] of dirs) {
  const dir = join(root, base, name);
  if (!existsSync(join(dir, 'package.json'))) continue;
  const key = base === 'apps' ? `apps/${name}` : name;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith(SCOPE)).map((d) => d.slice(SCOPE.length));
  const used = importsOf(dir);
  const allowed = ALLOWED[key];
  if (!allowed) {
    errors.push(`${key}: fehlt in scripts/dependency-rules.json`);
    continue;
  }
  for (const dep of new Set([...declared, ...used])) {
    if (dep === name) continue;
    if (!allowed.includes(dep)) errors.push(`${key} → ${dep}: nicht erlaubt (AD-14). Erlaubt: ${allowed.join(', ') || '(keine)'}`);
  }
  for (const dep of used) {
    if (!declared.includes(dep) && dep !== name) errors.push(`${key} importiert ${dep}, deklariert es aber nicht in package.json`);
  }
  used.delete(name);
  graph.set(key, [...used]);
}

// Zyklensuche
const state = new Map();
const stack = [];
const dfs = (n) => {
  state.set(n, 1);
  stack.push(n);
  for (const m of graph.get(n) ?? []) {
    if (state.get(m) === 1) errors.push(`Zyklus: ${[...stack.slice(stack.indexOf(m)), m].join(' → ')}`);
    else if (!state.has(m)) dfs(m);
  }
  stack.pop();
  state.set(n, 2);
};
for (const n of graph.keys()) if (!state.has(n)) dfs(n);

if (errors.length > 0) {
  console.error('Abhängigkeitsregeln verletzt:\n' + errors.map((e) => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log(`Abhängigkeitsregeln eingehalten (${graph.size} Pakete).`);
