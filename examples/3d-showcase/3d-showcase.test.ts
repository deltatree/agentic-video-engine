// Beispiel 3d-showcase (Story 19.7): scene3d mit glTF-Modell, Kamerafahrt, Licht, Schatten, Partikeln
// und Bloom. `openvideo validate` läuft immer; der 3D-Frame braucht Chromium (Three.js über WebGL2).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { changedFraction, errorsOf, jsonOf, openvideo, prepareExample } from '../example-test-utils.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const CHROMIUM_REASON = 'Chromium für Playwright fehlt: `npx playwright install chromium` (CI installiert die gepinnte Revision)';

/** Chromium vorhanden? `executablePath()` wirft, wenn Playwright keine Revision kennt. */
function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

let dir: string;

beforeAll(() => {
  dir = prepareExample(here);
});

describe('examples/3d-showcase', () => {
  it('erzeugt ein gültiges GLB-Modell', () => {
    const glb = readFileSync(join(dir, 'assets', 'gem.glb'));
    expect(glb.subarray(0, 4).toString('ascii')).toBe('glTF');
    expect(glb.readUInt32LE(8)).toBe(glb.length);
  });

  it('openvideo validate: keine Fehler', async () => {
    const r = await openvideo(['validate', '--json'], dir);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    expect(r.code).toBe(0);
  });

  it.skipIf(skipUnless(chromiumAvailable(), CHROMIUM_REASON))('openvideo render-frame --frame 3s rendert die 3D-Szene mit Titel', { timeout: 180_000 }, async () => {
    const file = join(dir, 'out', 'frame-3s.png');
    const r = await openvideo(['render-frame', '--frame', '3s', '--scale', '0.25', '--out', file, '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(errorsOf(jsonOf(r)['diagnostics'])).toEqual([]);
    // Boden, Sockel, Edelstein und Partikel füllen den größten Teil des Bildes.
    expect(changedFraction(file, '#05060A')).toBeGreaterThan(0.2);
  });
});
