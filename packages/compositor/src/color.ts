/**
 * Color Management (FR-47, AD-6): Transferfunktionen und Umrechnung zwischen Farbräumen.
 *
 * Alle drei Räume nutzen die Primärfarben von Rec. 709 / sRGB. Sie unterscheiden sich nur
 * in der Transferfunktion (Kodierung):
 * - `srgb`: stückweise sRGB-Kurve (IEC 61966-2-1).
 * - `rec709`: OETF aus ITU-R BT.709 (`1.099·L^0.45 − 0.099`, linear unter 0.018).
 * - `linear`: lineares Licht ohne Kodierung.
 *
 * Intern rechnet der Compositor mit {@link FloatImage}: Float32, vormultipliziertes Alpha.
 */
import { OpenVideoError, type ColorSpace, type RgbaImage } from '@agentic-video/core';

/** Float-Bild mit vormultipliziertem Alpha, 4 Kanäle je Pixel, Werte nominell 0..1. */
export interface FloatImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/**
 * Erzeugt ein transparentes Float-Bild.
 *
 * @example
 * ```ts
 * const img = createFloatImage(1920, 1080);
 * ```
 */
export function createFloatImage(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height * 4) };
}

/**
 * Dekodiert einen sRGB-Wert (0..1) zu linearem Licht.
 *
 * @example
 * ```ts
 * srgbToLinear(0.5); // ≈ 0.214
 * ```
 */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Kodiert lineares Licht (0..1) mit der sRGB-Kurve.
 *
 * @example
 * ```ts
 * linearToSrgb(0.5); // ≈ 0.735
 * ```
 */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Dekodiert einen Rec.-709-Wert (0..1) zu linearem Licht (Umkehrung der BT.709-OETF).
 *
 * @example
 * ```ts
 * rec709ToLinear(0.5); // ≈ 0.26
 * ```
 */
export function rec709ToLinear(v: number): number {
  return v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}

/**
 * Kodiert lineares Licht (0..1) mit der BT.709-OETF.
 *
 * @example
 * ```ts
 * linearToRec709(0.5); // ≈ 0.706
 * ```
 */
export function linearToRec709(v: number): number {
  return v < 0.018 ? v * 4.5 : 1.099 * Math.pow(v, 0.45) - 0.099;
}

/**
 * Dekodiert einen Wert des Raums `space` zu linearem Licht. Negative Werte werden zu 0.
 *
 * @example
 * ```ts
 * decodeTransfer(0.5, 'srgb'); // ≈ 0.214
 * ```
 */
export function decodeTransfer(v: number, space: ColorSpace): number {
  const c = v <= 0 ? 0 : v;
  if (space === 'linear') return c;
  return space === 'srgb' ? srgbToLinear(c) : rec709ToLinear(c);
}

/**
 * Kodiert lineares Licht in den Raum `space`. Negative Werte werden zu 0.
 *
 * @example
 * ```ts
 * encodeTransfer(0.214, 'srgb'); // ≈ 0.5
 * ```
 */
export function encodeTransfer(v: number, space: ColorSpace): number {
  const c = v <= 0 ? 0 : v;
  if (space === 'linear') return c;
  return space === 'srgb' ? linearToSrgb(c) : linearToRec709(c);
}

/** Wandelt eine Kodierung in eine andere; beide Werte gerade (nicht vormultipliziert). */
function transfer(v: number, from: ColorSpace, to: ColorSpace): number {
  if (from === to) return v;
  return encodeTransfer(decodeTransfer(v, from), to);
}

/** Stützstellen der Transfer-Tabellen. Lineare Interpolation; Fehler < 0.01 LSB bei 8 Bit. */
const TABLE_STEPS = 4096;
const transferTables = new Map<string, Float32Array>();
const decodeTables = new Map<ColorSpace, Float32Array>();

/** Tabelle `from → to` für gerade Werte 0..1 (mit einem Schutzeintrag am Ende). */
function transferTable(from: ColorSpace, to: ColorSpace): Float32Array {
  const key = `${from}>${to}`;
  let t = transferTables.get(key);
  if (t === undefined) {
    t = new Float32Array(TABLE_STEPS + 2);
    for (let i = 0; i <= TABLE_STEPS; i++) t[i] = transfer(i / TABLE_STEPS, from, to);
    t[TABLE_STEPS + 1] = t[TABLE_STEPS] ?? 1;
    transferTables.set(key, t);
  }
  return t;
}

function lookup(t: Float32Array, v: number): number {
  const x = (v < 0 ? 0 : v > 1 ? 1 : v) * TABLE_STEPS;
  const i = x | 0;
  const lo = t[i] ?? 0;
  return lo + ((t[i + 1] ?? 0) - lo) * (x - i);
}

/**
 * Tabelle für 8-Bit-Eingaben (sRGB, vormultipliziert) → vormultiplizierter Wert im Raum `space`.
 * Index: `alpha8 · 256 + wert8`.
 *
 * @example
 * ```ts
 * const t = decodeTable('linear');
 * t[(255 << 8) | 128]; // ≈ 0.216
 * ```
 */
export function decodeTable(space: ColorSpace): Float32Array {
  let t = decodeTables.get(space);
  if (t === undefined) {
    t = new Float32Array(65536);
    for (let a8 = 1; a8 < 256; a8++) {
      const a = a8 / 255;
      for (let v8 = 0; v8 < 256; v8++) {
        // sRGB bleibt exakt: kein Umweg über lineares Licht.
        t[a8 * 256 + v8] = space === 'srgb' ? Math.min(v8, a8) / 255 : encodeTransfer(srgbToLinear(Math.min(1, v8 / a8)), space) * a;
      }
    }
    decodeTables.set(space, t);
  }
  return t;
}

function sizeError(what: string, image: { width: number; height: number; data: { length: number } }): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_COMPOSITOR_IMAGE_SIZE',
    errorClass: 'CompositorError',
    problem: `${what} has ${String(image.data.length)} values, expected ${String(image.width * image.height * 4)} for ${String(image.width)}x${String(image.height)}.`,
    suggestions: ['Pass RGBA data with exactly width * height * 4 values.'],
  });
}

/**
 * Prüft, dass die Datenlänge zu den Maßen passt.
 *
 * @example
 * ```ts
 * assertImage({ width: 1, height: 1, data: new Uint8Array(4) }, 'Layer image');
 * ```
 */
export function assertImage(image: RgbaImage | FloatImage, what: string): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 0 || image.height < 0 || image.data.length !== image.width * image.height * 4) {
    throw sizeError(what, image);
  }
}

/**
 * Wandelt ein 8-Bit-Bild (sRGB-kodiert, vormultipliziert) in ein Float-Bild im Raum `space`.
 * Deckende Pixel nutzen eine Tabelle; halbtransparente werden exakt gerechnet.
 *
 * @example
 * ```ts
 * const linear = rgbaToFloat(layer, 'linear');
 * ```
 */
export function rgbaToFloat(image: RgbaImage, space: ColorSpace): FloatImage {
  assertImage(image, 'Image');
  const src = image.data;
  const out = new Float32Array(src.length);
  const t = decodeTable(space);
  const k = 1 / 255;
  for (let i = 0; i < src.length; i += 4) {
    const a8 = src[i + 3] ?? 0;
    if (a8 === 0) continue;
    const row = a8 << 8;
    out[i] = t[row | (src[i] ?? 0)] ?? 0;
    out[i + 1] = t[row | (src[i + 1] ?? 0)] ?? 0;
    out[i + 2] = t[row | (src[i + 2] ?? 0)] ?? 0;
    out[i + 3] = a8 * k;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Wandelt ein Float-Bild im Raum `from` in ein 8-Bit-Bild mit Kodierung `to`
 * (vormultipliziert). Werte werden auf 0..1 begrenzt und gerundet.
 *
 * @example
 * ```ts
 * const frame = floatToRgba(linear, 'linear', 'srgb');
 * ```
 */
export function floatToRgba(image: FloatImage, from: ColorSpace, to: ColorSpace): RgbaImage {
  const src = image.data;
  const out = new Uint8Array(src.length);
  if (from === to) {
    for (let i = 0; i < src.length; i += 4) {
      let a = src[i + 3] ?? 0;
      if (!(a > 0)) continue;
      if (a > 1) a = 1;
      let v = src[i] ?? 0;
      out[i] = ((v < 0 ? 0 : v > a ? a : v) * 255 + 0.5) | 0;
      v = src[i + 1] ?? 0;
      out[i + 1] = ((v < 0 ? 0 : v > a ? a : v) * 255 + 0.5) | 0;
      v = src[i + 2] ?? 0;
      out[i + 2] = ((v < 0 ? 0 : v > a ? a : v) * 255 + 0.5) | 0;
      out[i + 3] = (a * 255 + 0.5) | 0;
    }
    return { width: image.width, height: image.height, data: out };
  }
  const t = transferTable(from, to);
  for (let i = 0; i < src.length; i += 4) {
    let a = src[i + 3] ?? 0;
    if (!(a > 0)) continue;
    if (a > 1) a = 1;
    const inv = 1 / a;
    const f = a * 255;
    out[i] = (lookup(t, (src[i] ?? 0) * inv) * f + 0.5) | 0;
    out[i + 1] = (lookup(t, (src[i + 1] ?? 0) * inv) * f + 0.5) | 0;
    out[i + 2] = (lookup(t, (src[i + 2] ?? 0) * inv) * f + 0.5) | 0;
    out[i + 3] = (f + 0.5) | 0;
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Wandelt ein Float-Bild zwischen zwei Räumen (in place); vormultipliziert.
 *
 * @example
 * ```ts
 * convertFloatInPlace(img, 'srgb', 'linear');
 * ```
 */
export function convertFloatInPlace(image: FloatImage, from: ColorSpace, to: ColorSpace): void {
  if (from === to) return;
  const t = transferTable(from, to);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    if (a <= 0) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) d[i + c] = lookup(t, (d[i + c] ?? 0) / a) * a;
  }
}

/**
 * Begrenzt auf 0..1.
 *
 * @example
 * ```ts
 * clamp01(1.2); // 1
 * ```
 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Kodiert ein 8-Bit-Bild (vormultipliziert) von einem Farbraum in einen anderen um.
 * Die Pixel werden entpremultipliziert, zu linearem Licht dekodiert, neu kodiert und
 * wieder vormultipliziert. Alpha bleibt unverändert.
 *
 * @example
 * ```ts
 * const linear = convertColorSpace(frame, 'srgb', 'linear');
 * const video = convertColorSpace(frame, 'srgb', 'rec709');
 * ```
 */
export function convertColorSpace(image: RgbaImage, from: ColorSpace, to: ColorSpace): RgbaImage {
  assertImage(image, 'Image');
  if (from === to) return { width: image.width, height: image.height, data: image.data.slice() };
  const src = image.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a8 = src[i + 3] ?? 0;
    if (a8 === 0) continue;
    const a = a8 / 255;
    for (let c = 0; c < 3; c++) {
      const straight = Math.min(1, (src[i + c] ?? 0) / 255 / a);
      out[i + c] = Math.round(Math.min(clamp01(transfer(straight, from, to)) * a, a) * 255);
    }
    out[i + 3] = a8;
  }
  return { width: image.width, height: image.height, data: out };
}
