#!/usr/bin/env node
// Legt ein neues Workspace-Paket mit einheitlicher Struktur an.
// Aufruf: node scripts/new-package.mjs <name> "<Beschreibung>" [--dom] [--dep <paket>]...
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [name, description, ...rest] = process.argv.slice(2);
if (!name || !description) {
  console.error('Aufruf: node scripts/new-package.mjs <name> "<Beschreibung>" [--dom] [--dep <paket>]...');
  process.exit(1);
}
const dom = rest.includes('--dom');
const nodeTypes = !rest.includes('--isomorphic');
const deps = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--dep' && rest[i + 1]) deps.push(rest[++i]);
}

const dir = join(root, 'packages', name);
if (existsSync(dir)) {
  console.error(`Paket existiert bereits: ${dir}`);
  process.exit(1);
}
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });

const pkg = {
  name: `@agentic-video/${name}`,
  version: '0.1.0',
  description,
  license: 'Apache-2.0',
  type: 'module',
  repository: { type: 'git', url: 'https://github.com/deltatree/agentic-video-engine.git', directory: `packages/${name}` },
  engines: { node: '>=22.13.0' },
  exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  main: './dist/index.js',
  types: './dist/index.d.ts',
  files: ['dist', 'LICENSE', 'README.md'],
  dependencies: Object.fromEntries(deps.map((d) => [`@agentic-video/${d}`, '0.1.0'])),
};
writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

const tsconfig = {
  extends: '../../tsconfig.base.json',
  compilerOptions: {
    rootDir: 'src',
    outDir: 'dist',
    ...(dom ? { lib: ['ES2023', 'DOM', 'DOM.Iterable'] } : {}),
    types: nodeTypes ? ['node'] : [],
  },
  include: ['src'],
  references: deps.map((d) => ({ path: `../${d}` })),
};
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');
writeFileSync(join(dir, 'README.md'), `# @agentic-video/${name}\n\n${description}\n`);
copyFileSync(join(root, 'LICENSE'), join(dir, 'LICENSE'));
console.log(`Angelegt: packages/${name}`);
