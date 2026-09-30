import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATCH_OPS, Registry, SCHEMA_VERSION, applyPatches, isRecord } from '@agentic-video/core';
import { registerComponents } from '@agentic-video/components';
import { registerSubtitles } from '@agentic-video/subtitles';
import { checkProject } from '@agentic-video/render';

/** Alle ```json-Blöcke einer Markdown-Datei (optional nur ab einer Überschrift bis zur nächsten gleicher Ebene). */
function jsonBlocks(file: string, section?: string): { index: number; value: unknown }[] {
  let text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
  if (section !== undefined) {
    const start = text.indexOf(`\n${section}\n`);
    if (start < 0) throw new Error(`${file}: Abschnitt "${section}" fehlt`);
    const level = section.split(' ')[0] ?? '##';
    const rest = text.slice(start + section.length + 2);
    const end = rest.search(new RegExp(`\n${level} `, 'u'));
    text = end < 0 ? rest : rest.slice(0, end);
  }
  return [...text.matchAll(/```json\n([\s\S]*?)```/gu)].map((m, index) => ({ index, value: JSON.parse(m[1] ?? 'null') as unknown }));
}

/** Patch-Arten, für die ein Block ein Beispiel zeigt (letzter Patch eines Blocks). */
function patchOpsShown(blocks: readonly { value: unknown }[]): Set<string> {
  const ops = new Set<string>();
  for (const b of blocks) {
    const patches = isRecord(b.value) && Array.isArray(b.value['patches']) ? b.value['patches'] : [];
    const last: unknown = patches[patches.length - 1];
    if (isRecord(last) && typeof last['op'] === 'string') ops.add(last['op']);
  }
  return ops;
}

// Englisch zuerst, deutsche Fassung als *.de.md (Entscheidung T2, Story 19.8): Beide Fassungen werden geprüft.
const SOURCES: readonly [string, string | undefined][] = [
  ['docs/guide/recipes.md', undefined],
  ['docs/guide/recipes.de.md', undefined],
  ['docs/ai/AGENTS.md', undefined],
  ['docs/ai/AGENTS.de.md', undefined],
  ['docs/guide/api.md', '## Patch kinds'],
];

/** Sprachfassungen (Englisch, Deutsch), deren Code-Blöcke gleich sein müssen. */
const TRANSLATIONS: readonly [string, string][] = [
  ['README.md', 'README.de.md'],
  ['SETUP.md', 'SETUP.de.md'],
  ['docs/ai/AGENTS.md', 'docs/ai/AGENTS.de.md'],
  ['docs/guide/recipes.md', 'docs/guide/recipes.de.md'],
  ['docs/guide/getting-started.md', 'docs/guide/getting-started.de.md'],
  ['docs/reference/node-semantics.md', 'docs/reference/node-semantics.de.md'],
  ['docs/reference/render-manifest.md', 'docs/reference/render-manifest.de.md'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.de.md'],
  ['SECURITY.md', 'SECURITY.de.md'],
  ['deploy/README.md', 'deploy/README.de.md'],
];

/** Inhalt aller ```json-, ```jsonc- und ```tsx-Blöcke (Daten und Code, keine Prosa). */
function codeBlocks(file: string): string[] {
  const text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
  return [...text.matchAll(/```(json|jsonc|tsx)\n([\s\S]*?)```/gu)].map((m) => `${m[1] ?? ''}\n${m[2] ?? ''}`);
}

function baseProject(extraNodes: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    compositions: [
      {
        id: 'main',
        width: 1920,
        height: 1080,
        fps: 30,
        duration: '12s',
        tracks: [{ id: 'subs', kind: 'subtitle', cues: [{ start: '0s', end: '2s', text: 'Hello there' }] }],
        nodes: [
          { id: 'headline', type: 'text', text: 'Hi', fontSize: 92, y: 760 },
          { id: 'f1', type: 'text', text: 'Point', fontSize: 48 },
          ...extraNodes,
        ],
      },
    ],
  };
}

const registry = new Registry();
registerComponents(registry);
registerSubtitles(registry);

describe('Dokumentation zeigt nur gültige IR (A48, A51)', () => {
  for (const [file, section] of SOURCES) {
    for (const block of jsonBlocks(file, section)) {
      it(`${file} Block ${String(block.index + 1)}`, () => {
        const v = block.value;
        if (!isRecord(v)) throw new Error('Block ist kein Objekt');
        let project: Record<string, unknown>;
        if (Array.isArray(v['patches'])) {
          const r = applyPatches(baseProject([]), v['patches'] as never);
          expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
          expect(r.ok).toBe(true);
          project = r.project;
        } else if ('schemaVersion' in v) {
          project = v;
        } else if (typeof v['type'] === 'string') {
          const text = JSON.stringify(v);
          const clash = ['"id":"headline"', '"id":"f1"'].some((id) => text.includes(id));
          project = clash ? { ...baseProject([]), compositions: [{ ...(baseProject([])['compositions'] as Record<string, unknown>[])[0], nodes: [v] }] } : baseProject([v]);
        } else {
          throw new Error(`Unbekannte Blockform: ${Object.keys(v).join(', ')}`);
        }
        const errors = checkProject({ registry }, project).filter((d) => d.severity === 'error' && d.code !== 'OV_BACKEND_MISSING');
        expect(errors).toEqual([]);
      });
    }
  }
});

describe('Beispiele je Patch-Art (Story 19.1)', () => {
  for (const [file, section] of [['docs/ai/AGENTS.md', undefined], ['docs/ai/AGENTS.de.md', undefined], ['docs/guide/api.md', '## Patch kinds']] as const) {
    it(`${file} zeigt jede Patch-Art`, () => {
      expect([...patchOpsShown(jsonBlocks(file, section))].sort()).toEqual([...PATCH_OPS].sort());
    });
  }
});

describe('Sprachfassungen (Story 19.8, T2)', () => {
  for (const [en, de] of TRANSLATIONS) {
    it(`${de} hat dieselben JSON-, JSONC- und TSX-Blöcke wie ${en}`, () => {
      const blocks = codeBlocks(en);
      expect(codeBlocks(de)).toEqual(blocks);
    });
    it(`${en} und ${de} verlinken einander`, () => {
      const read = (f: string): string => readFileSync(fileURLToPath(new URL(`../../../${f}`, import.meta.url)), 'utf8');
      const name = (f: string): string => f.slice(f.lastIndexOf('/') + 1);
      expect(read(en)).toContain(`(${name(de)})`);
      expect(read(de)).toContain(`(${name(en)})`);
    });
  }
});
