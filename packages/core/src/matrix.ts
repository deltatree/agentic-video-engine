/**
 * 2D-Affine Matrizen für Transformationen (AD-4).
 *
 * Darstellung `[a, b, c, d, e, f]` wie in Canvas/SVG:
 * x' = a·x + c·y + e, y' = b·x + d·y + f.
 */

/** Affine 2D-Matrix `[a, b, c, d, e, f]`. */
export type Matrix2D = readonly [number, number, number, number, number, number];

/** Achsenparalleles Rechteck. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];

/** Multipliziert zwei Matrizen: Ergebnis wendet zuerst `n`, dann `m` an. */
export function multiply(m: Matrix2D, n: Matrix2D): Matrix2D {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translate(x: number, y: number): Matrix2D {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx: number, sy: number): Matrix2D {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotation in Grad (im Uhrzeigersinn bei y nach unten). */
export function rotate(degrees: number): Matrix2D {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

/** Scherung in Grad. */
export function skew(xDegrees: number, yDegrees: number): Matrix2D {
  return [1, Math.tan((yDegrees * Math.PI) / 180), Math.tan((xDegrees * Math.PI) / 180), 1, 0, 0];
}

/** Invertiert eine Matrix; liefert `undefined`, wenn sie singulär ist. */
export function invert(m: Matrix2D): Matrix2D | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return undefined;
  const inv = 1 / det;
  return [m[3] * inv, -m[1] * inv, -m[2] * inv, m[0] * inv, (m[2] * m[5] - m[3] * m[4]) * inv, (m[1] * m[4] - m[0] * m[5]) * inv];
}

/** Wendet eine Matrix auf einen Punkt an. */
export function applyToPoint(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Achsenparallele Hülle eines transformierten Rechtecks. */
export function transformRect(m: Matrix2D, r: Rect): Rect {
  const pts = [applyToPoint(m, r.x, r.y), applyToPoint(m, r.x + r.width, r.y), applyToPoint(m, r.x, r.y + r.height), applyToPoint(m, r.x + r.width, r.y + r.height)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Vereinigt zwei Rechtecke. */
export function unionRect(a: Rect | undefined, b: Rect): Rect {
  if (a === undefined) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * Lokale Matrix einer Node nach CSS-Logik: verschieben auf (x, y), dann um `origin`
 * (relativ zur Box) rotieren, scheren und skalieren.
 *
 * @example
 * ```ts
 * nodeMatrix({ x: 100, y: 50, rotation: 90, scale: { x: 1, y: 1 }, origin: { x: 0.5, y: 0.5 } }, { width: 20, height: 10 });
 * ```
 */
export function nodeMatrix(
  t: { readonly x: number; readonly y: number; readonly rotation: number; readonly scale: { readonly x: number; readonly y: number }; readonly skew: { readonly x: number; readonly y: number }; readonly origin: { readonly x: number; readonly y: number } },
  box: { readonly x?: number; readonly y?: number; readonly width: number; readonly height: number },
): Matrix2D {
  const ox = (box.x ?? 0) + t.origin.x * box.width;
  const oy = (box.y ?? 0) + t.origin.y * box.height;
  let m = translate(t.x + ox, t.y + oy);
  if (t.rotation !== 0) m = multiply(m, rotate(t.rotation));
  if (t.skew.x !== 0 || t.skew.y !== 0) m = multiply(m, skew(t.skew.x, t.skew.y));
  if (t.scale.x !== 1 || t.scale.y !== 1) m = multiply(m, scale(t.scale.x, t.scale.y));
  return multiply(m, translate(-ox, -oy));
}
