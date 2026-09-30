// Beispiel explainer-tsx (Story 19.7): TSX-SDK mit Bibliothekskomponenten, eigener Komponente und Theme.
// Führt die Befehle der README aus: `openvideo validate --trusted` (kompiliert TSX auf dem Host) und
// `openvideo render-frame --trusted`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { changedFraction, errorsOf, jsonOf, openvideo, prepareExample } from '../example-test-utils.js';

const here = fileURLToPath(new URL('.', import.meta.url));
let dir: string;

beforeAll(() => {
  dir = prepareExample(here);
});

describe('examples/explainer-tsx', () => {
  it('openvideo validate --trusted: TSX kompiliert ohne Fehler', async () => {
    const r = await openvideo(['validate', '--trusted', '--json'], dir);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('die kompilierte IR enthält Theme, eigene Komponente, Bibliothekskomponenten und das SVG-Asset', async () => {
    await openvideo(['validate', '--trusted', '--json'], dir);
    const text = readFileSync(join(dir, 'project.json'), 'utf8');
    const project = JSON.parse(text) as { settings: { theme: { colors: Record<string, string> } }; assets: { id: string; src: string }[] };
    expect(project.settings.theme.colors['primary']).toBe('#0F766E');
    expect(project.assets.map((a) => a.src)).toEqual(['assets/mark.svg']);
    for (const id of ['"step-3-card"', '"heading-title"', '"schedule-callout"', '"progress"', '"link-2"']) expect(text).toContain(id);
    for (const c of ['"Title"', '"Subtitle"', '"Callout"', '"Connector"', '"ProgressBar"']) expect(text).toContain(c);
  });

  it.each(['3s', '6.5s'])('openvideo render-frame --trusted --frame %s zeigt Inhalt', async (frame) => {
    const file = join(dir, 'out', `frame-${frame}.png`);
    const r = await openvideo(['render-frame', '--trusted', '--frame', frame, '--scale', '0.25', '--out', file, '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    expect(changedFraction(file, '#F4F7F6')).toBeGreaterThan(0.05);
  });
});
