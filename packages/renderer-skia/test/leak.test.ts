/**
 * Langlauf-Test: Viele Frames in einem Prozess dürfen den WASM-Speicher von CanvasKit
 * nicht unbegrenzt wachsen lassen (Server und Worker rendern tausende Frames).
 */
import { describe, expect, it } from 'vitest';
import { isRecord, type EvaluatedNode, type RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { asset, assets, backend, canvasKit, n, request } from './helpers.js';

/** Größe des WASM-Heaps in Byte (wächst nur, schrumpft nie). */
function heapBytes(ck: unknown): number {
  const heap = isRecord(ck) ? ck['HEAPU8'] : undefined;
  if (!(heap instanceof Uint8Array)) throw new Error('CanvasKit exposes no HEAPU8');
  return heap.buffer.byteLength;
}

function solid(width: number, height: number, value: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4).fill(value) };
}

/** Eine Szene mit vielen Node-Arten; `f` bewegt alles, damit jeder Frame anders ist. */
function frameNodes(f: number): EvaluatedNode[] {
  const t = f / 10;
  return [
    n('rect', { width: 320, height: 180, fill: { type: 'linear', stops: [{ offset: 0, color: '#223' }, { offset: 1, color: '#446' }] } }),
    n('ellipse', { x: 10 + (f % 50), y: 20, width: 60, height: 40, fill: '#FF3B30', stroke: '#FFFFFF', strokeWidth: 2, opacity: 0.7 }),
    n('path', { d: 'M 0 0 L 40 0 L 20 30 Z', x: 100, y: 30, rotation: f, fill: '#34C759', trimEnd: 0.8, stroke: '#000000' }),
    n('text', { x: 10, y: 90, width: 180, text: `Frame ${String(f)} wraps across lines`, fontSize: 16, opacity: 0.8, fill: '#FFFFFF' }),
    n('image', { asset: 'img', x: 200, y: 20, width: 80, height: 60, fit: 'cover', rotation: t, opacity: 0.6 }),
    n('video', { asset: 'clip', x: 200, y: 100, width: 80, height: 45 }),
    n('svg', { markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#0A84FF"/></svg>', x: 150, y: 120, width: 40, height: 40 }),
    n('group', { x: 20, y: 130, effects: [{ type: 'blur', radius: 2 }], blendMode: 'screen' }, { children: [n('rect', { width: 60 + (f % 20), height: 20, fill: '#FFD60A' })] }),
    n('group', { x: 100, y: 130 }, { children: [n('rect', { width: 40, height: 40, fill: '#FFFFFF' })], mask: { node: n('ellipse', { width: 40, height: 40 }), mode: 'alpha', invert: false } }),
  ];
}

describe('long-running render process', () => {
  it('renders 600 frames without errors and without unbounded WASM growth', async () => {
    const ck = await canvasKit();
    const skia = await backend();
    const png = encodePng(solid(32, 32, 180));
    const resolver = assets([asset('img', 'image', png), asset('clip', 'video', new Uint8Array(4), { duration: 10 })], () => solid(64, 36, 90));
    const render = async (f: number): Promise<RgbaImage> => skia.renderLayer(await request(frameNodes(f), { width: 320, height: 180, assets: resolver, frame: f }));
    // Aufwärmen: Caches (Schriften, Bilder) füllen sich im ersten Frame.
    for (let f = 0; f < 20; f++) await render(f);
    const before = heapBytes(ck);
    for (let f = 20; f < 620; f++) {
      const img = await render(f);
      expect(img.width).toBe(320);
    }
    const growth = heapBytes(ck) - before;
    // Ein Frame belegt 320 × 180 × 4 Byte ≈ 230 KB; ein Leck pro Frame wären > 130 MB.
    expect(growth).toBeLessThan(16 * 1024 * 1024);
    await skia.dispose();
  }, 120_000);
});
