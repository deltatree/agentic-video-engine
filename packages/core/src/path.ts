/**
 * SVG-Pfadgeometrie: Zerlegen in Polylinien, Länge, Punkt bei Fortschritt.
 * Deterministisch durch feste Unterteilung. Grundlage für Bewegungspfade (motionPath).
 */

/** Ein Punkt. */
export interface Point2 {
  readonly x: number;
  readonly y: number;
}

const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/gu;
const SEGMENTS = 24;

function arcToPoints(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, largeArc: boolean, sweep: boolean, x2: number, y2: number): Point2[] {
  if (rxIn === 0 || ryIn === 0) return [{ x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const out: Point2[] = [];
  for (let i = 1; i <= SEGMENTS; i++) {
    const t = theta1 + (delta * i) / SEGMENTS;
    out.push({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  }
  return out;
}

/**
 * Zerlegt SVG-Pfaddaten in Unterpfade aus Punkten (Kurven fest unterteilt).
 *
 * @example
 * ```ts
 * flattenPath('M0 0 L100 0'); // [[{x:0,y:0},{x:100,y:0}]]
 * ```
 */
export function flattenPath(d: string): Point2[][] {
  const tokens = d.match(TOKEN) ?? [];
  const subpaths: Point2[][] = [];
  let current: Point2[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: Point2 | undefined;
  let lastCmd = '';
  let i = 0;
  let cmd = '';
  const num = (): number => {
    const t = tokens[i++];
    return t === undefined ? 0 : Number(t);
  };
  const hasNumber = (): boolean => {
    const t = tokens[i];
    return t !== undefined && !/^[A-Za-z]$/u.test(t);
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (t !== undefined && /^[A-Za-z]$/u.test(t)) {
      cmd = t;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ax = (v: number) => (rel ? cx + v : v);
    const ay = (v: number) => (rel ? cy + v : v);
    switch (C) {
      case 'M': {
        if (current.length > 0) subpaths.push(current);
        cx = ax(num());
        cy = ay(num());
        sx = cx;
        sy = cy;
        current = [{ x: cx, y: cy }];
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L':
        cx = ax(num());
        cy = ay(num());
        current.push({ x: cx, y: cy });
        break;
      case 'H':
        cx = ax(num());
        current.push({ x: cx, y: cy });
        break;
      case 'V':
        cy = ay(num());
        current.push({ x: cx, y: cy });
        break;
      case 'C':
      case 'S': {
        let c1: Point2;
        if (C === 'C') c1 = { x: ax(num()), y: ay(num()) };
        else c1 = lastCtrl !== undefined && 'CcSs'.includes(lastCmd) ? { x: 2 * cx - lastCtrl.x, y: 2 * cy - lastCtrl.y } : { x: cx, y: cy };
        const c2 = { x: ax(num()), y: ay(num()) };
        const end = { x: ax(num()), y: ay(num()) };
        for (let k = 1; k <= SEGMENTS; k++) {
          const s = k / SEGMENTS;
          const u = 1 - s;
          current.push({
            x: u * u * u * cx + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * end.x,
            y: u * u * u * cy + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * end.y,
          });
        }
        lastCtrl = c2;
        cx = end.x;
        cy = end.y;
        break;
      }
      case 'Q':
      case 'T': {
        const c = C === 'Q' ? { x: ax(num()), y: ay(num()) } : lastCtrl !== undefined && 'QqTt'.includes(lastCmd) ? { x: 2 * cx - lastCtrl.x, y: 2 * cy - lastCtrl.y } : { x: cx, y: cy };
        const end = { x: ax(num()), y: ay(num()) };
        for (let k = 1; k <= SEGMENTS; k++) {
          const s = k / SEGMENTS;
          const u = 1 - s;
          current.push({ x: u * u * cx + 2 * u * s * c.x + s * s * end.x, y: u * u * cy + 2 * u * s * c.y + s * s * end.y });
        }
        lastCtrl = c;
        cx = end.x;
        cy = end.y;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const x = ax(num());
        const y = ay(num());
        current.push(...arcToPoints(cx, cy, rx, ry, rot, large, sweep, x, y));
        cx = x;
        cy = y;
        break;
      }
      case 'Z':
        current.push({ x: sx, y: sy });
        cx = sx;
        cy = sy;
        subpaths.push(current);
        current = [];
        break;
      default:
        i++;
    }
    if (C !== 'C' && C !== 'S' && C !== 'Q' && C !== 'T') lastCtrl = undefined;
    lastCmd = cmd;
    if (C === 'Z' && hasNumber()) cmd = 'L';
  }
  if (current.length > 0) subpaths.push(current);
  return subpaths;
}

/** Länge eines Pfads über alle Unterpfade. */
export function pathLength(d: string): number {
  let total = 0;
  for (const sub of flattenPath(d)) {
    for (let i = 1; i < sub.length; i++) {
      const a = sub[i - 1];
      const b = sub[i];
      if (a !== undefined && b !== undefined) total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return total;
}

/**
 * Punkt und Tangentenwinkel (Grad) bei Fortschritt 0..1 entlang des Pfads.
 *
 * @example
 * ```ts
 * pointAtProgress('M0 0 L100 0', 0.25); // { x: 25, y: 0, angle: 0 }
 * ```
 */
export function pointAtProgress(d: string, progress: number): { x: number; y: number; angle: number } {
  const points = flattenPath(d).flat();
  if (points.length === 0) return { x: 0, y: 0, angle: 0 };
  const lengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    lengths.push((lengths[i - 1] ?? 0) + (a !== undefined && b !== undefined ? Math.hypot(b.x - a.x, b.y - a.y) : 0));
  }
  const total = lengths[lengths.length - 1] ?? 0;
  const target = Math.min(Math.max(progress, 0), 1) * total;
  for (let i = 1; i < points.length; i++) {
    const l0 = lengths[i - 1] ?? 0;
    const l1 = lengths[i] ?? 0;
    if (target <= l1 || i === points.length - 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a === undefined || b === undefined) break;
      const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI };
    }
  }
  const first = points[0];
  return { x: first?.x ?? 0, y: first?.y ?? 0, angle: 0 };
}
