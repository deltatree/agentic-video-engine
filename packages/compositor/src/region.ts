/**
 * Inhalts-Bounds und wiederverwendete Float-Puffer des Compositors (Story 18.1).
 *
 * Ein {@link Region} beschreibt ein Rechteck in Pixeln (`x1`, `y1` exklusiv). Der Compositor hält
 * zu jedem Zwischenbild die Region, außerhalb derer alle Kanäle 0 sind; Transform, Blend, Maske,
 * Crop und Reveal rechnen nur darin. Weil Pixel außerhalb 0 sind und jede dieser Operationen 0
 * auf 0 abbildet (oder überspringt), bleibt das Ergebnis bitgleich zur Rechnung über alle Pixel.
 *
 * Offscreens in Ausgabegröße (4K: 132,7 MB) kommen aus einem kleinen Pool statt aus einer neuen
 * Allokation je Gruppe; beim Zurückgeben wird nur die belegte Region genullt.
 */
import { createFloatImage, type Bounds, type FloatImage } from './color.js';

/** Rechteck in Pixeln; `x1`, `y1` exklusiv. Leer, wenn `x0 >= x1` oder `y0 >= y1`. */
export type Region = Bounds;

/**
 * Die leere Region.
 *
 * @example
 * ```ts
 * isEmpty(EMPTY); // true
 * ```
 */
export const EMPTY: Region = { x0: 0, y0: 0, x1: 0, y1: 0 };

/**
 * Das ganze Bild.
 *
 * @example
 * ```ts
 * const all = FULL(1920, 1080);
 * ```
 */
export function FULL(width: number, height: number): Region {
  return { x0: 0, y0: 0, x1: width, y1: height };
}

/**
 * Ist die Region leer?
 *
 * @example
 * ```ts
 * isEmpty({ x0: 2, y0: 0, x1: 2, y1: 5 }); // true
 * ```
 */
export function isEmpty(r: Region): boolean {
  return r.x0 >= r.x1 || r.y0 >= r.y1;
}

/**
 * Kleinste Region, die beide enthält.
 *
 * @example
 * ```ts
 * union({ x0: 0, y0: 0, x1: 2, y1: 2 }, { x0: 4, y0: 4, x1: 5, y1: 5 }); // { x0: 0, y0: 0, x1: 5, y1: 5 }
 * ```
 */
export function union(a: Region, b: Region): Region {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * Schnitt zweier Regionen (leer, wenn sie sich nicht überlappen).
 *
 * @example
 * ```ts
 * intersect({ x0: 0, y0: 0, x1: 4, y1: 4 }, { x0: 2, y0: 2, x1: 8, y1: 8 }); // { x0: 2, y0: 2, x1: 4, y1: 4 }
 * ```
 */
export function intersect(a: Region, b: Region): Region {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return isEmpty(r) ? EMPTY : r;
}

/** Höchstzahl gehaltener Puffer; mehr als zwei gleichzeitig freie Offscreens braucht ein Frame selten. */
const MAX_POOLED = 2;
const pool: FloatImage[] = [];

/**
 * Holt einen genullten Float-Puffer in der Größe `width` × `height` (aus dem Pool oder neu).
 *
 * @example
 * ```ts
 * const off = acquireFloat(1920, 1080);
 * releaseFloat(off, EMPTY);
 * ```
 */
export function acquireFloat(width: number, height: number): FloatImage {
  for (let i = pool.length - 1; i >= 0; i--) {
    const img = pool[i];
    if (img !== undefined && img.width === width && img.height === height) {
      pool.splice(i, 1);
      return img;
    }
  }
  return createFloatImage(width, height);
}

/**
 * Gibt einen Puffer zurück: nullt die belegte Region und legt ihn in den Pool.
 * Puffer anderer Größe verdrängen den Pool (eine Composition hat eine Ausgabegröße).
 *
 * @example
 * ```ts
 * releaseFloat(off, { x0: 0, y0: 0, x1: 100, y1: 50 });
 * ```
 */
export function releaseFloat(image: FloatImage, used: Region): void {
  const { width: w, data: d } = image;
  if (d.length !== image.width * image.height * 4) return;
  if (!isEmpty(used)) {
    if (used.x0 === 0 && used.x1 === w) d.fill(0, used.y0 * w * 4, used.y1 * w * 4);
    else for (let y = used.y0; y < used.y1; y++) d.fill(0, (y * w + used.x0) * 4, (y * w + used.x1) * 4);
  }
  if (pool.some((p) => p.width !== image.width || p.height !== image.height)) pool.length = 0;
  if (pool.length < MAX_POOLED) pool.push(image);
}
