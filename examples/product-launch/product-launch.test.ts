// Beispiel product-launch (Story 19.7): JSON-IR mit Bild, Text, Chart, Sequenz-Übergängen und Musik.
// Führt die Befehle der README aus: `openvideo validate` und `openvideo render-frame`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { changedFraction, errorsOf, jsonOf, openvideo, prepareExample } from '../example-test-utils.js';

const here = fileURLToPath(new URL('.', import.meta.url));
let dir: string;

beforeAll(() => {
  dir = prepareExample(here);
});

describe('examples/product-launch', () => {
  it('erzeugt die Assets (Logo, Musik) selbst', () => {
    expect(existsSync(join(dir, 'assets', 'logo.png'))).toBe(true);
    expect(readFileSync(join(dir, 'assets', 'music.wav')).subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  it('openvideo validate: keine Fehler', async () => {
    const r = await openvideo(['validate', '--json'], dir);
    const out = jsonOf(r);
    expect(errorsOf(out['diagnostics'])).toEqual([]);
    expect(r.code).toBe(0);
  });

  it.each([
    ['1s', 0.3],
    ['4.5s', 0.3],
    ['7s', 0.3],
  ])('openvideo render-frame --frame %s zeigt Inhalt', async (frame, minChanged) => {
    const file = join(dir, 'out', `frame-${frame}.png`);
    const r = await openvideo(['render-frame', '--frame', frame, '--scale', '0.25', '--out', file, '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    // Der Verlaufshintergrund füllt das Bild; die Szene zeichnet darüber.
    expect(changedFraction(file, '#0B0D12')).toBeGreaterThan(minChanged);
  });
});
