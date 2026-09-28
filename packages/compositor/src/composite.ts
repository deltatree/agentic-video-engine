/**
 * Compositor (FR-45..FR-47, AD-6): setzt Render-Layer zu einem Frame zusammen.
 *
 * Rechenweg: Float32, vormultipliziertes Alpha. Gemischt wird im Arbeitsraum
 * (`workingSpace`); Effekte rechnen in linearem Licht; die Ausgabe wird mit
 * `outputSpace` kodiert. Plattformunabhängig (keine Node-APIs).
 */
import {
  BLEND_MODES,
  getString,
  getTransform,
  invert,
  isRecord,
  localMatrix,
  multiply,
  OpenVideoError,
  parseColor,
  scale as scaleMatrix,
  type BlendMode,
  type EffectDefinition,
  type EvaluatedNode,
  type Matrix2D,
  type RgbaImage,
} from '@agentic-video/core';
import { blendPixel, separableChannel } from './blend.js';
import { assertImage, clamp01, convertFloatInPlace, createFloatImage, decodeTable, encodeTransfer, floatToRgba, rgbaToFloat, srgbToLinear, type FloatImage } from './color.js';
import { applyEffectsLinear, type EffectContext } from './effects.js';
import type { Lut } from './lut.js';

/** Maske eines Gruppen-Knotens: ein Bild in Ausgabegröße im lokalen Raum der Gruppe. */
export interface CompositorMask {
  readonly image: RgbaImage;
  readonly mode: 'alpha' | 'luminance';
  readonly invert: boolean;
}

/**
 * Knoten des Compositor-Baums. `image` ist ein fertig gerenderter Layer in Ausgabegröße.
 * `group` komponiert seine Kinder und wendet Effekte, Crop, Maske, Transform, Opacity und
 * Blend Mode der Node an.
 */
export type CompositorNode =
  | { readonly kind: 'image'; readonly image: RgbaImage }
  | { readonly kind: 'group'; readonly node: EvaluatedNode; readonly children: readonly CompositorNode[]; readonly mask?: CompositorMask };

/** Eingabe für {@link compositeFrame}. */
export interface CompositeInput {
  /** Ausgabebreite in Pixeln. */
  readonly width: number;
  /** Ausgabehöhe in Pixeln. */
  readonly height: number;
  /** Vorschau-Skalierung Composition → Ausgabe (1 = volle Auflösung). */
  readonly scale: number;
  /** `#RRGGBB`, `#RRGGBBAA` (sRGB) oder `transparent`. */
  readonly background: string;
  /** Raum, in dem gemischt wird. */
  readonly workingSpace: 'srgb' | 'linear' | 'rec709';
  /** Transferfunktion der Ausgabe. Standard `srgb`. */
  readonly outputSpace?: 'srgb' | 'rec709';
  /** Layer von unten nach oben. */
  readonly layers: readonly CompositorNode[];
  /** Composition-Frame (für `grain`). */
  readonly frame: number;
  readonly seed: number;
  readonly resolveLut?: (assetId: string) => Lut | undefined;
  /** Plugin-Effekte aus der Registry (`registry.effects`). */
  readonly effects?: ReadonlyMap<string, EffectDefinition>;
}

type Space = CompositeInput['workingSpace'];

interface Ctx extends EffectContext {
  readonly width: number;
  readonly height: number;
  readonly space: Space;
}

function inputError(problem: string, suggestion: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_COMPOSITOR_INPUT', errorClass: 'CompositorError', problem, suggestions: [suggestion] });
}

function assertLayerSize(image: RgbaImage, ctx: Ctx, what: string): void {
  assertImage(image, what);
  if (image.width !== ctx.width || image.height !== ctx.height) {
    throw new OpenVideoError({
      code: 'OV_COMPOSITOR_IMAGE_SIZE',
      errorClass: 'CompositorError',
      problem: `${what} is ${String(image.width)}x${String(image.height)}, expected ${String(ctx.width)}x${String(ctx.height)}.`,
      suggestions: ['Render every layer and mask at the output size (request.width x request.height).'],
    });
  }
}

function blendModeOf(node: EvaluatedNode): BlendMode {
  const mode = getString(node, 'blendMode', 'normal');
  const found = BLEND_MODES.find((m) => m === mode);
  if (found === undefined) {
    throw new OpenVideoError({
      code: 'OV_BLEND_UNKNOWN',
      errorClass: 'CompositorError',
      problem: `Unknown blend mode "${mode}".`,
      nodeId: node.id,
      pointer: node.pointer,
      suggestions: [`Use one of: ${BLEND_MODES.join(', ')}.`],
    });
  }
  return found;
}

/**
 * Mischt ein 8-Bit-Bild (sRGB, vormultipliziert) mit `normal` direkt in das Float-Ziel.
 * Die Umrechnung in den Arbeitsraum läuft über eine Tabelle; kein Zwischenpuffer.
 */
function blendRgbaNormal(target: FloatImage, image: RgbaImage, space: Space): void {
  const t = target.data;
  const s = image.data;
  const table = decodeTable(space);
  const k = 1 / 255;
  for (let i = 0; i < s.length; i += 4) {
    const a8 = s[i + 3] ?? 0;
    if (a8 === 0) continue;
    const row = a8 << 8;
    const r = table[row | (s[i] ?? 0)] ?? 0;
    const g = table[row | (s[i + 1] ?? 0)] ?? 0;
    const b = table[row | (s[i + 2] ?? 0)] ?? 0;
    if (a8 === 255) {
      t[i] = r;
      t[i + 1] = g;
      t[i + 2] = b;
      t[i + 3] = 1;
      continue;
    }
    const inv = 1 - a8 * k;
    t[i] = r + (t[i] ?? 0) * inv;
    t[i + 1] = g + (t[i + 1] ?? 0) * inv;
    t[i + 2] = b + (t[i + 2] ?? 0) * inv;
    t[i + 3] = a8 * k + (t[i + 3] ?? 0) * inv;
  }
}

/** Mischt `source` mit Deckkraft `opacity` und Blend Mode `mode` in `target` (beide vormultipliziert). */
function blendInto(target: FloatImage, source: FloatImage, mode: BlendMode, opacity: number): void {
  const t = target.data;
  const s = source.data;
  const op = clamp01(opacity);
  if (op === 0) return;
  const channel = separableChannel(mode);
  for (let i = 0; i < s.length; i += 4) {
    const sa = s[i + 3] ?? 0;
    const as = clamp01(sa * op);
    if (as <= 0) continue;
    if (mode === 'normal') {
      const inv = 1 - as;
      t[i] = (s[i] ?? 0) * op + (t[i] ?? 0) * inv;
      t[i + 1] = (s[i + 1] ?? 0) * op + (t[i + 1] ?? 0) * inv;
      t[i + 2] = (s[i + 2] ?? 0) * op + (t[i + 2] ?? 0) * inv;
      t[i + 3] = as + (t[i + 3] ?? 0) * inv;
      continue;
    }
    const ab = clamp01(t[i + 3] ?? 0);
    if (channel !== undefined) {
      const both = as * ab;
      for (let c = 0; c < 3; c++) {
        const cs = clamp01((s[i + c] ?? 0) / sa);
        const cb = ab > 0 ? clamp01((t[i + c] ?? 0) / ab) : 0;
        t[i + c] = cs * as * (1 - ab) + cb * ab * (1 - as) + both * channel(cb, cs);
      }
      t[i + 3] = as + ab * (1 - as);
      continue;
    }
    const out = blendPixel(mode, [t[i] ?? 0, t[i + 1] ?? 0, t[i + 2] ?? 0, ab], [(s[i] ?? 0) * op, (s[i + 1] ?? 0) * op, (s[i + 2] ?? 0) * op, as]);
    t[i] = out[0];
    t[i + 1] = out[1];
    t[i + 2] = out[2];
    t[i + 3] = out[3];
  }
}

/** Setzt alle Pixel außerhalb des Crop-Rechtecks (lokale Koordinaten × scale) auf transparent. */
function applyCrop(image: FloatImage, crop: Readonly<Record<string, unknown>>, scale: number): void {
  const n = (k: string, f: number): number => {
    const v = crop[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : f;
  };
  const x0 = Math.round(n('x', 0) * scale);
  const y0 = Math.round(n('y', 0) * scale);
  const x1 = Math.round((n('x', 0) + n('width', image.width / scale)) * scale);
  const y1 = Math.round((n('y', 0) + n('height', image.height / scale)) * scale);
  const { width: w, height: h, data: d } = image;
  for (let y = 0; y < h; y++) {
    const inY = y >= y0 && y < y1;
    for (let x = 0; x < w; x++) {
      if (inY && x >= x0 && x < x1) continue;
      d.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
}

/**
 * Multipliziert das Bild mit der Maske. `alpha`: Maskenwert = Alpha;
 * `luminance`: Rec.-709-Luma der sRGB-kodierten, vormultiplizierten Werte (= Helligkeit × Alpha).
 * `invert` nutzt `1 − Maskenwert`.
 */
function applyMask(image: FloatImage, mask: CompositorMask): void {
  const m = mask.image.data;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = mask.mode === 'alpha' ? (m[i + 3] ?? 0) / 255 : (0.2126 * (m[i] ?? 0) + 0.7152 * (m[i + 1] ?? 0) + 0.0722 * (m[i + 2] ?? 0)) / 255;
    if (mask.invert) v = 1 - v;
    if (v === 1) continue;
    d[i] = (d[i] ?? 0) * v;
    d[i + 1] = (d[i + 1] ?? 0) * v;
    d[i + 2] = (d[i + 2] ?? 0) * v;
    d[i + 3] = (d[i + 3] ?? 0) * v;
  }
}

function isIdentity(m: Matrix2D): boolean {
  const e = 1e-9;
  return Math.abs(m[0] - 1) < e && Math.abs(m[1]) < e && Math.abs(m[2]) < e && Math.abs(m[3] - 1) < e && Math.abs(m[4]) < e && Math.abs(m[5]) < e;
}

/**
 * Transformiert ein Bild mit der Matrix `m` (Pixel → Pixel). Rückwärtsabbildung der
 * Pixelmitten, bilineare Interpolation, außerhalb transparent.
 */
function transformImage(image: FloatImage, m: Matrix2D): FloatImage {
  const { width: w, height: h, data: src } = image;
  const out = createFloatImage(w, h);
  const inv = invert(m);
  if (inv === undefined) return out;
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const sx = inv[0] * px + inv[2] * py + inv[4] - 0.5;
      const sy = inv[1] * px + inv[3] * py + inv[5] - 0.5;
      if (sx <= -1 || sy <= -1 || sx >= w || sy >= h) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const tx = sx - x0;
      const ty = sy - y0;
      const o = (y * w + x) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const in0 = y0 >= 0;
      const in1 = y0 + 1 < h;
      const l0 = x0 >= 0;
      const l1 = x0 + 1 < w;
      for (let c = 0; c < 4; c++) {
        let v = 0;
        if (in0 && l0) v += (src[(y0 * w + x0) * 4 + c] ?? 0) * w00;
        if (in0 && l1) v += (src[(y0 * w + x0 + 1) * 4 + c] ?? 0) * w10;
        if (in1 && l0) v += (src[((y0 + 1) * w + x0) * 4 + c] ?? 0) * w01;
        if (in1 && l1) v += (src[((y0 + 1) * w + x0 + 1) * 4 + c] ?? 0) * w11;
        d[o + c] = v;
      }
    }
  }
  return out;
}

function renderGroup(node: EvaluatedNode, children: readonly CompositorNode[], mask: CompositorMask | undefined, ctx: Ctx): FloatImage {
  let off = createFloatImage(ctx.width, ctx.height);
  for (const child of children) compositeLayer(off, child, ctx);
  const effects = node.props['effects'];
  if (Array.isArray(effects) && effects.length > 0) {
    const list: readonly unknown[] = effects;
    convertFloatInPlace(off, ctx.space, 'linear');
    off = applyEffectsLinear(off, list, ctx);
    convertFloatInPlace(off, 'linear', ctx.space);
  }
  const crop = node.props['crop'];
  if (isRecord(crop)) applyCrop(off, crop, ctx.scale);
  if (mask !== undefined) {
    assertLayerSize(mask.image, ctx, `Mask of group "${node.id}"`);
    applyMask(off, mask);
  }
  const s = ctx.scale;
  const m = multiply(scaleMatrix(s, s), multiply(localMatrix(node), scaleMatrix(1 / s, 1 / s)));
  return isIdentity(m) ? off : transformImage(off, m);
}

function compositeLayer(target: FloatImage, layer: CompositorNode, ctx: Ctx): void {
  if (layer.kind === 'image') {
    assertLayerSize(layer.image, ctx, 'Layer image');
    blendRgbaNormal(target, layer.image, ctx.space);
    return;
  }
  const mode = blendModeOf(layer.node);
  const opacity = getTransform(layer.node).opacity;
  if (opacity <= 0) return;
  blendInto(target, renderGroup(layer.node, layer.children, layer.mask, ctx), mode, opacity);
}

/**
 * Komponiert alle Layer eines Frames zu einem Bild (8 Bit, vormultipliziert, kodiert mit
 * `outputSpace`).
 *
 * Reihenfolge je `group`: Kinder in einen Offscreen komponieren → `effects` → `crop` →
 * Maske → Transform (`localMatrix(node)`, mit `scale`) → `opacity` → `blendMode` auf das Ziel.
 *
 * @example
 * ```ts
 * const frame = compositeFrame({
 *   width: 1920, height: 1080, scale: 1, background: '#000000',
 *   workingSpace: 'linear', layers: [{ kind: 'image', image: skiaLayer }],
 *   frame: 0, seed: 1,
 * });
 * ```
 */
export function compositeFrame(input: CompositeInput): RgbaImage {
  const { width, height } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw inputError(`Output size ${String(width)}x${String(height)} is invalid.`, 'Use positive integer width and height.');
  }
  if (!(input.scale > 0) || !Number.isFinite(input.scale)) throw inputError(`Scale ${String(input.scale)} is invalid.`, 'Use a finite scale > 0, e.g. 1 or 0.5.');
  const ctx: Ctx = {
    width,
    height,
    space: input.workingSpace,
    scale: input.scale,
    frame: input.frame,
    seed: input.seed,
    ...(input.resolveLut !== undefined ? { resolveLut: input.resolveLut } : {}),
    ...(input.effects !== undefined ? { effects: input.effects } : {}),
  };
  const target = createFloatImage(width, height);
  const bg = parseColor(input.background);
  if (bg.a > 0) {
    const r = encodeTransfer(srgbToLinear(bg.r), ctx.space) * bg.a;
    const g = encodeTransfer(srgbToLinear(bg.g), ctx.space) * bg.a;
    const b = encodeTransfer(srgbToLinear(bg.b), ctx.space) * bg.a;
    const d = target.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = bg.a;
    }
  }
  for (const layer of input.layers) compositeLayer(target, layer, ctx);
  return floatToRgba(target, ctx.space, input.outputSpace ?? 'srgb');
}

/**
 * Mittelt mehrere Teilbilder (Motion Blur) im linearen, vormultiplizierten Raum.
 * Eingabe und Ausgabe: 8 Bit, sRGB-kodiert, vormultipliziert.
 *
 * @example
 * ```ts
 * const blurred = accumulateFrames([sub0, sub1, sub2, sub3]);
 * ```
 */
export function accumulateFrames(images: readonly RgbaImage[]): RgbaImage {
  const first = images[0];
  if (first === undefined) throw inputError('accumulateFrames needs at least one image.', 'Pass the sub-frame images of one output frame.');
  const sum = createFloatImage(first.width, first.height);
  for (const img of images) {
    if (img.width !== first.width || img.height !== first.height) {
      throw inputError(`Sub-frame is ${String(img.width)}x${String(img.height)}, expected ${String(first.width)}x${String(first.height)}.`, 'Render all motion-blur sub-frames at the same size.');
    }
    const f = rgbaToFloat(img, 'linear').data;
    const s = sum.data;
    for (let i = 0; i < s.length; i++) s[i] = (s[i] ?? 0) + (f[i] ?? 0);
  }
  const k = 1 / images.length;
  const s = sum.data;
  for (let i = 0; i < s.length; i++) s[i] = (s[i] ?? 0) * k;
  return floatToRgba(sum, 'linear', 'srgb');
}

