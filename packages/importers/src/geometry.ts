/**
 * Geometrie für den SVG-Import: Transform-Listen, Matrix-Zerlegung und Pfade
 * in absoluter Form (M, L, C, Z), die sich mit einer Matrix umrechnen lassen.
 */
import { applyToPoint, IDENTITY, multiply, type Matrix2D } from '@agentic-video/core';
import { plain } from './common.js';

/**
 * Parst ein SVG-`transform`-Attribut in eine Matrix. Liefert `undefined` bei Syntaxfehlern.
 *
 * @example
 * ```ts
 * parseTransform('translate(10 20) rotate(45)');
 * ```
 */
export function parseTransform(text: string): Matrix2D | undefined {
  let m: Matrix2D = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/y;
  let pos = 0;
  const source = text.trim();
  while (pos < source.length) {
    re.lastIndex = pos;
    const hit = re.exec(source);
    if (hit === null) return undefined;
    pos = re.lastIndex;
    const args = (hit[2] ?? '').trim().split(/[\s,]+/u).filter((a) => a.length > 0).map(Number);
    if (args.some((a) => !Number.isFinite(a))) return undefined;
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    let next: Matrix2D;
    switch (hit[1]) {
      case 'matrix':
        if (args.length !== 6) return undefined;
        next = [a, b, c, d, e, f];
        break;
      case 'translate':
        next = [1, 0, 0, 1, a, args.length > 1 ? b : 0];
        break;
      case 'scale':
        next = [a, 0, 0, args.length > 1 ? b : a, 0, 0];
        break;
      case 'rotate': {
        const cos = Math.cos(rad(a));
        const sin = Math.sin(rad(a));
        next = [cos, sin, -sin, cos, 0, 0];
        if (args.length === 3) next = multiply(multiply([1, 0, 0, 1, b, c], next), [1, 0, 0, 1, -b, -c]);
        break;
      }
      case 'skewX':
        next = [1, 0, Math.tan(rad(a)), 1, 0, 0];
        break;
      default:
        next = [1, Math.tan(rad(a)), 0, 1, 0, 0];
    }
    m = multiply(m, next);
  }
  return m;
}

/** Zerlegte Matrix in IR-Transform-Felder. */
export interface Decomposed {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scale: { readonly x: number; readonly y: number };
  readonly skew: { readonly x: number; readonly y: number };
}

/**
 * Zerlegt eine Matrix in Rotation · Scherung(x) · Skalierung plus Verschiebung.
 * `pivot` ist der Punkt, um den die IR dreht (bei `origin: {0,0}` die linke obere Ecke der Box).
 * Liefert `undefined` für singuläre Matrizen (nicht zerlegbar).
 *
 * @example
 * ```ts
 * decompose([2, 0, 0, 2, 10, 20]); // { x: 10, y: 20, rotation: 0, scale: { x: 2, y: 2 }, skew: { x: 0, y: 0 } }
 * ```
 */
export function decompose(m: Matrix2D, pivot: { readonly x: number; readonly y: number } = { x: 0, y: 0 }): Decomposed | undefined {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const sx = Math.hypot(a, b);
  const theta = Math.atan2(b, a);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // R(-θ)·(c, d) = sy·(tan φ, 1)
  const shear = cos * c + sin * d;
  const sy = -sin * c + cos * d;
  // x, y so wählen, dass M·p = A·(p - o) + o + (x, y) gilt.
  const x = e - pivot.x + (a * pivot.x + c * pivot.y);
  const y = f - pivot.y + (b * pivot.x + d * pivot.y);
  return { x, y, rotation: (theta * 180) / Math.PI, scale: { x: sx, y: sy }, skew: { x: (Math.atan(shear / sy) * 180) / Math.PI, y: 0 } };
}

/** Ein Befehl eines absoluten Pfads. */
export type AbsCommand =
  | { readonly c: 'M' | 'L'; readonly p: readonly [number, number] }
  | { readonly c: 'C'; readonly p: readonly [number, number, number, number, number, number] }
  | { readonly c: 'Z' };

const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/gu;

function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, largeArc: boolean, sweep: boolean, x2: number, y2: number): AbsCommand[] {
  if (rxIn === 0 || ryIn === 0 || (x1 === x2 && y1 === y2)) return [{ c: 'L', p: [x2, y2] }];
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
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number) => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  const deriv = (t: number) => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
  const out: AbsCommand[] = [];
  for (let i = 0; i < parts; i++) {
    const t0 = theta1 + i * step;
    const t1 = t0 + step;
    const p0 = point(t0);
    const p1 = i === parts - 1 ? { x: x2, y: y2 } : point(t1);
    const d0 = deriv(t0);
    const d1 = deriv(t1);
    out.push({ c: 'C', p: [p0.x + k * d0.x, p0.y + k * d0.y, p1.x - k * d1.x, p1.y - k * d1.y, p1.x, p1.y] });
  }
  return out;
}

/**
 * Wandelt SVG-Pfaddaten in absolute Befehle M, L, C, Z um (Bögen und Quadratkurven werden kubisch).
 *
 * @example
 * ```ts
 * absolutePath('m10 10 h5 v5 z'); // [{ c: 'M', p: [10, 10] }, { c: 'L', p: [15, 10] }, { c: 'L', p: [15, 15] }, { c: 'Z' }]
 * ```
 */
export function absolutePath(d: string): AbsCommand[] {
  const tokens = d.match(TOKEN) ?? [];
  const out: AbsCommand[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: [number, number] | undefined;
  let lastQuad: [number, number] | undefined;
  const num = (): number => {
    const t = tokens[i++];
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  };
  const flag = (): boolean => num() !== 0;
  const isCommand = (t: string | undefined) => t !== undefined && /^[A-Za-z]$/u.test(t);
  while (i < tokens.length) {
    if (isCommand(tokens[i])) cmd = tokens[i++] ?? '';
    else if (cmd === '') break;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const upper = cmd.toUpperCase();
    let ctrl: [number, number] | undefined;
    let quad: [number, number] | undefined;
    switch (upper) {
      case 'M':
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        out.push({ c: 'M', p: [x, y] });
        cmd = rel ? 'l' : 'L';
        break;
      case 'L':
        x = ox + num();
        y = oy + num();
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'H':
        x = ox + num();
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'V':
        y = (rel ? y : 0) + num();
        out.push({ c: 'L', p: [x, y] });
        break;
      case 'C': {
        const p: [number, number, number, number, number, number] = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        out.push({ c: 'C', p });
        ctrl = [p[2], p[3]];
        x = p[4];
        y = p[5];
        break;
      }
      case 'S': {
        const c1x = lastCtrl !== undefined ? 2 * x - lastCtrl[0] : x;
        const c1y = lastCtrl !== undefined ? 2 * y - lastCtrl[1] : y;
        const p: [number, number, number, number, number, number] = [c1x, c1y, ox + num(), oy + num(), ox + num(), oy + num()];
        out.push({ c: 'C', p });
        ctrl = [p[2], p[3]];
        x = p[4];
        y = p[5];
        break;
      }
      case 'Q':
      case 'T': {
        const qx = upper === 'Q' ? ox + num() : lastQuad !== undefined ? 2 * x - lastQuad[0] : x;
        const qy = upper === 'Q' ? oy + num() : lastQuad !== undefined ? 2 * y - lastQuad[1] : y;
        const ex = ox + num();
        const ey = oy + num();
        out.push({ c: 'C', p: [x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey] });
        quad = [qx, qy];
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const ex = ox + num();
        const ey = oy + num();
        out.push(...arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey));
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        out.push({ c: 'Z' });
        x = sx;
        y = sy;
        cmd = '';
        break;
      default:
        i = tokens.length;
    }
    lastCtrl = ctrl;
    lastQuad = quad;
  }
  return out;
}

/** Wendet eine Matrix auf alle Punkte absoluter Befehle an. */
export function transformPath(commands: readonly AbsCommand[], m: Matrix2D): AbsCommand[] {
  return commands.map((cmd): AbsCommand => {
    if (cmd.c === 'Z') return cmd;
    if (cmd.c === 'C') {
      const a = applyToPoint(m, cmd.p[0], cmd.p[1]);
      const b = applyToPoint(m, cmd.p[2], cmd.p[3]);
      const e = applyToPoint(m, cmd.p[4], cmd.p[5]);
      return { c: 'C', p: [a.x, a.y, b.x, b.y, e.x, e.y] };
    }
    const p = applyToPoint(m, cmd.p[0], cmd.p[1]);
    return { c: cmd.c, p: [p.x, p.y] };
  });
}

/** Formatiert absolute Befehle als Pfaddaten, z. B. `M0 0 L10 0 Z`. */
export function formatPath(commands: readonly AbsCommand[]): string {
  return commands.map((cmd) => (cmd.c === 'Z' ? 'Z' : `${cmd.c}${cmd.p.map((n) => plain(n, 4)).join(' ')}`)).join(' ');
}

/** Pfad eines Rechtecks. */
export function rectPath(x: number, y: number, w: number, h: number): AbsCommand[] {
  return [{ c: 'M', p: [x, y] }, { c: 'L', p: [x + w, y] }, { c: 'L', p: [x + w, y + h] }, { c: 'L', p: [x, y + h] }, { c: 'Z' }];
}

/** Pfad einer Ellipse aus vier kubischen Bögen. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): AbsCommand[] {
  const k = 0.5522847498;
  return [
    { c: 'M', p: [cx + rx, cy] },
    { c: 'C', p: [cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry] },
    { c: 'C', p: [cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy] },
    { c: 'C', p: [cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry] },
    { c: 'C', p: [cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy] },
    { c: 'Z' },
  ];
}

/** Pfad durch Punkte (offen oder geschlossen). */
export function pointsPath(points: readonly (readonly [number, number])[], closed: boolean): AbsCommand[] {
  const out: AbsCommand[] = points.map((p, i) => ({ c: i === 0 ? 'M' : 'L', p: [p[0], p[1]] }));
  if (closed) out.push({ c: 'Z' });
  return out;
}
