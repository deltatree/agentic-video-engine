/**
 * Kleine Helfer, die Animationsdaten der IR erzeugen (reine Daten, kein Zustand).
 * SDK, Komponenten und Adapter nutzen sie; das Ergebnis ist direkt JSON.
 */
import type { AnimatedValue, TimeValue } from '@agentic-video/schema';

/** Ein Keyframe. `ease` gilt für das Segment, das auf diesen Keyframe zuläuft. */
export interface Keyframe<T> {
  readonly t: TimeValue;
  readonly v: T;
  readonly ease?: string;
}

/** Optionen für {@link keyframes}. */
export interface KeyframeOptions {
  readonly loop?: 'none' | 'repeat' | 'pingpong';
  readonly repeat?: number | 'infinite';
  readonly delay?: TimeValue;
}

/**
 * Erzeugt eine Keyframe-Animation.
 *
 * @example
 * ```ts
 * keyframes([{ t: 0, v: 0 }, { t: '1s', v: 1, ease: 'easeOutCubic' }]);
 * ```
 */
export function keyframes<T>(frames: readonly Keyframe<T>[], options: KeyframeOptions = {}): AnimatedValue<T> {
  return {
    $keyframes: frames.map((k) => ({ t: k.t, v: k.v, ...(k.ease !== undefined ? { ease: k.ease } : {}) })),
    ...(options.loop !== undefined ? { loop: options.loop } : {}),
    ...(options.repeat !== undefined ? { repeat: options.repeat } : {}),
    ...(options.delay !== undefined ? { delay: options.delay } : {}),
  };
}

/** Optionen für {@link animate}. */
export interface AnimateOptions extends KeyframeOptions {
  /** Startzeit (Standard 0). */
  readonly from?: TimeValue;
  /** Endzeit. Alternativ `duration`. */
  readonly to?: TimeValue;
  readonly duration?: TimeValue;
  readonly ease?: string;
}

/**
 * Animiert von `start` nach `end` zwischen zwei Zeitpunkten.
 *
 * @example
 * ```ts
 * animate([0, 2, 8], [0, 1, 5], { from: 0, to: '4s', ease: 'easeInOutCubic' });
 * ```
 */
export function animate<T>(start: T, end: T, options: AnimateOptions = {}): AnimatedValue<T> {
  const from = options.from ?? 0;
  const to = options.to ?? addTime(from, options.duration ?? '1s');
  return keyframes(
    [
      { t: from, v: start },
      { t: to, v: end, ...(options.ease !== undefined ? { ease: options.ease } : {}) },
    ],
    options,
  );
}

/** Addiert zwei Zeitwerte symbolisch, wenn beide Frames sind; sonst als Sekunden-Text, falls möglich. */
export function addTime(a: TimeValue, b: TimeValue): TimeValue {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  const secA = seconds(a);
  const secB = seconds(b);
  if (secA !== undefined && secB !== undefined) return `${String(Math.round((secA + secB) * 1e6) / 1e6)}s`;
  if (typeof a === 'string' && a.startsWith('marker:') && secB !== undefined) return `${a}${secB >= 0 ? '+' : '-'}${String(Math.abs(secB))}s`;
  throw new TypeError(`Cannot add time values ${JSON.stringify(a)} and ${JSON.stringify(b)} without fps; use frames or seconds.`);
}

function seconds(v: TimeValue): number | undefined {
  if (typeof v === 'number') return v === 0 ? 0 : undefined;
  const m = /^(-?[0-9]+(?:\.[0-9]+)?)(s|ms)$/u.exec(v);
  if (m === null) return undefined;
  return m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
}

/** Optionen für {@link spring}. */
export interface SpringOptions<T> {
  readonly from: T;
  readonly to: T;
  readonly at?: TimeValue;
  readonly stiffness?: number;
  readonly damping?: number;
  readonly mass?: number;
  readonly velocity?: number;
}

/**
 * Erzeugt eine Feder-Animation.
 *
 * @example
 * ```ts
 * spring({ from: 0, to: 1, at: 20, stiffness: 170, damping: 26 });
 * ```
 */
export function spring<T>(options: SpringOptions<T>): AnimatedValue<T> {
  return { $spring: { ...options } };
}

/** Erzeugt eine Expression. @example expr('sin(time * 2) * 40') */
export function expr(source: string): { $expr: string } {
  return { $expr: source };
}

/** Verweist auf ein Theme-Token. @example ref('theme.colors.primary') */
export function ref(path: string): { $ref: string } {
  return { $ref: path };
}

/**
 * Startzeiten für versetzte Einsätze (Stagger) in Frames.
 *
 * @example
 * ```ts
 * stagger(3, 5, 10); // [10, 15, 20]
 * ```
 */
export function stagger(count: number, each: number, start = 0): number[] {
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => start + i * each);
}

/**
 * Startzeiten für eine Sequenz aufeinanderfolgender Abschnitte in Frames.
 * `overlap` > 0 lässt Abschnitte überlappen (für Übergänge).
 *
 * @example
 * ```ts
 * sequence([90, 120, 60], { overlap: 15 }); // [0, 75, 180]
 * ```
 */
export function sequence(durations: readonly number[], options: { readonly start?: number; readonly overlap?: number } = {}): number[] {
  const out: number[] = [];
  let t = options.start ?? 0;
  for (const d of durations) {
    out.push(t);
    t += d - (options.overlap ?? 0);
  }
  return out;
}
