/**
 * Stories 18.1 und 18.2: Der Compositor rechnet nur in Inhalts-Bounds, nutzt Puffer wieder,
 * `color-grade` läuft ohne Allokation, die Vignette nutzt eine gecachte Kurve. Alles bitgleich
 * zum Stand davor (Referenz in `test/reference/`).
 */
import { describe, expect, it } from 'vitest';
import { random, type BlendMode, type EvaluatedNode, type Matrix2D, type RgbaImage } from '@agentic-video/core';
import { applyLayerEffects, compositeFrame, type CompositeInput, type CompositorNode } from '@agentic-video/compositor';
import { compositeFrame as referenceComposite } from './reference/composite-before-18.js';
import { applyLayerEffects as referenceEffects } from './reference/effects-before-18.js';

const W = 48;
const H = 32;

function rnd(seed: number, ...keys: (string | number)[]): number {
  return random(seed, ...keys);
}

function node(id: string, type: string, props: Record<string, unknown>): EvaluatedNode {
  return { id, type, props, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: `/nodes/${id}` };
}

/** Bild mit Inhalt nur in einem zufälligen Rechteck (teils halbtransparent), sonst leer. */
function sparse(seed: number, key: string): RgbaImage {
  const data = new Uint8Array(W * H * 4);
  const x0 = Math.floor(rnd(seed, key, 'x0') * W);
  const y0 = Math.floor(rnd(seed, key, 'y0') * H);
  const x1 = Math.min(W, x0 + 1 + Math.floor(rnd(seed, key, 'w') * W * 0.6));
  const y1 = Math.min(H, y0 + 1 + Math.floor(rnd(seed, key, 'h') * H * 0.6));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const a = rnd(seed, key, x, y, 'a') < 0.3 ? Math.floor(rnd(seed, key, x, y, 'aa') * 256) : 255;
      const o = (y * W + x) * 4;
      data[o] = Math.round(rnd(seed, key, x, y, 'r') * a);
      data[o + 1] = Math.round(rnd(seed, key, x, y, 'g') * a);
      data[o + 2] = Math.round(rnd(seed, key, x, y, 'b') * a);
      data[o + 3] = a;
    }
  }
  return { width: W, height: H, data };
}

const MODES: readonly BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'difference', 'hue', 'add'];

function groupProps(seed: number, key: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    x: Math.round((rnd(seed, key, 'x') - 0.5) * 20),
    y: Math.round((rnd(seed, key, 'y') - 0.5) * 12),
    rotation: rnd(seed, key, 'rot') < 0.5 ? 0 : (rnd(seed, key, 'deg') - 0.5) * 90,
    scale: rnd(seed, key, 'sc') < 0.6 ? 1 : 0.6 + rnd(seed, key, 'scv'),
    opacity: rnd(seed, key, 'op') < 0.5 ? 1 : rnd(seed, key, 'opv'),
    blendMode: MODES[Math.floor(rnd(seed, key, 'mode') * MODES.length)] ?? 'normal',
  };
  const pick = rnd(seed, key, 'fx');
  if (pick < 0.15) p['effects'] = [{ type: 'blur', radius: 1 + rnd(seed, key, 'br') * 2 }];
  else if (pick < 0.3) p['effects'] = [{ type: 'color-grade', exposure: 0.4, contrast: 1.3, saturation: 0.6, temperature: 0.2, tint: -0.1, lift: 0.01, gamma: 1.2, gain: 0.9 }];
  else if (pick < 0.4) p['effects'] = [{ type: 'vignette', amount: 0.7, softness: rnd(seed, key, 'soft') }, { type: 'grain', amount: 0.05 }];
  else if (pick < 0.45) p['effects'] = [{ type: 'color-matrix', matrix: [1, 0, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 0.2] }];
  if (rnd(seed, key, 'crop') < 0.25) p['crop'] = { x: 4, y: 3, width: 30, height: 20 };
  if (rnd(seed, key, 'clip') < 0.2) {
    p['clip'] = true;
    p['width'] = 28;
    p['height'] = 18;
  }
  if (rnd(seed, key, 'filter') < 0.15) p['filters'] = [{ type: 'grayscale', amount: 0.7 }];
  if (rnd(seed, key, 'shadow') < 0.1) p['shadow'] = { color: '#00000080', blur: 2, offsetX: 3, offsetY: 2 };
  return p;
}

function tree(seed: number, key: string, depth: number): CompositorNode {
  const kind = rnd(seed, key, 'kind');
  if (depth >= 2 || kind < 0.35) return { kind: 'image', image: sparse(seed, key) };
  const children = Array.from({ length: 1 + Math.floor(rnd(seed, key, 'n') * 3) }, (_, i) => tree(seed, `${key}.${String(i)}`, depth + 1));
  const withMask = rnd(seed, key, 'mask') < 0.3 ? { mask: { image: sparse(seed, `${key}-mask`), mode: rnd(seed, key, 'mm') < 0.5 ? ('alpha' as const) : ('luminance' as const), invert: rnd(seed, key, 'mi') < 0.3 } } : {};
  const withReveal = rnd(seed, key, 'reveal') < 0.25 ? { reveal: { reveal: rnd(seed, key, 'rt') < 0.5 ? { shape: 'rect' as const, direction: 'right' as const, progress: rnd(seed, key, 'rp') } : { shape: 'ellipse' as const, direction: 'center' as const, progress: rnd(seed, key, 'rp') }, box: { x: 2, y: 2, width: 40, height: 26 } } } : {};
  if (kind < 0.55) {
    const angle = (rnd(seed, key, 'ia') - 0.5) * 0.6;
    const matrix: Matrix2D = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), Math.round(rnd(seed, key, 'itx') * 6), 0];
    return { kind: 'isolate', node: node(key, rnd(seed, key, 'it') < 0.5 ? 'scene3d' : 'html', groupProps(seed, key)), children, matrix, ...withMask, ...withReveal, ...(rnd(seed, key, 'af') < 0.3 ? { applyFilters: true } : {}) };
  }
  return { kind: 'group', node: node(key, rnd(seed, key, 'lt') < 0.5 ? 'group' : 'layer', groupProps(seed, key)), children, ...withMask, ...withReveal };
}

function inputFor(seed: number): CompositeInput {
  const spaces = ['srgb', 'linear', 'rec709'] as const;
  return {
    width: W,
    height: H,
    scale: rnd(seed, 'scale') < 0.7 ? 1 : 0.5,
    background: rnd(seed, 'bg') < 0.5 ? 'transparent' : '#203040',
    workingSpace: spaces[Math.floor(rnd(seed, 'space') * 3)] ?? 'srgb',
    outputSpace: rnd(seed, 'out') < 0.8 ? 'srgb' : 'rec709',
    layers: Array.from({ length: 1 + Math.floor(rnd(seed, 'layers') * 4) }, (_, i) => tree(seed, `L${String(i)}`, 0)),
    frame: 3,
    seed,
  };
}

describe('Compositor auf Inhalts-Bounds (Story 18.1)', () => {
  it('liefert für zufällige Bäume bitgleiche Frames wie vor der Optimierung', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const input = inputFor(seed);
      const expected = referenceComposite(input);
      const actual = compositeFrame(input);
      expect(Buffer.from(actual.data).equals(Buffer.from(expected.data)), `seed ${String(seed)}`).toBe(true);
    }
  });

  it('bleibt bitgleich, wenn Puffer aus dem Pool wiederverwendet werden (keine Reste früherer Frames)', () => {
    const inputs = [inputFor(7), inputFor(8), inputFor(7)];
    const first = compositeFrame(inputs[0] ?? inputFor(7));
    compositeFrame(inputs[1] ?? inputFor(8));
    const again = compositeFrame(inputs[2] ?? inputFor(7));
    expect(Buffer.from(again.data).equals(Buffer.from(first.data))).toBe(true);
  });

  it('mischt reine Bild-Layer (ein und mehrere) in einem Durchlauf bitgleich', () => {
    const spaces = ['srgb', 'linear', 'rec709'] as const;
    for (let seed = 1; seed <= 36; seed++) {
      const count = 1 + (seed % 3);
      const layers: CompositorNode[] = Array.from({ length: count }, (_, i) => ({ kind: 'image', image: sparse(seed, `img${String(i)}`) }));
      const input: CompositeInput = {
        width: W,
        height: H,
        scale: 1,
        background: ['transparent', '#203040', '#FF800080', '#00000000'][seed % 4] ?? 'transparent',
        workingSpace: spaces[seed % 3] ?? 'srgb',
        outputSpace: spaces[Math.floor(seed / 3) % 3] ?? 'srgb',
        layers,
        frame: 0,
        seed,
      };
      expect(Buffer.from(compositeFrame(input).data).equals(Buffer.from(referenceComposite(input).data)), `seed ${String(seed)}`).toBe(true);
    }
  });

  it('transformiert eine Gruppe mit kleinem Inhalt auf großem Frame korrekt (Region am Rand)', () => {
    const img = sparse(3, 'edge');
    const layers: CompositorNode[] = [{ kind: 'group', node: node('g', 'group', { x: -30, y: 25, rotation: 33, scale: 1.7 }), children: [{ kind: 'image', image: img }] }];
    const input: CompositeInput = { width: W, height: H, scale: 1, background: 'transparent', workingSpace: 'linear', layers, frame: 0, seed: 1 };
    expect(Buffer.from(compositeFrame(input).data).equals(Buffer.from(referenceComposite(input).data))).toBe(true);
  });
});

describe('color-grade und Vignette (Story 18.2)', () => {
  it('rechnet color-grade und Vignette bitgleich zur Pixel-für-Pixel-Rechnung', () => {
    const image = sparse(11, 'grade');
    const effects = [
      { type: 'color-grade', exposure: -0.3, contrast: 0.8, saturation: 1.4, temperature: -0.3, tint: 0.2, lift: -0.02, gamma: 0.7, gain: 1.1 },
      { type: 'vignette', amount: 0.9, softness: 0.3 },
      { type: 'vignette', amount: 0.4 },
      { type: 'color-grade', exposure: 1 },
    ];
    for (const ctx of [{ scale: 1, frame: 0, seed: 1 }]) {
      expect(Buffer.from(applyLayerEffects(image, effects, ctx).data).equals(Buffer.from(referenceEffects(image, effects, ctx).data))).toBe(true);
    }
  });

  it('nutzt die gecachte Vignetten-Kurve auch bei ungeraden Maßen bitgleich', () => {
    const odd: RgbaImage = { width: 7, height: 5, data: new Uint8Array(7 * 5 * 4).fill(200) };
    const effects = [{ type: 'vignette', amount: 1, softness: 0 }, { type: 'vignette', amount: 0.5, softness: 0.8 }];
    expect(Buffer.from(applyLayerEffects(odd, effects, { scale: 1, frame: 0, seed: 1 }).data).equals(Buffer.from(referenceEffects(odd, effects, { scale: 1, frame: 0, seed: 1 }).data))).toBe(true);
  });
});
