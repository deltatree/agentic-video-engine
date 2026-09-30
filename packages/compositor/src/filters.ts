/**
 * `filters` und `shadow` einer Node im Compositor (Story 17.11).
 *
 * Gilt für Compositor-Gruppen (hochgestufte `group`, `layer`) und für isolierte Layer, deren
 * Backend die Eigenschaften nicht selbst zeichnet (`scene3d`, `blender`). Die Semantik folgt
 * dem Skia-Backend (Referenz, siehe `docs/reference/node-semantics.md` 1.4): Farbfilter wirken
 * wie CSS auf **nicht vormultiplizierte, sRGB-kodierte** Werte; `blur` ist ein Gauß-Filter
 * (σ = `radius`) auf vormultiplizierten sRGB-Werten; `shadow` zeichnet einen Schlagschatten
 * unter das gefilterte Bild. Längen sind lokale Einheiten und werden mit der Node-Matrix
 * (bzw. der Vorschau-Skalierung) in Pixel umgerechnet.
 */
import { isRecord, parseColor, type ColorSpace, type Matrix2D } from '@agentic-video/core';
import { clamp01, convertFloatInPlace, createFloatImage, type FloatImage } from './color.js';
import { gaussianBlur } from './effects.js';

function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function hueRotateMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0, 0,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * 4×5-Farbmatrix (Zeilen R, G, B, A; Verschiebung in 0..1) eines CSS-Farbfilters, wie im
 * Skia-Backend. `undefined` für `blur` und unbekannte Typen.
 *
 * @example
 * ```ts
 * cssFilterMatrix({ type: 'grayscale', amount: 1 });
 * ```
 */
export function cssFilterMatrix(filter: Readonly<Record<string, unknown>>): number[] | undefined {
  const amount = typeof filter['amount'] === 'number' ? filter['amount'] : 1;
  switch (filter['type']) {
    case 'brightness':
      return [amount, 0, 0, 0, 0, 0, amount, 0, 0, 0, 0, 0, amount, 0, 0, 0, 0, 0, 1, 0];
    case 'contrast': {
      const o = (1 - amount) / 2;
      return [amount, 0, 0, 0, o, 0, amount, 0, 0, o, 0, 0, amount, 0, o, 0, 0, 0, 1, 0];
    }
    case 'saturate':
      return saturateMatrix(amount);
    case 'grayscale':
      return saturateMatrix(1 - clamp01(amount));
    case 'sepia': {
      const k = 1 - clamp01(amount);
      return [
        0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0, 0,
        0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0, 0,
        0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k, 0, 0,
        0, 0, 0, 1, 0,
      ];
    }
    case 'invert': {
      const a = clamp01(amount);
      const d = 1 - 2 * a;
      return [d, 0, 0, 0, a, 0, d, 0, 0, a, 0, 0, d, 0, a, 0, 0, 0, 1, 0];
    }
    case 'hue-rotate':
      return hueRotateMatrix(typeof filter['degrees'] === 'number' ? filter['degrees'] : 0);
    case 'color-matrix': {
      const m = filter['matrix'];
      if (!Array.isArray(m) || m.length !== 20) return undefined;
      return m.map((v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
    }
    default:
      return undefined;
  }
}

/** Wendet eine 4×5-Farbmatrix auf nicht vormultiplizierte Werte an (in place, Ergebnis vormultipliziert). */
function applyMatrix(image: FloatImage, k: readonly number[]): void {
  const d = image.data;
  const m = (i: number): number => k[i] ?? 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    const r = a > 0 ? (d[i] ?? 0) / a : 0;
    const g = a > 0 ? (d[i + 1] ?? 0) / a : 0;
    const b = a > 0 ? (d[i + 2] ?? 0) / a : 0;
    const row = (o: number): number => clamp01(m(o) * r + m(o + 1) * g + m(o + 2) * b + m(o + 3) * a + m(o + 4));
    const na = row(15);
    d[i] = row(0) * na;
    d[i + 1] = row(5) * na;
    d[i + 2] = row(10) * na;
    d[i + 3] = na;
  }
}

/** Verschiebt das Alpha eines Bildes um `(dx, dy)` Pixel (bilinear, außerhalb transparent). */
function shiftedAlpha(image: FloatImage, dx: number, dy: number): FloatImage {
  const { width: w, height: h, data: src } = image;
  const out = createFloatImage(w, h);
  const d = out.data;
  const fx = Math.floor(dx);
  const fy = Math.floor(dy);
  const tx = dx - fx;
  const ty = dy - fy;
  const at = (x: number, y: number): number => (x >= 0 && y >= 0 && x < w && y < h ? (src[(y * w + x) * 4 + 3] ?? 0) : 0);
  for (let y = 0; y < h; y++) {
    const sy = y - fy;
    for (let x = 0; x < w; x++) {
      const sx = x - fx;
      // Ziel (x, y) liest die Quelle bei (x − dx, y − dy).
      const v = at(sx, sy) * (1 - tx) * (1 - ty) + at(sx - 1, sy) * tx * (1 - ty) + at(sx, sy - 1) * (1 - tx) * ty + at(sx - 1, sy - 1) * tx * ty;
      if (v > 0) d[(y * w + x) * 4 + 3] = v;
    }
  }
  return out;
}

/** Legt einen Schlagschatten (Farbe sRGB, vormultipliziert) unter das Bild. */
function applyShadow(image: FloatImage, color: { r: number; g: number; b: number; a: number }, sigma: number, dx: number, dy: number): FloatImage {
  const alpha = gaussianBlur(shiftedAlpha(image, dx, dy), sigma);
  const s = alpha.data;
  const d = image.data;
  const out = createFloatImage(image.width, image.height);
  const o = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const sa = (s[i + 3] ?? 0) * color.a;
    const ca = d[i + 3] ?? 0;
    const inv = 1 - ca;
    o[i] = (d[i] ?? 0) + color.r * sa * inv;
    o[i + 1] = (d[i + 1] ?? 0) + color.g * sa * inv;
    o[i + 2] = (d[i + 2] ?? 0) + color.b * sa * inv;
    o[i + 3] = ca + sa * inv;
  }
  return out;
}

/**
 * Hat die Node wirksame `filters` oder einen `shadow`?
 *
 * @example
 * ```ts
 * hasNodeFilters({ filters: [{ type: 'blur', radius: 2 }] }); // true
 * ```
 */
export function hasNodeFilters(props: Readonly<Record<string, unknown>>): boolean {
  const filters = props['filters'];
  const shadow = props['shadow'];
  return (Array.isArray(filters) && filters.length > 0) || (isRecord(shadow) && typeof shadow['color'] === 'string');
}

/**
 * Wendet `filters` (in Reihenfolge) und danach `shadow` einer Node auf ein Float-Bild im Raum
 * `space` an. `toPixels` bildet einen lokalen Vektor auf Pixel ab (lineare Abbildung ohne
 * Verschiebung, z. B. `[scale, 0, 0, scale, 0, 0]`); Blur-Radien skalieren mit √|det|.
 *
 * @example
 * ```ts
 * const out = applyNodeFilters(image, node.props, 'srgb', [1, 0, 0, 1, 0, 0]);
 * ```
 */
export function applyNodeFilters(image: FloatImage, props: Readonly<Record<string, unknown>>, space: ColorSpace, toPixels: Matrix2D): FloatImage {
  if (!hasNodeFilters(props)) return image;
  const lengthScale = Math.sqrt(Math.abs(toPixels[0] * toPixels[3] - toPixels[1] * toPixels[2]));
  let img = image;
  convertFloatInPlace(img, space, 'srgb');
  const filters = props['filters'];
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (!isRecord(f)) continue;
      if (f['type'] === 'blur') {
        const sigma = typeof f['radius'] === 'number' ? f['radius'] : 0;
        if (sigma > 0) img = gaussianBlur(img, sigma * lengthScale);
        continue;
      }
      const matrix = cssFilterMatrix(f);
      if (matrix !== undefined) applyMatrix(img, matrix);
    }
  }
  const shadow = props['shadow'];
  if (isRecord(shadow) && typeof shadow['color'] === 'string') {
    const n = (k: string): number => {
      const v = shadow[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const ox = n('offsetX');
    const oy = n('offsetY');
    const dx = toPixels[0] * ox + toPixels[2] * oy;
    const dy = toPixels[1] * ox + toPixels[3] * oy;
    img = applyShadow(img, parseColor(shadow['color']), n('blur') * lengthScale, dx, dy);
  }
  convertFloatInPlace(img, 'srgb', space);
  return img;
}
