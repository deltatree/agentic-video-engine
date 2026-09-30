// Story 19.8: Zahlen in README/AGENTS/llms.txt passen zu docs/ai/capabilities.json; generierte Doku ist aktuell.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adrProblems, checkDocNumbers, expectedCounts, numberProblems } from '../check-doc-numbers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED = { operations: 31, nodeTypes: 31, components: 29, templates: 15, blendModes: 17 };

describe('check-doc-numbers.mjs (Story 19.8)', () => {
  it('erkennt veraltete Zahlen auf Englisch und Deutsch', () => {
    // So stand es vor Story 19.8 im README (30 statt 31 Operationen).
    expect(numberProblems('the same 30 operations', EXPECTED, 'README.md')).toEqual(['README.md:1: "30 operations" – capabilities.json has 31 operations']);
    expect(numberProblems('Jede der 30 Operationen\nKomponenten (28): Title', EXPECTED, 'AGENTS.de.md')).toEqual([
      'AGENTS.de.md:1: "30 Operationen" – capabilities.json has 31 operations',
      'AGENTS.de.md:2: "Komponenten (28)" – capabilities.json has 29 components',
    ]);
    expect(numberProblems('16 blend modes, 14 templates, 30 node types', EXPECTED, 'x')).toHaveLength(3);
  });

  it('lässt passende Zahlen und fremde Wörter in Ruhe', () => {
    expect(numberProblems('31 operations, 31 Node-Typen, 29 components, Components (29), 15 Templates, 17 Blend Modes, 7 patch kinds', EXPECTED, 'x')).toEqual([]);
  });

  it('prüft den ADR-Bereich', () => {
    expect(adrProblems('ADR 0001–0017', 28, 'README.md')).toEqual(['README.md:1: "ADR 0001–0017" – the last ADR is 0028']);
    expect(adrProblems('ADR 0001–0028', 28, 'README.md')).toEqual([]);
  });

  it('liest die Soll-Zahlen aus capabilities.json', () => {
    expect(expectedCounts({ operations: [1, 2], nodeTypes: { a: 1 }, components: [], templates: [1], blendModes: [1, 2, 3] })).toEqual({ operations: 2, nodeTypes: 1, components: 0, templates: 1, blendModes: 3 });
  });

  it('die eingecheckte Doku passt zu capabilities.json', () => {
    expect(checkDocNumbers(ROOT)).toEqual([]);
  });
});

describe('generate-docs.mjs --check (Story 19.8)', () => {
  const script = join(ROOT, 'scripts', 'generate-docs.mjs');
  const FILES = ['docs/ai/capabilities.json', 'docs/ai/AGENTS.md', 'docs/guide/api.md', 'docs/guide/cli.md', 'docs/reference/node-semantics.md', 'docs/reference/node-semantics.de.md', 'packages/mcp/src/agents-doc.ts'];
  /** Kopiert die erzeugten und gelesenen Dateien in einen leeren Ordner. */
  function copyRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'ov-docs-check-'));
    for (const f of FILES) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(dir, f));
    }
    return dir;
  }
  const run = (dir) => spawnSync(process.execPath, [script, '--check', '--root', dir], { encoding: 'utf8' });

  it('ist grün für den eingecheckten Stand und rot, sobald eine erzeugte Datei abweicht', () => {
    const dir = copyRepo();
    const ok = run(dir);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    writeFileSync(join(dir, 'docs/guide/api.md'), `${readFileSync(join(dir, 'docs/guide/api.md'), 'utf8')}\nedited by hand\n`);
    // AGENTS.md geändert, agents-doc.ts nicht neu erzeugt: auch das ist Drift.
    writeFileSync(join(dir, 'docs/ai/AGENTS.md'), '# changed\n');
    const stale = run(dir);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('docs/guide/api.md');
    expect(stale.stderr).toContain('packages/mcp/src/agents-doc.ts');
    expect(stale.stderr).not.toContain('capabilities.json');
  }, 120_000);
});
