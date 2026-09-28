/**
 * Easing-Funktionen (FR-11): benannte Penner-Easings, cubic-bezier, steps und spring.
 */
import { OpenVideoError, EASING_PATTERN } from '@agentic-video/schema';
import { springProgress, springSettleTime } from './spring.js';

/** Eine Easing-Funktion bildet [0, 1] auf einen Fortschritt ab (darf überschwingen). */
export type EasingFn = (t: number) => number;

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

function bounceOut(x: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

/** Alle benannten Easings. */
export const EASINGS: Readonly<Record<string, EasingFn>> = {
  linear: (x) => x,
  hold: (x) => (x < 1 ? 0 : 1),
  easeInSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
  easeOutSine: (x) => Math.sin((x * Math.PI) / 2),
  easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  easeInQuad: (x) => x * x,
  easeOutQuad: (x) => 1 - (1 - x) * (1 - x),
  easeInOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2),
  easeInCubic: (x) => x ** 3,
  easeOutCubic: (x) => 1 - (1 - x) ** 3,
  easeInOutCubic: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  easeInQuart: (x) => x ** 4,
  easeOutQuart: (x) => 1 - (1 - x) ** 4,
  easeInOutQuart: (x) => (x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2),
  easeInQuint: (x) => x ** 5,
  easeOutQuint: (x) => 1 - (1 - x) ** 5,
  easeInOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  easeInExpo: (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
  easeOutExpo: (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
  easeInOutExpo: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2),
  easeInCirc: (x) => 1 - Math.sqrt(1 - x * x),
  easeOutCirc: (x) => Math.sqrt(1 - (x - 1) ** 2),
  easeInOutCirc: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - (2 * x) ** 2)) / 2 : (Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
  easeInBack: (x) => c3 * x ** 3 - c1 * x * x,
  easeOutBack: (x) => 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2,
  easeInOutBack: (x) => (x < 0.5 ? ((2 * x) ** 2 * ((c2 + 1) * 2 * x - c2)) / 2 : ((2 * x - 2) ** 2 * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
  easeInElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : -(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * c4)),
  easeOutElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1),
  easeInOutElastic: (x) =>
    x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? -(2 ** (20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2 : (2 ** (-20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
  easeInBounce: (x) => 1 - bounceOut(1 - x),
  easeOutBounce: bounceOut,
  easeInOutBounce: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
};

/**
 * Kubische Bezier-Kurve wie CSS `cubic-bezier(x1, y1, x2, y2)`.
 * Löst x(t) = x deterministisch mit Newton-Verfahren und Bisektion.
 *
 * @example
 * ```ts
 * const ease = cubicBezier(0.25, 0.1, 0.25, 1); // CSS "ease"
 * ease(0.5); // ≈ 0.8024
 * ```
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-7) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solve(x));
  };
}

/** Stufen-Easing wie CSS `steps(n, start|end)`. */
export function steps(count: number, position: 'start' | 'end' = 'end'): EasingFn {
  const n = Math.max(1, Math.floor(count));
  return (x) => {
    if (x >= 1) return 1;
    if (x <= 0) return position === 'start' ? 1 / n : 0;
    const step = position === 'start' ? Math.ceil(x * n) : Math.floor(x * n);
    return Math.min(1, step / n);
  };
}

/** Feder als Easing: die Segmentdauer entspricht der Einschwingzeit der Feder. */
export function springEasing(stiffness: number, damping: number, mass = 1): EasingFn {
  const params = { stiffness, damping, mass };
  const settle = springSettleTime(params);
  const duration = Number.isFinite(settle) && settle > 0 ? settle : 1;
  return (x) => (x >= 1 ? 1 : springProgress(x * duration, params));
}

const cache = new Map<string, EasingFn>();
const EASING_RE = new RegExp(EASING_PATTERN, 'u');

/**
 * Liefert die Easing-Funktion zu einem Easing-Ausdruck. Ergebnisse werden zwischengespeichert.
 *
 * @example
 * ```ts
 * easing('easeInOutCubic')(0.5); // 0.5
 * easing('cubic-bezier(0.4, 0, 0.2, 1)')(0.5);
 * easing('steps(4, end)')(0.3); // 0.25
 * ```
 */
export function easing(name: string | undefined): EasingFn {
  const key = name ?? 'linear';
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const fn = createEasing(key);
  cache.set(key, fn);
  return fn;
}

function createEasing(key: string): EasingFn {
  const aliases: Readonly<Record<string, string>> = { ease: 'cubic-bezier(0.25,0.1,0.25,1)', easeIn: 'cubic-bezier(0.42,0,1,1)', easeOut: 'cubic-bezier(0,0,0.58,1)', easeInOut: 'cubic-bezier(0.42,0,0.58,1)' };
  const resolved = aliases[key] ?? key;
  const named = EASINGS[resolved];
  if (named !== undefined) return named;
  if (!EASING_RE.test(resolved)) {
    throw new OpenVideoError({
      code: 'OV_EASING_INVALID',
      errorClass: 'TimelineError',
      problem: `Unknown easing "${key}".`,
      suggestions: ['Use a name like "easeInOutCubic", "cubic-bezier(0.4,0,0.2,1)", "steps(4,end)" or "spring(170,26)".'],
    });
  }
  const args = (resolved.slice(resolved.indexOf('(') + 1, resolved.lastIndexOf(')')) || '').split(',').map((s) => s.trim());
  if (resolved.startsWith('cubic-bezier')) {
    const [a, b, c, d] = args.map(Number);
    return cubicBezier(a ?? 0, b ?? 0, c ?? 1, d ?? 1);
  }
  if (resolved.startsWith('steps')) return steps(Number(args[0]), args[1] === 'start' ? 'start' : 'end');
  const [k, damp, m] = args.map(Number);
  return springEasing(k ?? 100, damp ?? 10, m ?? 1);
}
