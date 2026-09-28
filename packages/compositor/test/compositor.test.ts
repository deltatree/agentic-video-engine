import { describe, expect, it } from 'vitest';
import { BLEND_MODES, isOpenVideoError, type BlendMode, type EffectDefinition, type EvaluatedNode, type RgbaImage } from '@agentic-video/core';
import Type from 'typebox';
import {
  accumulateFrames,
  applyLayerEffects,
  BLEND_FUNCTIONS,
  blendPixel,
  compositeFrame,
  convertColorSpace,
  createFloatImage,
  gaussianBlur,
  gradeColor,
  NEUTRAL_GRADE,
  parseCubeLut,
  type CompositeInput,
  type CompositorNode,
} from '@agentic-video/compositor';

/** Einfarbiges Bild; Farbe gerade, Ausgabe vormultipliziert. */
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

function group(props: Record<string, unknown>, id = 'g'): EvaluatedNode {
  return { id, type: 'group', props, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: `/nodes/${id}` };
}

function base(layers: CompositorNode[], extra: Partial<CompositeInput> = {}): CompositeInput {
  return { width: 4, height: 4, scale: 1, background: 'transparent', workingSpace: 'srgb', layers, frame: 0, seed: 1, ...extra };
}

function px(img: RgbaImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [...img.data.slice(i, i + 4)];
}

function expectClose(actual: readonly number[], expected: readonly number[], tol = 1): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => {
    expect(Math.abs(v - (expected[i] ?? NaN)), `channel ${String(i)}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`).toBeLessThanOrEqual(tol);
  });
}

/** Erwartet einen OpenVideoError mit genau diesem Code. */
function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isOpenVideoError(caught) ? caught.diagnostic.code : caught).toBe(code);
}

// Referenzwerte unabhängig nach W3C Compositing and Blending Level 1 berechnet (Python).
// Backdrop A = (204, 102, 51), Quelle A = (51, 153, 230); Backdrop B = (64, 128, 32), Quelle B = (96, 48, 160).
const BLEND_TABLE: readonly [BlendMode, number[], number[]][] = [
  ['normal', [51, 153, 230], [96, 48, 160]],
  ['multiply', [41, 61, 46], [24, 24, 20]],
  ['screen', [214, 194, 235], [136, 152, 172]],
  ['overlay', [173, 122, 92], [48, 49, 40]],
  ['darken', [51, 102, 51], [64, 48, 32]],
  ['lighten', [204, 153, 230], [96, 128, 160]],
  ['color-dodge', [255, 255, 255], [103, 158, 86]],
  ['color-burn', [0, 0, 29], [0, 0, 0]],
  ['hard-light', [82, 133, 215], [48, 48, 89]],
  ['soft-light', [180, 114, 102], [52, 88, 46]],
  ['difference', [153, 51, 179], [32, 80, 128]],
  ['exclusion', [173, 133, 189], [112, 128, 152]],
  ['add', [255, 255, 255], [160, 176, 192]],
  ['hue', [59, 146, 212], [116, 75, 171]],
  ['saturation', [217, 98, 38], [58, 133, 21]],
  ['color', [47, 149, 226], [120, 72, 184]],
  ['luminosity', [208, 106, 55], [40, 104, 8]],
];

describe('Blend Modes', () => {
  it('deckt alle 17 Modes ab', () => {
    expect(BLEND_TABLE.map((r) => r[0]).sort()).toEqual([...BLEND_MODES].sort());
    expect(Object.keys(BLEND_FUNCTIONS).sort()).toEqual([...BLEND_MODES].sort());
  });

  it.each(BLEND_TABLE)('%s stimmt mit der W3C-Formel überein (±1)', (mode, expectedA, expectedB) => {
    const pairs: [number[], number[], number[]][] = [
      [[204, 102, 51], [51, 153, 230], expectedA],
      [[64, 128, 32], [96, 48, 160], expectedB],
    ];
    for (const [back, src, expected] of pairs) {
      const out = compositeFrame(
        base([
          { kind: 'image', image: solid(4, 4, [back[0] ?? 0, back[1] ?? 0, back[2] ?? 0, 255]) },
          { kind: 'group', node: group({ blendMode: mode }), children: [{ kind: 'image', image: solid(4, 4, [src[0] ?? 0, src[1] ?? 0, src[2] ?? 0, 255]) }] },
        ]),
      );
      expectClose(px(out, 1, 2), [...expected, 255]);
    }
  });

  it('mischt nach Source-over, wenn Quelle oder Backdrop halbtransparent sind', () => {
    // multiply, Quelle Rot mit Alpha 0.5 über transparentem Backdrop → nur die Quelle.
    const out = blendPixel('multiply', [0, 0, 0, 0], [0.5, 0, 0, 0.5]);
    expectClose(out, [0.5, 0, 0, 0.5], 1e-9);
  });

  it('meldet unbekannte Blend Modes mit OV_BLEND_UNKNOWN', () => {
    const run = () => compositeFrame(base([{ kind: 'group', node: group({ blendMode: 'plus' }), children: [] }]));
    expectCode(run, 'OV_BLEND_UNKNOWN');
  });
});

describe('Color Management', () => {
  const halfWhite = solid(4, 4, [255, 255, 255, 128]);

  it('50 % Weiß über Schwarz: sRGB 128, linear 188', () => {
    const layers: CompositorNode[] = [{ kind: 'image', image: halfWhite }];
    const srgb = compositeFrame(base(layers, { background: '#000000', workingSpace: 'srgb' }));
    const linear = compositeFrame(base(layers, { background: '#000000', workingSpace: 'linear' }));
    expectClose(px(srgb, 0, 0), [128, 128, 128, 255]);
    expectClose(px(linear, 0, 0), [188, 188, 188, 255]);
  });

  it('Gruppen-Opacity 0.5 wirkt wie 50 % Alpha', () => {
    const layers: CompositorNode[] = [{ kind: 'group', node: group({ opacity: 0.5 }), children: [{ kind: 'image', image: solid(4, 4, [255, 255, 255, 255]) }] }];
    expectClose(px(compositeFrame(base(layers, { background: '#000000', workingSpace: 'linear' })), 2, 2), [188, 188, 188, 255]);
  });

  it('erhält Alpha: halbtransparenter Layer auf transparentem Hintergrund', () => {
    for (const workingSpace of ['srgb', 'linear', 'rec709'] as const) {
      const out = compositeFrame(base([{ kind: 'image', image: solid(4, 4, [200, 100, 50, 128]) }], { workingSpace }));
      const p = px(out, 3, 3);
      expect(Math.abs((p[3] ?? 0) - 128)).toBeLessThanOrEqual(1);
      // Farbe bleibt nach Entpremultiplizieren erhalten.
      expectClose([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0].map((v) => (v * 255) / (p[3] ?? 1)), [200, 100, 50], 2);
    }
  });

  it('setzt eine Hintergrundfarbe mit Alpha', () => {
    expectClose(px(compositeFrame(base([], { background: '#FF000080' })), 0, 0), [128, 0, 0, 128]);
  });

  it('kodiert die Ausgabe als Rec. 709', () => {
    const out = compositeFrame(base([{ kind: 'image', image: halfWhite }], { background: '#000000', workingSpace: 'linear', outputSpace: 'rec709' }));
    // linear 0.502 → BT.709-OETF 1.099·0.502^0.45 − 0.099 = 0.7057 → 180
    expectClose(px(out, 0, 0), [180, 180, 180, 255]);
  });

  it('convertColorSpace: sRGB ↔ linear ↔ Rec. 709 hin und zurück', () => {
    const img = solid(2, 1, [200, 100, 50, 255]);
    const lin = convertColorSpace(img, 'srgb', 'linear');
    expectClose(px(lin, 0, 0), [148, 32, 8, 255]);
    expectClose(px(convertColorSpace(lin, 'linear', 'srgb'), 0, 0), [200, 100, 50, 255], 3);
    expectClose(px(convertColorSpace(convertColorSpace(img, 'srgb', 'rec709'), 'rec709', 'srgb'), 1, 0), [200, 100, 50, 255], 1);
  });

  it('accumulateFrames mittelt im linearen Raum', () => {
    const out = accumulateFrames([solid(2, 2, [0, 0, 0, 255]), solid(2, 2, [255, 255, 255, 255])]);
    expectClose(px(out, 1, 1), [188, 188, 188, 255]);
    const alpha = accumulateFrames([solid(2, 2, [255, 255, 255, 255]), solid(2, 2, [0, 0, 0, 0])]);
    expectClose(px(alpha, 0, 0), [128, 128, 128, 128]);
    expectCode(() => accumulateFrames([]), 'OV_COMPOSITOR_INPUT');
  });
});

describe('Masken', () => {
  const white = solid(4, 4, [255, 255, 255, 255]);
  const run = (mask: RgbaImage, mode: 'alpha' | 'luminance', invert: boolean) =>
    compositeFrame(base([{ kind: 'group', node: group({}), children: [{ kind: 'image', image: white }], mask: { image: mask, mode, invert } }]));

  it('alpha: Deckkraft der Maske', () => {
    const out = run(solid(4, 4, [0, 0, 0, 64]), 'alpha', false);
    expectClose(px(out, 0, 0), [64, 64, 64, 64]);
  });

  it('alpha invertiert', () => {
    expectClose(px(run(solid(4, 4, [0, 0, 0, 64]), 'alpha', true), 0, 0), [191, 191, 191, 191]);
  });

  it('luminance: Helligkeit × Alpha', () => {
    // Grau 128 deckend → 0.502; Rot deckend → 0.2126; Weiß halbtransparent → 0.502.
    expectClose(px(run(solid(4, 4, [128, 128, 128, 255]), 'luminance', false), 0, 0), [128, 128, 128, 128]);
    expectClose(px(run(solid(4, 4, [255, 0, 0, 255]), 'luminance', false), 0, 0), [54, 54, 54, 54]);
    expectClose(px(run(solid(4, 4, [255, 255, 255, 128]), 'luminance', false), 0, 0), [128, 128, 128, 128]);
  });

  it('luminance invertiert', () => {
    expectClose(px(run(solid(4, 4, [255, 0, 0, 255]), 'luminance', true), 0, 0), [201, 201, 201, 201]);
  });

  it('prüft die Maskengröße', () => {
    expectCode(() => run(solid(2, 2, [0, 0, 0, 255]), 'alpha', false), 'OV_COMPOSITOR_IMAGE_SIZE');
  });
});

describe('Transform, Crop und Skalierung', () => {
  /** 20×20-Bild mit rotem Quadrat im linken oberen Viertel. */
  function quadrant(): RgbaImage {
    const img = solid(20, 20, [0, 0, 0, 0]);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) img.data.set([255, 0, 0, 255], (y * 20 + x) * 4);
    return img;
  }

  it('Rotation 90° um die Mitte legt das Viertel nach rechts oben', () => {
    const out = compositeFrame({
      ...base([{ kind: 'group', node: group({ width: 20, height: 20, rotation: 90 }), children: [{ kind: 'image', image: quadrant() }] }]),
      width: 20,
      height: 20,
    });
    expect(px(out, 15, 5)).toEqual([255, 0, 0, 255]);
    expect(px(out, 19, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out, 10, 9)).toEqual([255, 0, 0, 255]);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(px(out, 15, 15)).toEqual([0, 0, 0, 0]);
    expect(px(out, 9, 9)).toEqual([0, 0, 0, 0]);
  });

  it('Verschiebung wirkt mit der Vorschau-Skalierung', () => {
    // x = 10 Composition-Pixel bei scale 0.5 → 5 Ausgabepixel.
    const out = compositeFrame({
      ...base([{ kind: 'group', node: group({ x: 10 }), children: [{ kind: 'image', image: quadrant() }] }], { scale: 0.5 }),
      width: 20,
      height: 20,
    });
    expect(px(out, 4, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 5, 0)).toEqual([255, 0, 0, 255]);
    expect(px(out, 14, 9)).toEqual([255, 0, 0, 255]);
    expect(px(out, 15, 0)).toEqual([0, 0, 0, 0]);
  });

  it('Halbpixel-Verschiebung interpoliert bilinear', () => {
    const out = compositeFrame({
      ...base([{ kind: 'group', node: group({ x: 0.5 }), children: [{ kind: 'image', image: quadrant() }] }]),
      width: 20,
      height: 20,
    });
    expectClose(px(out, 0, 0), [128, 0, 0, 128]);
    expect(px(out, 5, 5)).toEqual([255, 0, 0, 255]);
    expectClose(px(out, 10, 5), [128, 0, 0, 128]);
  });

  it('crop beschneidet vor dem Transform', () => {
    const out = compositeFrame(base([{ kind: 'group', node: group({ crop: { x: 1, y: 1, width: 2, height: 1 } }), children: [{ kind: 'image', image: solid(4, 4, [255, 255, 255, 255]) }] }]));
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(px(out, 2, 1)).toEqual([255, 255, 255, 255]);
    expect(px(out, 3, 1)).toEqual([0, 0, 0, 0]);
    expect(px(out, 1, 2)).toEqual([0, 0, 0, 0]);
  });

  it('verschachtelte Gruppen: Opacity multipliziert sich', () => {
    const inner: CompositorNode = { kind: 'group', node: group({ opacity: 0.5 }, 'inner'), children: [{ kind: 'image', image: solid(4, 4, [255, 255, 255, 255]) }] };
    const out = compositeFrame(base([{ kind: 'group', node: group({ opacity: 0.5 }, 'outer'), children: [inner] }]));
    expectClose(px(out, 0, 0), [64, 64, 64, 64]);
  });

  it('prüft Layer-Größe und Eingaben', () => {
    expectCode(() => compositeFrame(base([{ kind: 'image', image: solid(3, 4, [0, 0, 0, 255]) }])), 'OV_COMPOSITOR_IMAGE_SIZE');
    expectCode(() => compositeFrame(base([], { scale: 0 })), 'OV_COMPOSITOR_INPUT');
    expectCode(() => compositeFrame(base([], { width: 0 })), 'OV_COMPOSITOR_INPUT');
    expectCode(() => compositeFrame(base([], { background: 'red' })), 'OV_COLOR_INVALID');
  });
});

describe('LUT (.cube)', () => {
  const lattice = (size: number, f: (r: number, g: number, b: number) => [number, number, number]): string => {
    const lines: string[] = [];
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).join(' '));
    return lines.join('\n');
  };
  const identity = `# Identität\nTITLE "Identity"\nLUT_3D_SIZE 3\n${lattice(3, (r, g, b) => [r, g, b])}\n`;
  const inverse = `LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${lattice(2, (r, g, b) => [1 - r, 1 - g, 1 - b])}\n`;

  const run = (text: string, intensity?: number) => {
    const lut = parseCubeLut(text);
    return compositeFrame(
      base(
        [{ kind: 'group', node: group({ effects: [{ type: 'lut', asset: 'look', ...(intensity !== undefined ? { intensity } : {}) }] }), children: [{ kind: 'image', image: solid(4, 4, [200, 100, 50, 255]) }] }],
        { resolveLut: (id) => (id === 'look' ? lut : undefined) },
      ),
    );
  };

  it('parst Kopfdaten', () => {
    const lut = parseCubeLut(identity);
    expect(lut).toMatchObject({ kind: '3d', size: 3, title: 'Identity' });
    expect(lut.data.length).toBe(27 * 3);
  });

  it('Identität lässt das Bild unverändert', () => {
    expectClose(px(run(identity), 0, 0), [200, 100, 50, 255]);
  });

  it('Invertierung kehrt die Farben um', () => {
    expectClose(px(run(inverse), 0, 0), [55, 155, 205, 255]);
  });

  it('intensity mischt im kodierten Raum', () => {
    expectClose(px(run(inverse, 0.5), 0, 0), [128, 128, 128, 255]);
  });

  it('1D-LUT wirkt je Kanal', () => {
    const lut = parseCubeLut('LUT_1D_SIZE 2\n1 1 1\n0 0 0\n');
    const out = applyLayerEffects(solid(1, 1, [200, 100, 50, 255]), [{ type: 'lut', asset: 'x' }], { scale: 1, frame: 0, seed: 0, resolveLut: () => lut });
    expectClose(px(out, 0, 0), [55, 155, 205, 255]);
  });

  it('meldet kaputte Dateien und fehlende LUTs', () => {
    expectCode(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n'), 'OV_LUT_INVALID');
    expectCode(() => parseCubeLut('0 0 0\n'), 'OV_LUT_INVALID');
    expectCode(() => parseCubeLut('LUT_3D_SIZE 2\nFOO 1\n'), 'OV_LUT_INVALID');
    expectCode(() => applyLayerEffects(solid(1, 1, [0, 0, 0, 255]), [{ type: 'lut', asset: 'nope' }], { scale: 1, frame: 0, seed: 0 }), 'OV_LUT_MISSING');
  });
});

describe('Effekte', () => {
  const ctx = { scale: 1, frame: 0, seed: 7 };

  it('unbekannter Effekt: OV_EFFECT_UNKNOWN', () => {
    expectCode(() => applyLayerEffects(solid(2, 2, [0, 0, 0, 255]), [{ type: 'sparkle' }], ctx), 'OV_EFFECT_UNKNOWN');
  });

  it('Plugin-Effekt aus der Registry-Map', () => {
    const invertFx: EffectDefinition = {
      type: 'invert',
      schema: Type.Object({ type: Type.Literal('invert') }),
      apply: (img) => ({ ...img, data: img.data.map((v, i) => (i % 4 === 3 ? v : 255 - v)) }),
    };
    const out = compositeFrame(
      base([{ kind: 'group', node: group({ effects: [{ type: 'invert' }] }), children: [{ kind: 'image', image: solid(4, 4, [200, 100, 50, 255]) }] }], {
        effects: new Map([['invert', invertFx]]),
      }),
    );
    expectClose(px(out, 0, 0), [55, 155, 205, 255]);
  });

  it('blur: erhält die Summe im Inneren und ist symmetrisch', () => {
    const img = solid(21, 21, [0, 0, 0, 0]);
    img.data.set([255, 255, 255, 255], (10 * 21 + 10) * 4);
    const out = applyLayerEffects(img, [{ type: 'blur', radius: 2 }], ctx);
    expect(px(out, 8, 10)).toEqual(px(out, 12, 10));
    expect(px(out, 10, 8)).toEqual(px(out, 10, 12));
    // Im Inneren bleibt die Summe erhalten (Float, ohne 8-Bit-Rundung).
    const f = createFloatImage(21, 21);
    f.data.set([1, 1, 1, 1], (10 * 21 + 10) * 4);
    const blurred = gaussianBlur(f, 2).data;
    let alphaSum = 0;
    for (let i = 3; i < blurred.length; i += 4) alphaSum += blurred[i] ?? 0;
    expect(alphaSum).toBeCloseTo(1, 5);
    // Rand ist transparent: Kanten eines deckenden Bildes werden weicher.
    const edge = applyLayerEffects(solid(9, 9, [255, 255, 255, 255]), [{ type: 'blur', radius: 1 }], ctx);
    expect(px(edge, 0, 4)[3]).toBeLessThan(255);
    expect(px(edge, 4, 4)[3]).toBe(255);
  });

  it('color-grade: exposure +1 verdoppelt lineares Licht, contrast hält 0.18 fest', () => {
    expectClose(gradeColor([0.18, 0.18, 0.18], { ...NEUTRAL_GRADE, exposure: 1 }), [0.36, 0.36, 0.36], 1e-9);
    expectClose(gradeColor([0.18, 0.5, 0.05], { ...NEUTRAL_GRADE, contrast: 2 }).slice(0, 1), [0.18], 1e-9);
    expectClose(gradeColor([0.5, 0.2, 0.1], { ...NEUTRAL_GRADE, saturation: 0 }), [0.25656, 0.25656, 0.25656], 1e-6);
    expectClose(gradeColor([0.25, 0.25, 0.25], { ...NEUTRAL_GRADE, gain: 2, lift: 0.1, gamma: 2 }), [Math.sqrt(0.6), Math.sqrt(0.6), Math.sqrt(0.6)], 1e-9);
    // Im Compositor: 18 % Grau (sRGB 118) mit exposure +1 → linear 0.36 → sRGB 162.
    const out = applyLayerEffects(solid(1, 1, [118, 118, 118, 255]), [{ type: 'color-grade', exposure: 1 }], ctx);
    expectClose(px(out, 0, 0), [162, 162, 162, 255]);
  });

  it('grain ist deterministisch je Frame und Seed', () => {
    const img = solid(8, 8, [128, 128, 128, 255]);
    const a = applyLayerEffects(img, [{ type: 'grain', amount: 0.2 }], ctx);
    const b = applyLayerEffects(img, [{ type: 'grain', amount: 0.2 }], ctx);
    const c = applyLayerEffects(img, [{ type: 'grain', amount: 0.2 }], { ...ctx, frame: 1 });
    expect(a.data).toEqual(b.data);
    expect(a.data).not.toEqual(c.data);
    expect(a.data).not.toEqual(img.data);
  });

  it('vignette dunkelt die Ecken, nicht die Mitte', () => {
    const out = applyLayerEffects(solid(9, 9, [255, 255, 255, 255]), [{ type: 'vignette', amount: 1, softness: 0.5 }], ctx);
    expect(px(out, 4, 4)).toEqual([255, 255, 255, 255]);
    expect(px(out, 0, 0)[0]).toBeLessThan(128);
    expect(px(out, 0, 0)[0]).toBeLessThan(px(out, 2, 2)[0] ?? 0);
  });

  it('glow hellt die Umgebung heller Pixel auf', () => {
    const img = solid(9, 9, [0, 0, 0, 255]);
    img.data.set([255, 255, 255, 255], (4 * 9 + 4) * 4);
    const out = applyLayerEffects(img, [{ type: 'glow', radius: 1, intensity: 1 }], ctx);
    expect(px(out, 5, 4)[0]).toBeGreaterThan(0);
    expect(px(out, 0, 0)[0]).toBe(0);
  });

  it('chromatic-aberration verschiebt Rot und Blau gegenläufig', () => {
    const img = solid(21, 21, [0, 0, 0, 255]);
    img.data.set([255, 255, 255, 255], (10 * 21 + 18) * 4);
    const out = applyLayerEffects(img, [{ type: 'chromatic-aberration', amount: 3 }], ctx);
    const p = px(out, 18, 10);
    expect(p[1]).toBe(255);
    expect(p[0]).toBeLessThan(255);
    expect(p[2]).toBeLessThan(255);
  });

  it('color-matrix wirkt wie feColorMatrix', () => {
    const swap = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0];
    expectClose(px(applyLayerEffects(solid(1, 1, [200, 100, 50, 255]), [{ type: 'color-matrix', matrix: swap }], ctx), 0, 0), [50, 100, 200, 255]);
    expectCode(() => applyLayerEffects(solid(1, 1, [0, 0, 0, 255]), [{ type: 'color-matrix', matrix: [1] }], ctx), 'OV_EFFECT_INVALID');
  });

  it('Pflichtparameter fehlen: OV_EFFECT_INVALID', () => {
    expectCode(() => applyLayerEffects(solid(1, 1, [0, 0, 0, 255]), [{ type: 'blur' }], ctx), 'OV_EFFECT_INVALID');
  });
});

describe('Performance', () => {
  it('1920×1080, drei Layer, normal: unter 600 ms', () => {
    const w = 1920;
    const h = 1080;
    const layers: CompositorNode[] = [
      { kind: 'image', image: solid(w, h, [10, 20, 30, 255]) },
      { kind: 'image', image: solid(w, h, [200, 100, 50, 128]) },
      { kind: 'image', image: solid(w, h, [50, 200, 100, 64]) },
    ];
    const input: CompositeInput = { width: w, height: h, scale: 1, background: '#000000', workingSpace: 'srgb', layers, frame: 0, seed: 1 };
    compositeFrame(input); // Aufwärmen (JIT)
    const start = performance.now();
    compositeFrame(input);
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(600);
  });
});
