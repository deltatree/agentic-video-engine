import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Registry, SCHEMA_VERSION, applyPatches, isRecord } from '@agentic-video/core';
import { registerComponents } from '@agentic-video/components';
import { registerSubtitles } from '@agentic-video/subtitles';
import { checkProject } from '@agentic-video/render';

/** Alle ```json-Blöcke einer Markdown-Datei. */
function jsonBlocks(file: string): { index: number; value: unknown }[] {
  const text = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
  return [...text.matchAll(/```json\n([\s\S]*?)```/gu)].map((m, index) => ({ index, value: JSON.parse(m[1] ?? 'null') as unknown }));
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
  for (const file of ['docs/guide/recipes.md', 'docs/ai/AGENTS.md']) {
    for (const block of jsonBlocks(file)) {
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
