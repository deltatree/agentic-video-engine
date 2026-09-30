// Beispiel social-vertical (Story 19.7): 9:16, sequence mit Übergängen, Karaoke-Untertitel mit
// Wortzeiten, rund maskiertes Profilbild. Führt `openvideo validate` und `openvideo render-frame` aus.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '@agentic-video/png';
import { changedFraction, errorsOf, jsonOf, openvideo, prepareExample } from '../example-test-utils.js';

const here = fileURLToPath(new URL('.', import.meta.url));
let dir: string;

beforeAll(() => {
  dir = prepareExample(here);
});

describe('examples/social-vertical', () => {
  it('openvideo validate: keine Fehler', async () => {
    const r = await openvideo(['validate', '--json'], dir);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    expect(r.code).toBe(0);
  });

  it.each([
    ['1s', 'card-intro'],
    ['4s', 'card-cache'],
    ['7s', 'card-workers'],
  ])('openvideo render-frame --frame %s: Hochformat mit Karte %s und Karaoke-Untertitel', async (frame, card) => {
    const file = join(dir, 'out', `frame-${frame}.png`);
    const r = await openvideo(['render-frame', '--frame', frame, '--scale', '0.25', '--out', file, '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(jsonOf(r)['diagnostics']).toEqual([]);
    const img = decodePng(readFileSync(file));
    expect([img.width, img.height]).toEqual([270, 480]);
    expect(changedFraction(file, '#0B0D12')).toBeGreaterThan(0.3);
    const tree = JSON.stringify(jsonOf(await openvideo(['inspect', '--frame', frame, '--json'], dir)));
    expect(tree).toContain(`"${card}"`);
    // Die sequence zeigt außerhalb der Übergänge genau eine Karte.
    for (const other of ['card-intro', 'card-cache', 'card-workers'].filter((c) => c !== card)) expect(tree).not.toContain(`"${other}"`);
    expect(tree).toContain('captions-view/cue-');
  });
});
