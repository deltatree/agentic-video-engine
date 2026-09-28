/**
 * Zustandsloser, deterministischer Zufall (AD-2).
 *
 * Jeder Wert folgt aus Seed und Schlüsseln. Es gibt keinen internen Zustand,
 * daher hängt Frame n nie von Frame n-1 ab.
 */

/** Mischt eine 32-Bit-Zahl (Murmur3-Finalizer). */
function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function keyToInt(key: number | string): number {
  if (typeof key === 'number') {
    if (Number.isInteger(key)) return key | 0;
    // Gebrochene Zahlen: Bitmuster der Float64-Darstellung
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, key);
    return (view.getUint32(0) ^ view.getUint32(4)) | 0;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * 32-Bit-Hash aus Seed und beliebig vielen Schlüsseln.
 *
 * @example
 * ```ts
 * hash32(42, 'particle', 7) === hash32(42, 'particle', 7); // true
 * ```
 */
export function hash32(seed: number, ...keys: readonly (number | string)[]): number {
  let h = fmix32((seed | 0) ^ 0x9e3779b9);
  for (const k of keys) h = fmix32(h ^ fmix32(keyToInt(k) + 0x6a09e667));
  return h;
}

/**
 * Deterministische Zufallszahl in [0, 1).
 *
 * @example
 * ```ts
 * random(1, 'star', 3); // immer derselbe Wert
 * ```
 */
export function random(seed: number, ...keys: readonly (number | string)[]): number {
  return hash32(seed, ...keys) / 4294967296;
}

/** Deterministische Zufallszahl in [min, max). */
export function randomRange(seed: number, min: number, max: number, ...keys: readonly (number | string)[]): number {
  return min + (max - min) * random(seed, ...keys);
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad1(seed: number, i: number): number {
  return random(seed, 'noise1', i) * 2 - 1;
}

/**
 * Glattes 1D-Gradientenrauschen in etwa [-1, 1].
 *
 * @example
 * ```ts
 * noise1(7, time * 2); // ruhige, deterministische Bewegung
 * ```
 */
export function noise1(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = grad1(seed, i) * f;
  const b = grad1(seed, i + 1) * (f - 1);
  return (a + (b - a) * fade(f)) * 2;
}

/** Glattes 2D-Gradientenrauschen in etwa [-1, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const angle = random(seed, 'noise2', ix, iy) * Math.PI * 2;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  const u = fade(xf);
  const v = fade(yf);
  const n00 = g(xi, yi, xf, yf);
  const n10 = g(xi + 1, yi, xf - 1, yf);
  const n01 = g(xi, yi + 1, xf, yf - 1);
  const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * Math.SQRT2;
}

/**
 * „Wiggle“ wie in Motion-Design-Werkzeugen: Rauschen mit Frequenz (Hz) und Amplitude.
 *
 * @example
 * ```ts
 * wiggle(1, time, 2, 10); // ±10 Einheiten, etwa zwei Richtungswechsel pro Sekunde
 * ```
 */
export function wiggle(seed: number, time: number, frequency: number, amplitude: number, octaves = 1): number {
  let sum = 0;
  let amp = 1;
  let freq = frequency;
  let norm = 0;
  for (let o = 0; o < Math.max(1, Math.floor(octaves)); o++) {
    sum += noise1(seed + o * 1013, time * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return (sum / norm) * amplitude;
}
