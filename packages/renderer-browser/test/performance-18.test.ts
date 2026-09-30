/**
 * Story 18.4: HTML-Aufnahme nur im Inhaltsbereich (`clip`), bitgleich zur Vollbild-Aufnahme.
 * Befund m9: kein Wettlauf zwischen Grafik-Neustart und laufenden Aufträgen; `probeOsSandbox`
 * unterscheidet ein fehlendes Programm von einer fehlenden Sandbox.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenVideoError, type EvaluatedNode } from '@agentic-video/core';
import { createBrowserHost, probeOsSandbox, type BrowserHost } from '@agentic-video/renderer-browser';
import { buildRuntime, hashImage, memoryAssets, node, testFonts } from './helpers.js';

const W = 320;
const H = 180;
let host: BrowserHost | undefined;

beforeAll(async () => {
  buildRuntime();
  host = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
});

afterAll(async () => {
  await host?.close();
});

const card = (id: string, props: Record<string, unknown>): EvaluatedNode =>
  node(id, 'html', {
    width: 120,
    height: 70,
    html: '<div class="c">Clip</div>',
    css: '.c{height:100%;border-radius:18px;background:linear-gradient(135deg,#7F5AF0,#2CB67D);color:#fff;font:24px sans-serif;padding:6px;box-sizing:border-box}',
    ...props,
  });

/** Unsichtbarer Container mit Filter: erzwingt die Vollbild-Aufnahme, zeichnet aber nichts. */
const forceFull = node('full', 'html', { width: 10, height: 10, x: 0, y: 0, opacity: 0, html: '<i></i>', filters: [{ type: 'brightness', amount: 1 }] });

function payload(nodes: EvaluatedNode[]) {
  return { nodes, width: W, height: H, scale: 1, frame: 0, time: 0, fps: 30, seed: 7 };
}

describe('HTML-Aufnahme im Inhaltsbereich (Story 18.4)', () => {
  it('liefert mit clip dieselben Pixel wie die Vollbild-Aufnahme (auch gedreht und skaliert)', async () => {
    const h = host;
    if (h === undefined) throw new Error('host missing');
    for (const props of [{ x: 20.4, y: 30.6 }, { x: 150, y: 50, rotation: 23, scale: 1.2, opacity: 0.8 }, { x: -40, y: 120, rotation: -35 }]) {
      const clipped = await h.render('html', payload([card('a', props)]));
      const full = await h.render('html', payload([card('a', props), forceFull]));
      expect(hashImage(clipped)).toBe(hashImage(full));
    }
  }, 60_000);

  it('gibt ohne sichtbaren Container ein leeres Bild zurück', async () => {
    const h = host;
    if (h === undefined) throw new Error('host missing');
    const image = await h.render('html', payload([card('gone', { x: 400, y: 300 })]));
    expect(image.data.every((v) => v === 0)).toBe(true);
  });
});

describe('Befund m9', () => {
  it('HTML- und WebGL-Aufträge gleichzeitig: der Grafik-Neustart wartet auf laufende Aufträge', async () => {
    const h = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
    try {
      const three = node('s3d', 'scene3d', { width: W, height: H, backend: 'webgl2', camera: 'cam', background: '#101522' }, 0, 60, {
        children: [node('cam', 'camera3d', { position: [0, 0, 4], target: [0, 0, 0], fov: 50 }), node('amb', 'light3d', { kind: 'ambient', intensity: 1 }), node('box', 'mesh3d', { geometry: { type: 'box' }, material: { color: '#FF5A1F' } })],
      });
      const results = await Promise.all([h.render('html', payload([card('a', { x: 10, y: 10 })])), h.render('three', payload([three])), h.render('html', payload([card('b', { x: 60, y: 40 })]))]);
      expect(results.map((r) => r.width)).toEqual([W, W, W]);
      expect(results[0]?.data.some((v) => v !== 0)).toBe(true);
      expect(results[2]?.data.some((v) => v !== 0)).toBe(true);
    } finally {
      await h.close();
    }
  }, 60_000);

  it('probeOsSandbox wirft bei fehlendem Programm statt „keine Sandbox“ zu melden', async () => {
    const error = await probeOsSandbox('/nonexistent/chromium').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error instanceof OpenVideoError ? error.diagnostic.code : error).toBe('OV_BROWSER_CHROMIUM_MISSING');
  });
});
