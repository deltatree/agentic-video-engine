/**
 * Story 17.11: `filters` und `shadow` an Compositor-Gruppen und isolierten Layern.
 */
import { describe, expect, it } from 'vitest';
import type { EvaluatedNode, RgbaImage } from '@agentic-video/core';
import { compositeFrame, cssFilterMatrix, hasNodeFilters, type CompositeInput, type CompositorNode } from '@agentic-video/compositor';
import { filterMatrix } from '@agentic-video/renderer-skia';

const W = 40;
const H = 20;

function node(props: Record<string, unknown>, type = 'group'): EvaluatedNode {
  return { id: 'n', type, props, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: '/n' };
}

/** Deckendes Rechteck `x0..x1 × y0..y1` in Farbe (sRGB, 0..255). */
function box(x0: number, y0: number, x1: number, y1: number, rgb: readonly [number, number, number]): RgbaImage {
  const data = new Uint8Array(W * H * 4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function frame(layers: CompositorNode[], scale = 1): RgbaImage {
  const input: CompositeInput = { width: W, height: H, scale, background: 'transparent', workingSpace: 'linear', layers, frame: 0, seed: 1 };
  return compositeFrame(input);
}

function px(image: RgbaImage, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(o, o + 4));
}

describe('CSS-Farbfilter (Story 17.11)', () => {
  it('nutzt dieselben Matrizen wie das Skia-Backend', () => {
    const filters = [
      { type: 'brightness', amount: 1.3 },
      { type: 'contrast', amount: 0.7 },
      { type: 'saturate', amount: 2 },
      { type: 'grayscale', amount: 0.4 },
      { type: 'sepia', amount: 0.8 },
      { type: 'invert', amount: 0.25 },
      { type: 'hue-rotate', degrees: 123 },
      { type: 'color-matrix', matrix: Array.from({ length: 20 }, (_, i) => i / 20) },
    ];
    for (const f of filters) expect(cssFilterMatrix(f)).toEqual(filterMatrix(f));
    expect(cssFilterMatrix({ type: 'blur', radius: 2 })).toBeUndefined();
  });

  it('erkennt wirksame filters und shadow', () => {
    expect(hasNodeFilters({})).toBe(false);
    expect(hasNodeFilters({ filters: [] })).toBe(false);
    expect(hasNodeFilters({ filters: [{ type: 'blur', radius: 1 }] })).toBe(true);
    expect(hasNodeFilters({ shadow: { color: '#000000' } })).toBe(true);
  });
});

describe('Compositor-Gruppen mit filters und shadow (Story 17.11)', () => {
  it('invertiert eine Gruppe in sRGB-Kodierung', () => {
    const out = frame([{ kind: 'group', node: node({ filters: [{ type: 'invert', amount: 1 }] }), children: [{ kind: 'image', image: box(0, 0, W, H, [200, 100, 0]) }] }]);
    expect(px(out, 5, 5)).toEqual([55, 155, 255, 255]);
  });

  it('skaliert blur und shadow-Offsets mit der Vorschau-Skalierung', () => {
    const shadow = { color: '#00FF00', offsetX: 10, offsetY: 0 };
    // scale 0,5: Inhalt 0..10 px, Schatten um 5 px verschoben.
    const out = frame([{ kind: 'group', node: node({ shadow }), children: [{ kind: 'image', image: box(0, 0, 10, 10, [255, 0, 0]) }] }], 0.5);
    expect(px(out, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(px(out, 12, 5)).toEqual([0, 255, 0, 255]);
    expect(px(out, 16, 5)).toEqual([0, 0, 0, 0]);
  });

  it('weicht mit blur die Kante auf', () => {
    const sharp = frame([{ kind: 'group', node: node({}), children: [{ kind: 'image', image: box(0, 0, 20, H, [255, 255, 255]) }] }]);
    const soft = frame([{ kind: 'group', node: node({ filters: [{ type: 'blur', radius: 2 }] }), children: [{ kind: 'image', image: box(0, 0, 20, H, [255, 255, 255]) }] }]);
    expect(px(sharp, 20, 10)[3]).toBe(0);
    const a = px(soft, 20, 10)[3] ?? 0;
    expect(a).toBeGreaterThan(60);
    expect(a).toBeLessThan(130);
  });
});

describe('Isolierte Layer mit applyFilters (Story 17.11)', () => {
  it('wendet filters nur mit applyFilters an und skaliert Offsets mit der Node-Matrix', () => {
    const shadow = { color: '#0000FF', offsetX: 5, offsetY: 0 };
    const child: CompositorNode = { kind: 'image', image: box(0, 0, 10, 10, [255, 0, 0]) };
    const without = frame([{ kind: 'isolate', node: node({ shadow }, 'scene3d'), children: [child], matrix: [2, 0, 0, 2, 0, 0] }]);
    expect(px(without, 15, 5)).toEqual([0, 0, 0, 0]);
    const withFilters = frame([{ kind: 'isolate', node: node({ shadow }, 'scene3d'), children: [child], matrix: [2, 0, 0, 2, 0, 0], applyFilters: true }]);
    // Offset 5 lokal × Matrix-Skalierung 2 = 10 px.
    expect(px(withFilters, 15, 5)).toEqual([0, 0, 255, 255]);
    expect(px(withFilters, 21, 5)).toEqual([0, 0, 0, 0]);
  });
});
