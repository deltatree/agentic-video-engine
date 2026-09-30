// Beispiel data-story (Story 19.7): Datenvisualisierung (Line-, Pie-Chart, Counter, Tabelle) mit
// Untertiteln aus einer SRT-Datei. Führt `openvideo validate` und `openvideo render-frame` aus.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { changedFraction, errorsOf, jsonOf, openvideo, prepareExample } from '../example-test-utils.js';

const here = fileURLToPath(new URL('.', import.meta.url));
let dir: string;

beforeAll(() => {
  dir = prepareExample(here);
});

describe('examples/data-story', () => {
  it('openvideo validate: keine Fehler', async () => {
    const r = await openvideo(['validate', '--json'], dir);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    expect(r.code).toBe(0);
  });

  it.each([
    ['3.5s', 'captions-view/cue-1'],
    ['9s', 'captions-view/cue-3'],
  ])('openvideo render-frame --frame %s: Charts und Untertitel ohne Warnungen', async (frame, cue) => {
    const file = join(dir, 'out', `frame-${frame}.png`);
    const r = await openvideo(['render-frame', '--frame', frame, '--scale', '0.25', '--out', file, '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    // Layout hält Bildrand und Title-Safe-Bereich ein: auch keine Warnungen.
    expect(jsonOf(r)['diagnostics']).toEqual([]);
    expect(changedFraction(file, '#0E1320')).toBeGreaterThan(0.05);
    const tree = jsonOf(await openvideo(['inspect', '--frame', frame, '--json'], dir));
    expect(JSON.stringify(tree)).toContain(cue);
  });
});
