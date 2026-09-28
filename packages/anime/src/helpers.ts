/**
 * `stagger` und `utils` wie in Anime.js, deterministisch.
 */
import { OpenVideoError, random } from '@agentic-video/core';

/** Funktionswert wie in Anime.js: `(target, index, total) => value`. Das Ziel ist die Node-ID. */
export type FunctionValue<T> = (target: string, index: number, total: number) => T;

/** Optionen für {@link stagger}. */
export interface StaggerOptions {
  /** Startwert, der zu jedem Ergebnis addiert wird (Standard 0). */
  readonly start?: number;
  /** Ausgangspunkt der Verteilung (Standard `first`). */
  readonly from?: 'first' | 'last' | 'center' | number;
  /** Kehrt die Reihenfolge um. */
  readonly reversed?: boolean;
  /** Raster-Verteilung (nicht unterstützt). */
  readonly grid?: readonly [number, number];
}

/**
 * Verteilt Werte über die Ziele (meist Verzögerungen), wie `stagger()` in Anime.js.
 * `value` als Zahl: Schrittweite. Als `[a, b]`: Bereich, der gleichmäßig verteilt wird.
 *
 * @example
 * ```ts
 * createTimeline().add(['a', 'b', 'c'], { opacity: 1, delay: stagger(100, { start: 50 }) });
 * // Verzögerungen: 50, 150, 250 ms
 * ```
 */
export function stagger(value: number | readonly [number, number], options: StaggerOptions = {}): FunctionValue<number> {
  if (options.grid !== undefined) {
    throw new OpenVideoError({
      code: 'OV_ANIME_UNSUPPORTED',
      errorClass: 'AnimeAdapterError',
      problem: 'stagger() with a grid is not supported.',
      suggestions: ['Compute the delays with a function value (target, index, total) => delay.'],
    });
  }
  const start = options.start ?? 0;
  return (_target, index, total) => {
    const from = options.from ?? 'first';
    const origin = from === 'first' ? 0 : from === 'last' ? total - 1 : from === 'center' ? (total - 1) / 2 : from;
    const i = options.reversed === true ? total - 1 - index : index;
    const distance = Math.abs(i - origin);
    if (typeof value === 'number') return start + value * distance;
    const maxDistance = Math.max(Math.abs(0 - origin), Math.abs(total - 1 - origin));
    const [a, b] = value;
    return start + (maxDistance === 0 ? a : a + ((b - a) * distance) / maxDistance);
  };
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** Math.max(0, Math.floor(decimals));
  return Math.round(n * f) / f;
}

/**
 * Hilfsfunktionen wie `utils` in Anime.js. Zufall ist immer deterministisch (Seed und Schlüssel).
 *
 * @example
 * ```ts
 * utils.random(0, 100, 0, 42, 'star', 3); // immer derselbe Wert
 * const rnd = utils.createSeededRandom(7);
 * rnd(0, 1, 2); rnd(0, 1, 2); // feste Folge
 * ```
 */
export const utils = {
  /** Zufallszahl in [min, max] mit `decimals` Nachkommastellen, bestimmt durch Seed und Schlüssel. */
  random(min: number, max: number, decimals = 0, seed = 0, ...keys: readonly (number | string)[]): number {
    return roundTo(min + random(seed, 'anime.random', ...keys) * (max - min), decimals);
  },
  /** Zufallsfolge mit festem Seed: jeder Aufruf liefert den nächsten Wert der Folge. */
  createSeededRandom(seed = 0): (min?: number, max?: number, decimals?: number) => number {
    let n = 0;
    return (min = 0, max = 1, decimals = 0) => roundTo(min + random(seed, 'anime.seeded', n++) * (max - min), decimals);
  },
  /** Begrenzt einen Wert auf [min, max]. */
  clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  },
};
