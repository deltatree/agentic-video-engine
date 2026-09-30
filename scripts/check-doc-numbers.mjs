#!/usr/bin/env node
// Drift-Gate für Zahlen in der Doku (Story 19.8): Anzahlen von Operationen, Node-Typen, Komponenten,
// Templates und Blend Modes in README, AGENTS und llms.txt (beide Sprachfassungen) müssen zu
// docs/ai/capabilities.json passen, der ADR-Bereich im README zum letzten ADR in docs/adr/.
// capabilities.json selbst hält `node scripts/generate-docs.mjs --check` aktuell.
// Aufruf: `node scripts/check-doc-numbers.mjs` (Teil von `npm run check` und CI); Code 1 bei Abweichung.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dateien, deren Zahlen geprüft werden (relativ zum Repository). */
export const DOC_FILES = ['README.md', 'README.de.md', 'AGENTS.md', 'docs/ai/AGENTS.md', 'docs/ai/AGENTS.de.md', 'llms.txt', 'docs/guide/getting-started.md', 'docs/guide/getting-started.de.md'];

/**
 * Muster je Größe, Englisch und Deutsch. Die Zahl steht vor dem Wort („31 operations“, „31 Node-Typen“)
 * oder in Klammern dahinter („Components (29)“, „Komponenten (29)“).
 */
const PATTERNS = {
  operations: [/(\d+)\s+(?:operations|Operationen)\b/giu],
  nodeTypes: [/(\d+)\s+(?:node types|Node-Typen)/giu],
  components: [/(\d+)\s+(?:components|Komponenten)\b/giu, /\b(?:Components|Komponenten)\s*\((\d+)\)/gu],
  templates: [/(\d+)\s+(?:templates|Templates)\b/giu],
  blendModes: [/(\d+)\s+(?:blend modes|Blend Modes)\b/giu],
};

/**
 * Soll-Zahlen aus dem Capability-Manifest.
 *
 * @example
 * expectedCounts({ operations: [{}], nodeTypes: { text: {} }, components: [], templates: [], blendModes: ['normal'] });
 * // { operations: 1, nodeTypes: 1, components: 0, templates: 0, blendModes: 1 }
 */
export function expectedCounts(capabilities) {
  const len = (v) => (Array.isArray(v) ? v.length : v !== null && typeof v === 'object' ? Object.keys(v).length : Number.NaN);
  return {
    operations: len(capabilities.operations),
    nodeTypes: len(capabilities.nodeTypes),
    components: len(capabilities.components),
    templates: len(capabilities.templates),
    blendModes: len(capabilities.blendModes),
  };
}

/**
 * Findet alle Zahlen in `text`, die nicht zu `expected` passen.
 *
 * @example
 * numberProblems('All 30 operations', { operations: 31 }, 'README.md');
 * // ['README.md:1: "30 operations" – capabilities.json has 31 operations']
 */
export function numberProblems(text, expected, file) {
  const problems = [];
  for (const [kind, patterns] of Object.entries(PATTERNS)) {
    const want = expected[kind];
    if (want === undefined) continue;
    for (const pattern of patterns) {
      for (const m of text.matchAll(pattern)) {
        const got = Number(m[1]);
        if (got !== want) {
          const line = text.slice(0, m.index).split('\n').length;
          problems.push(`${file}:${String(line)}: "${m[0]}" – capabilities.json has ${String(want)} ${kind}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Prüft den ADR-Bereich („ADR 0001–0028“) gegen die höchste Nummer in `docs/adr/`.
 *
 * @example
 * adrProblems('ADR 0001–0017', 28, 'README.md'); // ['README.md:1: "ADR 0001–0017" – the last ADR is 0028']
 */
export function adrProblems(text, lastAdr, file) {
  const problems = [];
  for (const m of text.matchAll(/ADR 0001[–-](\d{4})/gu)) {
    if (Number(m[1]) !== lastAdr) problems.push(`${file}:${String(text.slice(0, m.index).split('\n').length)}: "${m[0]}" – the last ADR is ${String(lastAdr).padStart(4, '0')}`);
  }
  return problems;
}

/**
 * Prüft alle {@link DOC_FILES} eines Repositorys; liefert die Liste der Abweichungen.
 *
 * @example
 * checkDocNumbers('/path/to/repo'); // [] wenn alles passt
 */
export function checkDocNumbers(root) {
  const capabilities = JSON.parse(readFileSync(join(root, 'docs', 'ai', 'capabilities.json'), 'utf8'));
  const expected = expectedCounts(capabilities);
  const problems = Object.entries(expected)
    .filter(([, n]) => !Number.isInteger(n))
    .map(([kind]) => `docs/ai/capabilities.json has no list "${kind}"; run node scripts/generate-docs.mjs`);
  const adrs = readdirSync(join(root, 'docs', 'adr')).map((f) => /^(\d{4})-/u.exec(f)?.[1]).filter((n) => n !== undefined).map(Number);
  const lastAdr = Math.max(...adrs);
  for (const file of DOC_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    problems.push(...numberProblems(text, expected, file), ...adrProblems(text, lastAdr, file));
  }
  return problems;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkDocNumbers(root);
  if (problems.length > 0) {
    console.error(`Documentation numbers drifted from docs/ai/capabilities.json:\n  ${problems.join('\n  ')}\nFix the text (both language versions).`);
    process.exit(1);
  }
  console.log(`Documentation numbers match docs/ai/capabilities.json (${String(DOC_FILES.length)} files).`);
}
