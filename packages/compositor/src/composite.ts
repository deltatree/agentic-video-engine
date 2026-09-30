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
  IDENTITY,
  invert,
  isRecord,
  localBox,
  localMatrix,
  revealShape,
  multiply,
  OpenVideoError,
  parseColor,
  scale as scaleMatrix,
  type BlendMode,
  type EffectDefinition,
  type EvaluatedNode,
  type ColorSpace,
  type Matrix2D,
  type Rect,
  type Reveal,
  type RgbaImage,
} from '@agentic-video/core';
import { blendPixel, separableChannel } from './blend.js';
import { assertImage, clamp01, convertFloatInPlace, createFloatImage, decodeTable, encodeTransfer, flattenImageLayers, floatToRgba, rgbaToFloat, srgbToLinear, type FloatImage } from './color.js';
import { applyEffectsLinear, effectsReach, nonZeroBounds, type EffectContext } from './effects.js';
import { applyNodeFilters, hasNodeFilters } from './filters.js';
import { EMPTY, FULL, acquireFloat, intersect, isEmpty, releaseFloat, union, type Region } from './region.js';
import type { Lut } from './lut.js';

/** Maske eines Gruppen-Knotens: ein Bild in Ausgabegröße im lokalen Raum der Gruppe. */
export interface CompositorMask {
  readonly image: RgbaImage;
  readonly mode: 'alpha' | 'luminance';
  readonly invert: boolean;
}

/** Aufdeck-Clip (Wipe, Iris) mit der lokalen Box der Node in Composition-Einheiten. */
export interface CompositorReveal {
  readonly reveal: Reveal;
  readonly box: Rect;
}

/**
 * Knoten des Compositor-Baums. `image` ist ein fertig gerenderter Layer in Ausgabegröße.
 *
 * - `group` komponiert seine Kinder und wendet Farbraum, Effekte, Crop, Clip, Maske, Reveal,
 *   Transform, Opacity und Blend Mode der Node an. Maske und Reveal liegen im lokalen Raum der Gruppe.
 *   Zwischen Maske und Reveal wirken `filters` und `shadow` der Node (Story 17.11).
 * - `isolate` komponiert seine Kinder (die Node, vom Backend schon transformiert und mit Opacity)
 *   und wendet nur Reveal, Maske und Blend Mode an. `matrix` bildet lokale Pixel (lokale
 *   Koordinaten × `scale`) auf Ausgabepixel ab; damit folgen Maske und Reveal der Node.
 *   Mit `applyFilters: true` (Backend ohne eigene Filter, z. B. `scene3d`, `blender`) wendet der
 *   Compositor auch `filters` und `shadow` an: nach der Maske, vor dem Reveal, mit der Node-Matrix skaliert.
 */
export type CompositorNode =
  | { readonly kind: 'image'; readonly image: RgbaImage }
  | {
      readonly kind: 'group';
      readonly node: EvaluatedNode;
      readonly children: readonly CompositorNode[];
      readonly mask?: CompositorMask;
      readonly reveal?: CompositorReveal;
    }
  | {
      readonly kind: 'isolate';
      readonly node: EvaluatedNode;
      readonly children: readonly CompositorNode[];
      readonly matrix: Matrix2D;
      readonly mask?: CompositorMask;
      readonly reveal?: CompositorReveal;
      /** `filters` und `shadow` der Node im Compositor anwenden (das Backend zeichnet sie nicht). */
      readonly applyFilters?: boolean;
    };

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
  /** Transferfunktion der Ausgabe. Standard `srgb`; `linear` schreibt lineares Licht in 8 Bit. */
  readonly outputSpace?: ColorSpace;
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
 * Zwischenbild mit Inhalts-Region (Story 18.1): außerhalb von `region` sind alle Kanäle 0.
 * `image` gehört dem Compositor und geht nach Gebrauch mit {@link releaseFloat} zurück in den Pool.
 */
interface Buf {
  readonly image: FloatImage;
  region: Region;
}

function acquire(ctx: Ctx): Buf {
  return { image: acquireFloat(ctx.width, ctx.height), region: EMPTY };
}

function release(buf: Buf): void {
  releaseFloat(buf.image, buf.region);
}

/** Region aus einem Nicht-null-Scan (nach Effekten oder Filtern, die Inhalt verschieben oder erzeugen). */
function scannedRegion(image: FloatImage): Region {
  const b = nonZeroBounds(image.data, image.width, image.height);
  return b === undefined ? EMPTY : { x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 };
}

/** Region um `by` Pixel erweitert und auf das Bild begrenzt. */
function grow(r: Region, by: number, ctx: Ctx): Region {
  if (isEmpty(r)) return EMPTY;
  return intersect({ x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by }, FULL(ctx.width, ctx.height));
}

/**
 * Mischt ein 8-Bit-Bild (sRGB, vormultipliziert) mit `normal` direkt in das Float-Ziel.
 * Die Umrechnung in den Arbeitsraum läuft über eine Tabelle; kein Zwischenpuffer.
 * Nebenbei wird die Region der Pixel mit Alpha > 0 bestimmt und zur Ziel-Region hinzugefügt.
 */
function blendRgbaNormal(target: Buf, image: RgbaImage, space: Space): void {
  const t = target.image.data;
  const s = image.data;
  const w = image.width;
  const table = decodeTable(space);
  const k = 1 / 255;
  // Ganz transparente Pixel (alle vier Bytes 0) mit einem Vergleich überspringen.
  const words = s.byteOffset % 4 === 0 ? new Uint32Array(s.buffer, s.byteOffset, s.length >> 2) : undefined;
  let minX = w;
  let maxX = -1;
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    let first = -1;
    let last = -1;
    const rowPixel = y * w;
    for (let x = 0; x < w; x++) {
      const p = rowPixel + x;
      if (words !== undefined && words[p] === 0) continue;
      const i = p * 4;
      const a8 = s[i + 3] ?? 0;
      if (a8 === 0) continue;
      if (first < 0) first = x;
      last = x;
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
    if (first < 0) continue;
    if (minY < 0) minY = y;
    maxY = y;
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
  }
  if (maxX >= 0) target.region = union(target.region, { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 });
}

/** Mischt `source` mit Deckkraft `opacity` und Blend Mode `mode` in `target` (beide vormultipliziert), nur in der Quell-Region. */
function blendInto(target: Buf, source: Buf, mode: BlendMode, opacity: number): void {
  const t = target.image.data;
  const s = source.image.data;
  const op = clamp01(opacity);
  if (op === 0 || isEmpty(source.region)) return;
  const channel = separableChannel(mode);
  const w = source.image.width;
  const { x0, y0, x1, y1 } = source.region;
  for (let y = y0; y < y1; y++) {
    const end = (y * w + x1) * 4;
    for (let i = (y * w + x0) * 4; i < end; i += 4) {
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
  target.region = union(target.region, source.region);
}

/**
 * Setzt alle Pixel außerhalb des Crop-Rechtecks (lokale Koordinaten × scale) auf transparent.
 * Nur die belegte Region wird angefasst, zeilenweise mit `fill` statt je Pixel.
 */
function applyCrop(buf: Buf, crop: Readonly<Record<string, unknown>>, scale: number): void {
  const { width: w, height: h, data: d } = buf.image;
  const n = (k: string, f: number): number => {
    const v = crop[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : f;
  };
  const x0 = Math.round(n('x', 0) * scale);
  const y0 = Math.round(n('y', 0) * scale);
  const x1 = Math.round((n('x', 0) + n('width', w / scale)) * scale);
  const y1 = Math.round((n('y', 0) + n('height', h / scale)) * scale);
  const r = buf.region;
  if (isEmpty(r)) return;
  const keep = intersect(r, { x0, y0, x1, y1 });
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * w;
    if (isEmpty(keep) || y < keep.y0 || y >= keep.y1) {
      d.fill(0, (row + r.x0) * 4, (row + r.x1) * 4);
      continue;
    }
    if (keep.x0 > r.x0) d.fill(0, (row + r.x0) * 4, (row + keep.x0) * 4);
    if (keep.x1 < r.x1) d.fill(0, (row + keep.x1) * 4, (row + r.x1) * 4);
  }
  buf.region = keep;
}

/** Maskenwert eines Pixels (0..1) aus vormultiplizierten, sRGB-kodierten Werten 0..255. */
function maskValue(mode: CompositorMask['mode'], r: number, g: number, b: number, a: number, inverted: boolean): number {
  const v = mode === 'alpha' ? a / 255 : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return inverted ? 1 - v : v;
}

/**
 * Multipliziert das Bild mit der Maske. `alpha`: Maskenwert = Alpha;
 * `luminance`: Rec.-709-Luma der sRGB-kodierten, vormultiplizierten Werte (= Helligkeit × Alpha).
 * `invert` nutzt `1 − Maskenwert`. Mit `matrix` (lokale Pixel → Ausgabepixel) wird die Maske
 * mit der Node transformiert (bilinear, außerhalb transparent). Gerechnet wird nur in der
 * Region des Bildes; die transformierte Maske wird dort je Pixel abgetastet (gleiche Rechnung
 * und Float32-Rundung wie eine vorab transformierte Maske, ohne Vollbild-Zwischenpuffer).
 */
function applyMask(buf: Buf, mask: CompositorMask, matrix?: Matrix2D): void {
  const d = buf.image.data;
  const w = buf.image.width;
  const { x0, y0, x1, y1 } = buf.region;
  const m = mask.image.data;
  if (matrix !== undefined && !isIdentity(matrix)) {
    const inv = invert(matrix);
    const mw = mask.image.width;
    const mh = mask.image.height;
    const alphaOnly = mask.mode === 'alpha';
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x < x1; x++) {
        const px = x + 0.5;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        if (inv !== undefined) {
          const sx = inv[0] * px + inv[2] * py + inv[4] - 0.5;
          const sy = inv[1] * px + inv[3] * py + inv[5] - 0.5;
          if (!(sx <= -1 || sy <= -1 || sx >= mw || sy >= mh)) {
            const mx0 = Math.floor(sx);
            const my0 = Math.floor(sy);
            const tx = sx - mx0;
            const ty = sy - my0;
            const w00 = (1 - tx) * (1 - ty);
            const w10 = tx * (1 - ty);
            const w01 = (1 - tx) * ty;
            const w11 = tx * ty;
            const in0 = my0 >= 0;
            const in1 = my0 + 1 < mh;
            const l0 = mx0 >= 0;
            const l1 = mx0 + 1 < mw;
            const o00 = (my0 * mw + mx0) * 4;
            const o01 = ((my0 + 1) * mw + mx0) * 4;
            const sample = (c: number): number => {
              let v = 0;
              if (in0 && l0) v += (m[o00 + c] ?? 0) * w00;
              if (in0 && l1) v += (m[o00 + 4 + c] ?? 0) * w10;
              if (in1 && l0) v += (m[o01 + c] ?? 0) * w01;
              if (in1 && l1) v += (m[o01 + 4 + c] ?? 0) * w11;
              return Math.fround(v);
            };
            a = sample(3);
            if (!alphaOnly) {
              r = sample(0);
              g = sample(1);
              b = sample(2);
            }
          }
        }
        const v = maskValue(mask.mode, r, g, b, a, mask.invert);
        if (v === 1) continue;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) d[i + c] = (d[i + c] ?? 0) * v;
      }
    }
    return;
  }
  for (let y = y0; y < y1; y++) {
    const end = (y * w + x1) * 4;
    for (let i = (y * w + x0) * 4; i < end; i += 4) {
      const v = maskValue(mask.mode, m[i] ?? 0, m[i + 1] ?? 0, m[i + 2] ?? 0, m[i + 3] ?? 0, mask.invert);
      if (v === 1) continue;
      d[i] = (d[i] ?? 0) * v;
      d[i + 1] = (d[i + 1] ?? 0) * v;
      d[i + 2] = (d[i + 2] ?? 0) * v;
      d[i + 3] = (d[i + 3] ?? 0) * v;
    }
  }
}

/**
 * Beschneidet das Bild auf den Aufdeck-Clip. Jede Pixelmitte wird über `matrix`⁻¹ und `1/scale`
 * in lokale Koordinaten abgebildet; Kantenpixel werden mit 4 × 4 Stichproben geglättet
 * (Rechteck und Ellipse sind konvex: liegen alle vier Ecken innen, ist das Pixel ganz innen).
 */
function applyReveal(buf: Buf, reveal: CompositorReveal, matrix: Matrix2D, scale: number): void {
  const inv = invert(matrix);
  const d = buf.image.data;
  const w = buf.image.width;
  const { x0, y0, x1, y1 } = buf.region;
  if (inv === undefined) {
    for (let y = y0; y < y1; y++) d.fill(0, (y * w + x0) * 4, (y * w + x1) * 4);
    buf.region = EMPTY;
    return;
  }
  const r = revealShape(reveal.reveal, reveal.box);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const rx = r.width / 2;
  const ry = r.height / 2;
  const inside = (px: number, py: number): boolean => {
    const lx = (inv[0] * px + inv[2] * py + inv[4]) / scale;
    const ly = (inv[1] * px + inv[3] * py + inv[5]) / scale;
    if (r.shape === 'rect') return lx >= r.x && lx <= r.x + r.width && ly >= r.y && ly <= r.y + r.height;
    if (!(rx > 0 && ry > 0)) return false;
    const nx = (lx - cx) / rx;
    const ny = (ly - cy) / ry;
    return nx * nx + ny * ny <= 1;
  };
  const n = 4;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 4;
      if ((d[o + 3] ?? 0) === 0) continue;
      const corners = (inside(x, y) ? 1 : 0) + (inside(x + 1, y) ? 1 : 0) + (inside(x, y + 1) ? 1 : 0) + (inside(x + 1, y + 1) ? 1 : 0);
      if (corners === 4) continue;
      let hits = 0;
      for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) if (inside(x + (sx + 0.5) / n, y + (sy + 0.5) / n)) hits++;
      const v = hits / (n * n);
      for (let c = 0; c < 4; c++) d[o + c] = (d[o + c] ?? 0) * v;
    }
  }
}

/** Liest `colorSpace` einer Node (nur gültige Werte). */
function colorSpaceOf(node: EvaluatedNode): ColorSpace | undefined {
  const v = node.props['colorSpace'];
  return v === 'srgb' || v === 'linear' || v === 'rec709' ? v : undefined;
}

function isIdentity(m: Matrix2D): boolean {
  const e = 1e-9;
  return Math.abs(m[0] - 1) < e && Math.abs(m[1]) < e && Math.abs(m[2]) < e && Math.abs(m[3] - 1) < e && Math.abs(m[4]) < e && Math.abs(m[5]) < e;
}

/**
 * Zielbereich einer Transformation: die mit `m` abgebildete Quell-Region (Abtastpunkte bis ein
 * halbes Pixel außerhalb tragen über die bilineare Interpolation noch bei), plus ein Pixel Rand
 * gegen Rundung, begrenzt auf das Bild.
 */
function transformedRegion(r: Region, m: Matrix2D, w: number, h: number): Region {
  if (isEmpty(r)) return EMPTY;
  const xs = [r.x0 - 0.5, r.x1 + 0.5];
  const ys = [r.y0 - 0.5, r.y1 + 0.5];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const px = m[0] * x + m[2] * y + m[4];
      const py = m[1] * x + m[3] * y + m[5];
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return FULL(w, h);
  return intersect({ x0: Math.floor(minX) - 1, y0: Math.floor(minY) - 1, x1: Math.ceil(maxX) + 2, y1: Math.ceil(maxY) + 2 }, FULL(w, h));
}

/**
 * Transformiert ein Bild mit der Matrix `m` (Pixel → Pixel). Rückwärtsabbildung der
 * Pixelmitten, bilineare Interpolation, außerhalb transparent. Gerechnet wird nur im
 * Zielbereich der Quell-Region; die Quelle geht zurück in den Pool.
 */
function transformImage(buf: Buf, m: Matrix2D, ctx: Ctx): Buf {
  const { width: w, height: h, data: src } = buf.image;
  const out = acquire(ctx);
  const inv = invert(m);
  if (inv === undefined) {
    release(buf);
    return out;
  }
  const region = transformedRegion(buf.region, m, w, h);
  const d = out.image.data;
  for (let y = region.y0; y < region.y1; y++) {
    const py = y + 0.5;
    for (let x = region.x0; x < region.x1; x++) {
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
  out.region = region;
  release(buf);
  return out;
}

function composeChildren(children: readonly CompositorNode[], ctx: Ctx): Buf {
  const off = acquire(ctx);
  for (const child of children) compositeLayer(off, child, ctx);
  return off;
}

/**
 * Übernimmt das Ergebnis eines Schritts, der ein neues Bild liefern kann (Effekte, Filter):
 * Ist es ein anderes Bild, geht das alte zurück in den Pool.
 */
function adopt(buf: Buf, image: FloatImage, region: (image: FloatImage) => Region): Buf {
  if (image === buf.image) {
    buf.region = region(image);
    return buf;
  }
  release(buf);
  return { image, region: region(image) };
}

function applyFiltersTo(buf: Buf, props: Readonly<Record<string, unknown>>, ctx: Ctx, toPixels: Matrix2D): Buf {
  if (!hasNodeFilters(props)) return buf;
  // Filter und Schatten verschieben Inhalt oder erzeugen neuen: Region neu bestimmen.
  return adopt(buf, applyNodeFilters(buf.image, props, ctx.space, toPixels), scannedRegion);
}

function renderGroup(node: EvaluatedNode, children: readonly CompositorNode[], mask: CompositorMask | undefined, reveal: CompositorReveal | undefined, ctx: Ctx): Buf {
  let off = composeChildren(children, ctx);
  // Farbraum des Layers: Die Kinder liefern Werte mit der Kodierung `colorSpace`; sie werden
  // statt als sRGB mit dieser Kodierung gelesen und in den Arbeitsraum überführt.
  const layerSpace = node.type === 'layer' ? colorSpaceOf(node) : undefined;
  if (layerSpace !== undefined && layerSpace !== 'srgb') {
    convertFloatInPlace(off.image, ctx.space, 'srgb', off.region);
    convertFloatInPlace(off.image, layerSpace, ctx.space, off.region);
  }
  const effects = node.props['effects'];
  if (Array.isArray(effects) && effects.length > 0) {
    const list: readonly unknown[] = effects;
    const before = off.region;
    convertFloatInPlace(off.image, ctx.space, 'linear', before);
    const reach = effectsReach(list, ctx.scale);
    off = adopt(off, applyEffectsLinear(off.image, list, ctx, before), (image) => (reach === undefined ? scannedRegion(image) : grow(before, reach, ctx)));
    convertFloatInPlace(off.image, 'linear', ctx.space, off.region);
  }
  const crop = node.props['crop'];
  if (isRecord(crop)) applyCrop(off, crop, ctx.scale);
  if (node.props['clip'] === true) {
    const box = localBox(node);
    applyCrop(off, { x: box.x, y: box.y, width: box.width, height: box.height }, ctx.scale);
  }
  if (mask !== undefined) {
    assertLayerSize(mask.image, ctx, `Mask of group "${node.id}"`);
    applyMask(off, mask);
  }
  off = applyFiltersTo(off, node.props, ctx, [ctx.scale, 0, 0, ctx.scale, 0, 0]);
  if (reveal !== undefined) applyReveal(off, reveal, IDENTITY, ctx.scale);
  const s = ctx.scale;
  const m = multiply(scaleMatrix(s, s), multiply(localMatrix(node), scaleMatrix(1 / s, 1 / s)));
  return isIdentity(m) ? off : transformImage(off, m, ctx);
}

function renderIsolated(layer: Extract<CompositorNode, { kind: 'isolate' }>, ctx: Ctx): Buf {
  let off = composeChildren(layer.children, ctx);
  if (layer.applyFilters === true) {
    // Reihenfolge wie im Skia-Backend: Maske → Filter/Schatten → Reveal-Clip.
    if (layer.mask !== undefined) {
      assertLayerSize(layer.mask.image, ctx, `Mask of node "${layer.node.id}"`);
      applyMask(off, layer.mask, layer.matrix);
    }
    const m = layer.matrix;
    const s = ctx.scale;
    off = applyFiltersTo(off, layer.node.props, ctx, [m[0] * s, m[1] * s, m[2] * s, m[3] * s, 0, 0]);
    if (layer.reveal !== undefined) applyReveal(off, layer.reveal, layer.matrix, ctx.scale);
    return off;
  }
  if (layer.reveal !== undefined) applyReveal(off, layer.reveal, layer.matrix, ctx.scale);
  if (layer.mask !== undefined) {
    assertLayerSize(layer.mask.image, ctx, `Mask of node "${layer.node.id}"`);
    applyMask(off, layer.mask, layer.matrix);
  }
  return off;
}

function compositeLayer(target: Buf, layer: CompositorNode, ctx: Ctx): void {
  if (layer.kind === 'image') {
    assertLayerSize(layer.image, ctx, 'Layer image');
    blendRgbaNormal(target, layer.image, ctx.space);
    return;
  }
  const mode = blendModeOf(layer.node);
  if (layer.kind === 'isolate') {
    // Opacity hat das Backend schon angewendet.
    const off = renderIsolated(layer, ctx);
    blendInto(target, off, mode, 1);
    release(off);
    return;
  }
  const opacity = getTransform(layer.node).opacity;
  if (opacity <= 0) return;
  const off = renderGroup(layer.node, layer.children, layer.mask, layer.reveal, ctx);
  blendInto(target, off, mode, opacity);
  release(off);
}

/**
 * Komponiert alle Layer eines Frames zu einem Bild (8 Bit, vormultipliziert, kodiert mit
 * `outputSpace`).
 *
 * Reihenfolge je `group`: Kinder in einen Offscreen komponieren → `colorSpace` (nur `layer`) →
 * `effects` → `crop` → `clip` → Maske → `filters` → `shadow` → Reveal → Transform
 * (`localMatrix(node)`, mit `scale`) → `opacity` → `blendMode` auf das Ziel. Je `isolate`:
 * Kinder komponieren → Reveal → Maske → `blendMode` auf das Ziel; mit `applyFilters`
 * Maske → `filters` → `shadow` → Reveal.
 *
 * Leistung (Story 18.1): Jedes Zwischenbild trägt die Region, außerhalb derer es leer ist;
 * alle Schritte rechnen nur darin. Offscreens kommen aus einem kleinen Pool. Das Ergebnis ist
 * bitgleich zur Rechnung über alle Pixel.
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
  const bg = parseColor(input.background);
  const images: RgbaImage[] = [];
  for (const layer of input.layers) if (layer.kind === 'image') images.push(layer.image);
  if (images.length === input.layers.length) {
    // Häufigster Fall (nur Backend-Layer, keine Gruppen): ein Durchlauf ohne Float-Zwischenbild.
    for (const image of images) assertLayerSize(image, ctx, 'Layer image');
    const background: [number, number, number, number] =
      bg.a > 0
        ? [
            Math.fround(encodeTransfer(srgbToLinear(bg.r), ctx.space) * bg.a),
            Math.fround(encodeTransfer(srgbToLinear(bg.g), ctx.space) * bg.a),
            Math.fround(encodeTransfer(srgbToLinear(bg.b), ctx.space) * bg.a),
            Math.fround(bg.a),
          ]
        : [0, 0, 0, 0];
    return flattenImageLayers(images, background, ctx.space, input.outputSpace ?? 'srgb', width, height);
  }
  const target = acquire(ctx);
  if (bg.a > 0) {
    const r = encodeTransfer(srgbToLinear(bg.r), ctx.space) * bg.a;
    const g = encodeTransfer(srgbToLinear(bg.g), ctx.space) * bg.a;
    const b = encodeTransfer(srgbToLinear(bg.b), ctx.space) * bg.a;
    const d = target.image.data;
    d[0] = r;
    d[1] = g;
    d[2] = b;
    d[3] = bg.a;
    // Muster verdoppeln (memcpy) statt jeden Wert einzeln zu schreiben.
    for (let filled = 4; filled < d.length; filled *= 2) d.copyWithin(filled, 0, Math.min(filled, d.length - filled));
    target.region = FULL(width, height);
  }
  for (const layer of input.layers) compositeLayer(target, layer, ctx);
  const out = floatToRgba(target.image, ctx.space, input.outputSpace ?? 'srgb', target.region);
  release(target);
  return out;
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

