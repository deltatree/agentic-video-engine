/**
 * Interpolation zwischen zwei Werten beliebigen IR-Typs.
 *
 * - Zahlen: linear.
 * - Farben (`#RRGGBB[AA]`): kanalweise im sRGB-Raum.
 * - Arrays und Objekte mit gleicher Struktur: elementweise.
 * - SVG-Pfade mit gleicher Befehlsfolge: Zahlen werden interpoliert (Morphing).
 * - Alles andere: Halten (Wert springt am Ende des Segments).
 */
import { COLOR_PATTERN } from '@agentic-video/schema';
import { formatColor, mixColor, parseColor } from './color.js';

const COLOR_RE = new RegExp(COLOR_PATTERN, 'u');
const PATH_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Zerlegt SVG-Pfaddaten in Befehle und Zahlen. */
export function tokenizePath(d: string): (string | number)[] {
  return (d.match(PATH_TOKEN) ?? []).map((t) => (/^[A-Za-z]$/u.test(t) ? t : Number(t)));
}

function pathStructure(tokens: readonly (string | number)[]): string {
  return tokens.map((t) => (typeof t === 'string' ? t : '#')).join('');
}

function formatNumber(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Prüft, ob zwei Pfade dieselbe Befehlsfolge haben und damit morphbar sind. */
export function pathsCompatible(a: string, b: string): boolean {
  return pathStructure(tokenizePath(a)) === pathStructure(tokenizePath(b));
}

function mixPath(a: string, b: string, t: number): string | undefined {
  const ta = tokenizePath(a);
  const tb = tokenizePath(b);
  if (pathStructure(ta) !== pathStructure(tb)) return undefined;
  return ta
    .map((token, i) => {
      if (typeof token === 'string') return token;
      const other = tb[i];
      return formatNumber(typeof other === 'number' ? token + (other - token) * t : token);
    })
    .join(' ');
}

/**
 * Interpoliert zwischen `a` und `b` bei Fortschritt `t` (0..1, darf überschwingen).
 *
 * @example
 * ```ts
 * interpolate(0, 100, 0.25); // 25
 * interpolate('#000000', '#FFFFFF', 0.5); // '#808080'
 * interpolate({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5); // { x: 5, y: 10 }
 * ```
 */
export function interpolate(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') return t === 0 ? a : t === 1 ? b : a + (b - a) * t;
  if (typeof a === 'string' && typeof b === 'string') {
    if (COLOR_RE.test(a) && COLOR_RE.test(b)) {
      const tc = Math.min(Math.max(t, 0), 1);
      return formatColor(mixColor(parseColor(a), parseColor(b), tc));
    }
    if (a !== b && /[MmLlCcQqAaHhVvZz]/u.test(a) && /^[\s0-9MmLlHhVvCcSsQqTtAaZz.,eE+-]+$/u.test(a)) {
      const morphed = mixPath(a, b, t);
      if (morphed !== undefined) return morphed;
    }
    return t < 1 ? a : b;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.map((item: unknown, i) => interpolate(item, b[i], t));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length === Object.keys(b).length && keys.every((k) => k in b)) {
      return Object.fromEntries(keys.map((k) => [k, interpolate(a[k], b[k], t)]));
    }
  }
  return t < 1 ? a : b;
}
