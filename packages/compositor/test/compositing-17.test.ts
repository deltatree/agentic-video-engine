/**
 * Story 17.1 und 17.2: isolierte Layer (Blend, Maske, Reveal), Gruppen-Clip, Farbraum pro Layer,
 * lineare Ausgabe.
 */
import { describe, expect, it } from 'vitest';
import type { EvaluatedNode, Matrix2D, RgbaImage } from '@agentic-video/core';
import { compositeFrame, type CompositeInput, type CompositorNode } from '@agentic-video/compositor';

function solid(w: number, h: number, rgba: readonly [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  const a = rgba[3] / 255;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(rgba[0] * a);
    data[i + 1] = Math.round(rgba[1] * a);
    data[i + 2] = Math.round(rgba[2] * a);
    data[i + 3] = rgba[3];
  }
  return { width: w, height: h, data };
}

/** Bild, das nur in `[x0, x1) × [y0, y1)` deckend `rgb` ist. */
function box(w: number, h: number, x0: number, x1: number, y0: number, y1: number, rgb: readonly [number, number, number]): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 4;
      data.set([rgb[0], rgb[1], rgb[2], 255], o);
    }
  return { width: w, height: h, data };
}

function node(type: string, props: Record<string, unknown>, extra: Partial<EvaluatedNode> = {}): EvaluatedNode {
  return { id: 'n', type, props, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: '/nodes/0', ...extra };
}

function input(layers: CompositorNode[], extra: Partial<CompositeInput> = {}): CompositeInput {
  return { width: 8, height: 8, scale: 1, background: 'transparent', workingSpace: 'srgb', layers, frame: 0, seed: 1, ...extra };
}

function px(image: RgbaImage, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return [...image.data.subarray(o, o + 4)];
}

const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];

describe('isolierte Layer (Story 17.1)', () => {
  it('mischt einen isolierten Layer mit seinem Blend Mode und ohne erneute Opacity', () => {
    const below = { kind: 'image', image: solid(8, 8, [255, 0, 0, 255]) } as const;
    const iso: CompositorNode = { kind: 'isolate', node: node('scene3d', { blendMode: 'screen', opacity: 0.5 }), children: [{ kind: 'image', image: solid(8, 8, [0, 0, 255, 255]) }], matrix: IDENTITY };
    expect(px(compositeFrame(input([below, iso])), 3, 3)).toEqual([255, 0, 255, 255]);
  });

  it('transformiert die Maske eines isolierten Layers mit der Node-Matrix', () => {
    // Maske im lokalen Raum: linke Hälfte (x < 4). Die Node ist um 4 px nach rechts verschoben.
    const iso: CompositorNode = {
      kind: 'isolate',
      node: node('scene3d', {}),
      children: [{ kind: 'image', image: solid(8, 8, [0, 255, 0, 255]) }],
      matrix: [1, 0, 0, 1, 4, 0],
      mask: { image: box(8, 8, 0, 4, 0, 8, [255, 255, 255]), mode: 'alpha', invert: false },
    };
    const out = compositeFrame(input([iso]));
    expect(px(out, 1, 3)).toEqual([0, 0, 0, 0]);
    expect(px(out, 5, 3)).toEqual([0, 255, 0, 255]);
  });

  it('wendet einen Reveal in lokalen Koordinaten an (Wipe, isolierter Layer)', () => {
    const iso: CompositorNode = {
      kind: 'isolate',
      node: node('scene3d', {}),
      children: [{ kind: 'image', image: solid(8, 8, [0, 255, 0, 255]) }],
      matrix: IDENTITY,
      reveal: { reveal: { shape: 'rect', direction: 'left', progress: 0.5 }, box: { x: 0, y: 0, width: 8, height: 8 } },
    };
    const out = compositeFrame(input([iso]));
    expect(px(out, 1, 3)).toEqual([0, 255, 0, 255]);
    expect(px(out, 6, 3)).toEqual([0, 0, 0, 0]);
  });

  it('glättet Reveal-Kanten mit Teilabdeckung', () => {
    const iso: CompositorNode = {
      kind: 'isolate',
      node: node('scene3d', {}),
      children: [{ kind: 'image', image: solid(8, 8, [0, 255, 0, 255]) }],
      matrix: IDENTITY,
      reveal: { reveal: { shape: 'rect', direction: 'left', progress: 0.5625 }, box: { x: 0, y: 0, width: 8, height: 8 } },
    };
    // Kante bei x = 4.5: Pixel 4 ist zur Hälfte bedeckt.
    expect(px(compositeFrame(input([iso])), 4, 3)[3]).toBe(128);
  });

  it('wendet Reveal und Clip auf Compositor-Gruppen an', () => {
    const g: CompositorNode = {
      kind: 'group',
      node: node('group', { width: 6, height: 8, clip: true }),
      children: [{ kind: 'image', image: solid(8, 8, [0, 0, 255, 255]) }],
      reveal: { reveal: { shape: 'rect', direction: 'up', progress: 0.5 }, box: { x: 0, y: 0, width: 6, height: 8 } },
    };
    const out = compositeFrame(input([g]));
    expect(px(out, 2, 1)).toEqual([0, 0, 255, 255]);
    expect(px(out, 2, 6)).toEqual([0, 0, 0, 0]);
    expect(px(out, 7, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('Farbräume (Story 17.2)', () => {
  it('liest einen Layer mit colorSpace "linear" als lineares Licht', () => {
    const layer: CompositorNode = { kind: 'group', node: node('layer', { colorSpace: 'linear' }), children: [{ kind: 'image', image: solid(8, 8, [128, 128, 128, 255]) }] };
    // 128/255 lineares Licht ≈ 0.502 → sRGB-kodiert ≈ 0.737 → 188
    expect(px(compositeFrame(input([layer])), 0, 0)).toEqual([188, 188, 188, 255]);
  });

  it('liest einen Layer mit colorSpace "rec709" mit der BT.709-Kurve', () => {
    const layer: CompositorNode = { kind: 'group', node: node('layer', { colorSpace: 'rec709' }), children: [{ kind: 'image', image: solid(8, 8, [128, 128, 128, 255]) }] };
    const v = px(compositeFrame(input([layer], { workingSpace: 'linear' })), 0, 0)[0] ?? 0;
    // BT.709 dekodiert 0.502 zu ≈ 0.26 linear; sRGB-kodiert ≈ 0.55 → 140 (sRGB wäre 128).
    expect(v).toBeGreaterThan(136);
    expect(v).toBeLessThan(144);
  });

  it('ignoriert colorSpace an Gruppen (nur layer hat das Feld)', () => {
    const g: CompositorNode = { kind: 'group', node: node('group', { colorSpace: 'linear' }), children: [{ kind: 'image', image: solid(8, 8, [128, 128, 128, 255]) }] };
    expect(px(compositeFrame(input([g])), 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it('kodiert die Ausgabe linear, wenn outputSpace "linear" ist', () => {
    const out = compositeFrame(input([{ kind: 'image', image: solid(8, 8, [188, 188, 188, 255]) }], { outputSpace: 'linear' }));
    // sRGB 188 ≈ 0.503 linear → 128
    expect(px(out, 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it('mischt im Arbeitsraum linear anders als in sRGB', () => {
    const layers: CompositorNode[] = [
      { kind: 'image', image: solid(8, 8, [255, 0, 0, 255]) },
      { kind: 'group', node: node('group', { opacity: 0.5 }), children: [{ kind: 'image', image: solid(8, 8, [0, 255, 0, 255]) }] },
    ];
    const srgb = px(compositeFrame(input(layers, { workingSpace: 'srgb' })), 0, 0);
    const linear = px(compositeFrame(input(layers, { workingSpace: 'linear' })), 0, 0);
    expect(srgb[0]).toBe(128);
    expect(linear[0]).toBe(188);
  });
});
