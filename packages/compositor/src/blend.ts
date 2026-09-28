/**
 * Blend Modes nach W3C „Compositing and Blending Level 1“ (FR-45).
 *
 * Ergebnis (vormultipliziert, Source-over), mit geraden Farben `cs`, `cb` und Alphas `as`, `ab`:
 * `co = cs·as·(1 − ab) + cb·ab·(1 − as) + as·ab·B(cb, cs)`, `ao = as + ab·(1 − as)`.
 * `add` ist Linear Dodge: `B = min(1, cb + cs)`.
 */
import type { BlendMode } from '@agentic-video/core';

/** RGB-Tripel mit geraden Farbwerten 0..1. */
export type Rgb = readonly [number, number, number];

/** Mischfunktion `B(cb, cs)`: Backdrop `cb`, Quelle `cs`, beide gerade. */
export type BlendFunction = (cb: Rgb, cs: Rgb) => Rgb;

type Channel = (cb: number, cs: number) => number;

const multiply: Channel = (b, s) => b * s;
const screen: Channel = (b, s) => b + s - b * s;
const hardLight: Channel = (b, s) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1));

const colorDodge: Channel = (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const colorBurn: Channel = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const softLight: Channel = (b, s) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};

const SEPARABLE: Readonly<Partial<Record<BlendMode, Channel>>> = {
  normal: (_b, s) => s,
  multiply,
  screen,
  overlay: (b, s) => hardLight(s, b),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
  'color-dodge': colorDodge,
  'color-burn': colorBurn,
  'hard-light': hardLight,
  'soft-light': softLight,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  add: (b, s) => Math.min(1, b + s),
};

function separable(f: Channel): BlendFunction {
  return (cb, cs) => [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])];
}

/** Luminanz nach W3C (Rec.-601-Gewichte, wie in der Spezifikation). */
function lum(c: Rgb): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let r = c[0];
  let g = c[1];
  let b = c[2];
  if (n < 0) {
    r = l + ((r - l) * l) / (l - n);
    g = l + ((g - l) * l) / (l - n);
    b = l + ((b - l) * l) / (l - n);
  }
  if (x > 1) {
    r = l + ((r - l) * (1 - l)) / (x - l);
    g = l + ((g - l) * (1 - l)) / (x - l);
    b = l + ((b - l) * (1 - l)) / (x - l);
  }
  return [r, g, b];
}

function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function sat(c: Rgb): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

function setSat(c: Rgb, s: number): Rgb {
  const max = Math.max(c[0], c[1], c[2]);
  const min = Math.min(c[0], c[1], c[2]);
  if (max <= min) return [0, 0, 0];
  const map = (v: number): number => (v === max ? s : v === min ? 0 : ((v - min) * s) / (max - min));
  return [map(c[0]), map(c[1]), map(c[2])];
}

/**
 * Alle 17 Mischfunktionen `B(cb, cs)` je Blend Mode.
 *
 * @example
 * ```ts
 * BLEND_FUNCTIONS.multiply([0.5, 0.5, 0.5], [1, 0, 0.5]); // [0.5, 0, 0.25]
 * ```
 */
export const BLEND_FUNCTIONS: Readonly<Record<BlendMode, BlendFunction>> = {
  normal: (_cb, cs) => cs,
  multiply: separable(multiply),
  screen: separable(screen),
  overlay: separable((b, s) => hardLight(s, b)),
  darken: separable((b, s) => Math.min(b, s)),
  lighten: separable((b, s) => Math.max(b, s)),
  'color-dodge': separable(colorDodge),
  'color-burn': separable(colorBurn),
  'hard-light': separable(hardLight),
  'soft-light': separable(softLight),
  difference: separable((b, s) => Math.abs(b - s)),
  exclusion: separable((b, s) => b + s - 2 * b * s),
  hue: (cb, cs) => setLum(setSat(cs, sat(cb)), lum(cb)),
  saturation: (cb, cs) => setLum(setSat(cb, sat(cs)), lum(cb)),
  color: (cb, cs) => setLum(cs, lum(cb)),
  luminosity: (cb, cs) => setLum(cb, lum(cs)),
  add: separable((b, s) => Math.min(1, b + s)),
};

/**
 * Kanalweise Funktion für separable Modes, sonst `undefined`.
 *
 * @example
 * ```ts
 * separableChannel('multiply')?.(0.5, 0.5); // 0.25
 * ```
 */
export function separableChannel(mode: BlendMode): ((cb: number, cs: number) => number) | undefined {
  return SEPARABLE[mode];
}

/** RGBA-Pixel mit vormultipliziertem Alpha, Werte 0..1. */
export type Rgba = readonly [number, number, number, number];

const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Mischt ein Quellpixel über ein Backdrop-Pixel (beide vormultipliziert, 0..1).
 * Gerade Farben werden vor dem Mischen auf 0..1 begrenzt.
 *
 * @example
 * ```ts
 * blendPixel('screen', [0.5, 0, 0, 1], [0, 0.5, 0, 1]); // [0.5, 0.5, 0, 1]
 * ```
 */
export function blendPixel(mode: BlendMode, backdrop: Rgba, source: Rgba): [number, number, number, number] {
  const as = clamp(source[3]);
  const ab = clamp(backdrop[3]);
  const ao = as + ab * (1 - as);
  if (mode === 'normal') {
    return [source[0] + backdrop[0] * (1 - as), source[1] + backdrop[1] * (1 - as), source[2] + backdrop[2] * (1 - as), ao];
  }
  const cs: Rgb = as > 0 ? [clamp(source[0] / as), clamp(source[1] / as), clamp(source[2] / as)] : [0, 0, 0];
  const cb: Rgb = ab > 0 ? [clamp(backdrop[0] / ab), clamp(backdrop[1] / ab), clamp(backdrop[2] / ab)] : [0, 0, 0];
  const b = BLEND_FUNCTIONS[mode](cb, cs);
  const both = as * ab;
  return [
    cs[0] * as * (1 - ab) + cb[0] * ab * (1 - as) + both * b[0],
    cs[1] * as * (1 - ab) + cb[1] * ab * (1 - as) + both * b[1],
    cs[2] * as * (1 - ab) + cb[2] * ab * (1 - as) + both * b[2],
    ao,
  ];
}
