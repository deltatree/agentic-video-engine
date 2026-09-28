/**
 * Abbildung von Anime.js-Easings (v4-Namen, v3-Namen, Funktionsausdrücke) auf OpenVideo-Easings.
 */
import type { Diagnostic } from '@agentic-video/core';
import { lossy, note } from './diagnostics.js';

/** Easing-Angabe wie in Anime.js: Name, Ausdruck (`'out(3)'`) oder Ergebnis der Helfer unten. */
export type EaseInput = string;

const FAMILIES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'] as const;
const POWER_NAMES: Readonly<Record<number, string>> = { 2: 'Quad', 3: 'Cubic', 4: 'Quart', 5: 'Quint' };
/** Standard-Exponent von `in`/`out`/`inOut` ohne Parameter in Anime.js v4. */
const DEFAULT_POWER = 1.675;

function fmt(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Anime.js-`cubicBezier(x1, y1, x2, y2)` als Easing-Angabe.
 *
 * @example
 * ```ts
 * animate('logo', { x: 100, ease: cubicBezier(0.4, 0, 0.2, 1) });
 * ```
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseInput {
  return `cubicBezier(${fmt(x1)},${fmt(y1)},${fmt(x2)},${fmt(y2)})`;
}

/**
 * Anime.js-`steps(n, fromStart)` als Easing-Angabe.
 *
 * @example
 * ```ts
 * animate('clock', { rotate: 360, ease: steps(12) });
 * ```
 */
export function steps(count: number, fromStart = false): EaseInput {
  return `steps(${String(Math.max(1, Math.round(count)))}${fromStart ? ',true' : ''})`;
}

/** Parameter einer Feder wie in Anime.js. */
export interface SpringParams {
  readonly mass?: number;
  readonly stiffness?: number;
  readonly damping?: number;
  readonly velocity?: number;
}

/**
 * Anime.js-`spring({ mass, stiffness, damping, velocity })` als Easing-Angabe.
 *
 * @example
 * ```ts
 * animate('card', { y: 0, ease: spring({ stiffness: 200, damping: 12 }) });
 * ```
 */
export function spring(params: SpringParams = {}): EaseInput {
  return `spring(${fmt(params.mass ?? 1)},${fmt(params.stiffness ?? 100)},${fmt(params.damping ?? 10)},${fmt(params.velocity ?? 0)})`;
}

/** Ergebnis von {@link mapEase}. */
export interface MappedEase {
  readonly ease: string;
  readonly diagnostics: readonly Diagnostic[];
}

function args(text: string | undefined): number[] {
  if (text === undefined || text.trim() === '') return [];
  return text.split(',').map((a) => Number(a.trim()));
}

/**
 * Bildet eine Anime.js-Easing-Angabe auf ein OpenVideo-Easing ab.
 * Unbekanntes wird `linear` mit Diagnose; Näherungen melden `OV_IMPORT_LOSSY`.
 *
 * @example
 * ```ts
 * mapEase('inOutQuad', 'x').ease; // 'easeInOutQuad'
 * mapEase('out(3)', 'x').ease; // 'easeOutCubic' (mit Diagnose)
 * ```
 */
export function mapEase(input: unknown, path: string): MappedEase {
  const unknown = (what: string): MappedEase => ({
    ease: 'linear',
    diagnostics: [lossy(path, `Easing ${what} is not supported; "linear" is used.`, 'Use a named easing such as "inOutQuad", cubicBezier(), steps() or spring().')],
  });
  if (typeof input !== 'string') return unknown(typeof input === 'function' ? '(JavaScript function)' : JSON.stringify(input));
  const text = input.trim();
  if (text === 'linear' || text === 'none' || text === 'linear()') return { ease: 'linear', diagnostics: [] };
  const call = /^([A-Za-z]+)\s*(?:\(([^)]*)\))?$/u.exec(text);
  if (call === null) return unknown(`"${text}"`);
  const name = call[1] ?? '';
  const params = args(call[2]);
  if (params.some((p) => !Number.isFinite(p))) return unknown(`"${text}"`);
  if (name === 'cubicBezier') {
    const [a = 0, b = 0, c = 1, d = 1] = params;
    return { ease: `cubic-bezier(${fmt(Math.min(Math.max(a, 0), 1))},${fmt(b)},${fmt(Math.min(Math.max(c, 0), 1))},${fmt(d)})`, diagnostics: [] };
  }
  if (name === 'steps') {
    const [n = 10, fromStart = 0] = params;
    return { ease: `steps(${String(Math.max(1, Math.round(n)))},${fromStart !== 0 ? 'start' : 'end'})`, diagnostics: [] };
  }
  if (name === 'spring') {
    const [mass = 1, stiffness = 100, damping = 10, velocity = 0] = params;
    const diagnostics = velocity !== 0 ? [lossy(path, 'Spring initial velocity is not supported and was ignored.', 'Use velocity 0 or animate with a $spring value.')] : [];
    return { ease: `spring(${fmt(Math.max(stiffness, 0.001))},${fmt(Math.max(damping, 0))},${fmt(Math.max(mass, 0.001))})`, diagnostics };
  }
  // v3-Namen: easeInOutQuad → inOutQuad
  const normalized = name.startsWith('ease') && name.length > 4 ? `${(name[4] ?? '').toLowerCase()}${name.slice(5)}` : name;
  const m = /^(inOut|outIn|in|out)([A-Z][a-z]+)?$/u.exec(normalized);
  if (m === null) return unknown(`"${text}"`);
  const direction = m[1] ?? 'in';
  const family = m[2];
  if (direction === 'outIn') return unknown(`"${text}" (out-in curves have no OpenVideo equivalent)`);
  const prefix = direction === 'in' ? 'easeIn' : direction === 'out' ? 'easeOut' : 'easeInOut';
  if (family === undefined || family === 'Pow') {
    const power = params[0] ?? DEFAULT_POWER;
    const rounded = Math.min(Math.max(Math.round(power), 1), 5);
    const target = rounded === 1 ? 'linear' : `${prefix}${POWER_NAMES[rounded] ?? 'Quad'}`;
    const suggestion = `Use "${rounded === 1 ? 'linear' : `${direction}${POWER_NAMES[rounded] ?? 'Quad'}`}" to state the curve explicitly.`;
    // Ganzzahlige Exponenten 1..5 sind exakt die Penner-Kurven; andere werden genähert.
    const exact = Number.isInteger(power) && power >= 1 && power <= 5;
    return {
      ease: target,
      diagnostics: [
        exact
          ? note('OV_ANIME_EASE_MAPPED', path, `Power easing "${text}" was mapped to "${target}".`, suggestion)
          : lossy(path, `Power easing "${text}" (exponent ${fmt(power)}) is approximated by "${target}".`, suggestion),
      ],
    };
  }
  if (!FAMILIES.some((f) => f === family)) return unknown(`"${text}"`);
  const diagnostics = params.length > 0 ? [lossy(path, `Easing parameters of "${text}" are not supported; the default curve "${prefix}${family}" is used.`, `Use "${direction}${family}" without parameters or a cubicBezier().`)] : [];
  return { ease: `${prefix}${family}`, diagnostics };
}

/**
 * Kehrt ein OpenVideo-Easing zeitlich um (für `reversed`). Liefert `undefined`, wenn das nicht geht.
 *
 * @example
 * ```ts
 * reverseEase('easeInCubic'); // 'easeOutCubic'
 * ```
 */
export function reverseEase(ease: string): string | undefined {
  if (ease === 'linear' || ease === 'hold') return ease;
  const named = /^ease(InOut|In|Out)([A-Za-z]+)$/u.exec(ease);
  if (named !== null) {
    const dir = named[1] === 'In' ? 'Out' : named[1] === 'Out' ? 'In' : 'InOut';
    return `ease${dir}${named[2] ?? ''}`;
  }
  const bez = /^cubic-bezier\(([^)]*)\)$/u.exec(ease);
  if (bez !== null) {
    const [a = 0, b = 0, c = 1, d = 1] = args(bez[1]);
    return `cubic-bezier(${fmt(1 - c)},${fmt(1 - d)},${fmt(1 - a)},${fmt(1 - b)})`;
  }
  const st = /^steps\((\d+),(start|end)\)$/u.exec(ease);
  if (st !== null) return `steps(${st[1] ?? '1'},${st[2] === 'start' ? 'end' : 'start'})`;
  return undefined;
}
