/**
 * Typsichere Lesezugriffe auf ausgewertete Properties mit dokumentierten Standardwerten.
 * Alle Renderer nutzen dieselben Standardwerte (keine versteckte Magie).
 */
import type { EvaluatedNode } from './contracts.js';
import { nodeMatrix, type Matrix2D } from './matrix.js';
import { isRecord } from './guards.js';
import { pointAtProgress } from './path.js';

/** Liest eine Zahl oder den Standardwert. */
export function getNumber(node: EvaluatedNode, key: string, fallback: number): number {
  const v = node.props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Liest eine optionale Zahl. */
export function getOptionalNumber(node: EvaluatedNode, key: string): number | undefined {
  const v = node.props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Liest einen Text oder den Standardwert. */
export function getString(node: EvaluatedNode, key: string, fallback: string): string {
  const v = node.props[key];
  return typeof v === 'string' ? v : fallback;
}

/** Liest einen optionalen Text. */
export function getOptionalString(node: EvaluatedNode, key: string): string | undefined {
  const v = node.props[key];
  return typeof v === 'string' ? v : undefined;
}

/** Liest einen Wahrheitswert. */
export function getBoolean(node: EvaluatedNode, key: string, fallback: boolean): boolean {
  const v = node.props[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Liest einen 2D-Vektor `{ x, y }`. */
export function getVec2(node: EvaluatedNode, key: string, fallback: { x: number; y: number }): { x: number; y: number } {
  const v = node.props[key];
  if (!isRecord(v)) return fallback;
  const x = v['x'];
  const y = v['y'];
  return { x: typeof x === 'number' ? x : fallback.x, y: typeof y === 'number' ? y : fallback.y };
}

/** Liest einen 3D-Vektor `[x, y, z]`. */
export function getVec3(node: EvaluatedNode, key: string, fallback: readonly [number, number, number]): [number, number, number] {
  const v = node.props[key];
  if (!Array.isArray(v) || v.length !== 3) return [...fallback];
  const items: readonly unknown[] = v;
  const [x, y, z] = items;
  return [typeof x === 'number' ? x : fallback[0], typeof y === 'number' ? y : fallback[1], typeof z === 'number' ? z : fallback[2]];
}

/** Liest eine Liste von Punkten `[x, y][]`. */
export function getPoints(node: EvaluatedNode, key: string): [number, number][] {
  const v = node.props[key];
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') out.push([p[0], p[1]]);
  }
  return out;
}

/** Transform-Werte einer 2D-Node mit Standardwerten (AD-4). */
export interface Transform2D {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: { readonly x: number; readonly y: number };
  readonly skew: { readonly x: number; readonly y: number };
  readonly origin: { readonly x: number; readonly y: number };
  readonly opacity: number;
}

/**
 * Liest Transform und Opacity einer Node. Standard: Ursprung in der Mitte der Box.
 * Ein Bewegungspfad (`motionPath`) addiert seinen Punkt zu `x`/`y`; mit `autoRotate` auch den Winkel.
 */
export function getTransform(node: EvaluatedNode): Transform2D {
  const motion = node.props['motionPath'];
  let mx = 0;
  let my = 0;
  let mr = 0;
  if (isRecord(motion) && typeof motion['d'] === 'string') {
    const p = pointAtProgress(motion['d'], typeof motion['progress'] === 'number' ? motion['progress'] : 0);
    mx = p.x;
    my = p.y;
    if (motion['autoRotate'] === true) mr = p.angle;
  }
  return {
    x: getNumber(node, 'x', 0) + mx,
    y: getNumber(node, 'y', 0) + my,
    rotation: getNumber(node, 'rotation', 0) + mr,
    scale: getVec2(node, 'scale', { x: 1, y: 1 }),
    skew: getVec2(node, 'skew', { x: 0, y: 0 }),
    origin: getVec2(node, 'origin', { x: 0.5, y: 0.5 }),
    opacity: Math.min(Math.max(getNumber(node, 'opacity', 1), 0), 1),
  };
}

/** Box einer Node in lokalen Koordinaten für Transform-Ursprung und Bounds. */
export function localBox(node: EvaluatedNode, measured?: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  switch (node.type) {
    case 'line': {
      const a = getVec2(node, 'from', { x: 0, y: 0 });
      const b = getVec2(node, 'to', { x: 0, y: 0 });
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    }
    case 'polyline':
    case 'polygon': {
      const pts = getPoints(node, 'points');
      if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case 'path':
      return pathBounds(getString(node, 'd', ''));
    case 'text':
    case 'rich-text':
      return { x: 0, y: 0, width: measured?.width ?? getNumber(node, 'width', 0), height: measured?.height ?? 0 };
    default:
      return { x: 0, y: 0, width: getNumber(node, 'width', measured?.width ?? 0), height: getNumber(node, 'height', measured?.height ?? 0) };
  }
}

/** Grobe Hülle eines SVG-Pfads über alle Koordinaten (inklusive Kontrollpunkte). */
export function pathBounds(d: string): { x: number; y: number; width: number; height: number } {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/gu) ?? [];
  let cmd = 'M';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const nums: number[] = [];
  const flush = (): void => {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const take = (n: number) => nums.splice(0, n);
    while (nums.length > 0) {
      if (C === 'H') {
        const [x = 0] = take(1);
        cx = rel ? cx + x : x;
      } else if (C === 'V') {
        const [y = 0] = take(1);
        cy = rel ? cy + y : y;
      } else if (C === 'A') {
        const a = take(7);
        const x = a[5] ?? 0;
        const y = a[6] ?? 0;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
      } else {
        const count = C === 'C' ? 6 : C === 'S' || C === 'Q' ? 4 : 2;
        const a = take(count);
        for (let i = 0; i + 1 < a.length; i += 2) {
          const px = rel ? cx + (a[i] ?? 0) : (a[i] ?? 0);
          const py = rel ? cy + (a[i + 1] ?? 0) : (a[i + 1] ?? 0);
          xs.push(px);
          ys.push(py);
        }
        const x = a[count - 2] ?? 0;
        const y = a[count - 1] ?? 0;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        if (C === 'M') {
          startX = cx;
          startY = cy;
          cmd = rel ? 'l' : 'L';
        }
      }
      xs.push(cx);
      ys.push(cy);
    }
  };
  for (const t of tokens) {
    if (/^[A-Za-z]$/u.test(t)) {
      flush();
      cmd = t;
      if (t === 'Z' || t === 'z') {
        cx = startX;
        cy = startY;
      }
    } else {
      nums.push(Number(t));
    }
  }
  flush();
  if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Lokale Matrix einer 2D-Node (inklusive Bewegungspfad-Position nicht; siehe Renderer). */
export function localMatrix(node: EvaluatedNode, measured?: { width: number; height: number }): Matrix2D {
  const box = localBox(node, measured);
  return nodeMatrix(getTransform(node), box);
}
