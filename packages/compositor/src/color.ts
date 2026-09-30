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

/** Rechteck in Pixeln (`x1`, `y1` exklusiv), außerhalb dessen ein Bild nur Nullen enthält. */
export interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

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

/** Byte-Reihenfolge der Plattform (für 32-Bit-Schreibzugriffe auf RGBA). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

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
 * // Nur eine Region hat Inhalt (Rest ist 0): nur dort umrechnen.
 * const part = floatToRgba(linear, 'linear', 'srgb', { x0: 0, y0: 0, x1: 64, y1: 64 });
 * ```
 */
export function floatToRgba(image: FloatImage, from: ColorSpace, to: ColorSpace, region?: Bounds): RgbaImage {
  const src = image.data;
  const out = new Uint8Array(src.length);
  const w = image.width;
  // Außerhalb der Region sind alle Kanäle 0 (Story 18.1); dort bleibt `out` 0 wie bei `!(a > 0)`.
  const y0 = region?.y0 ?? 0;
  const y1 = region?.y1 ?? image.height;
  const x0 = region?.x0 ?? 0;
  const x1 = region?.x1 ?? w;
  // Ein 32-Bit-Wort je Pixel schreiben (Little Endian: R im niedrigsten Byte).
  const words = LITTLE_ENDIAN ? new Uint32Array(out.buffer, out.byteOffset, out.length >> 2) : undefined;
  const t = from === to ? undefined : transferTable(from, to);
  for (let y = y0; y < y1; y++) {
    for (let p = y * w + x0, end = y * w + x1; p < end; p++) {
      const i = p * 4;
      let a = src[i + 3] ?? 0;
      if (!(a > 0)) continue;
      if (a > 1) a = 1;
      let r: number;
      let g: number;
      let b: number;
      let a8: number;
      if (t === undefined) {
        let v = src[i] ?? 0;
        r = ((v < 0 ? 0 : v > a ? a : v) * 255 + 0.5) | 0;
        v = src[i + 1] ?? 0;
        g = ((v < 0 ? 0 : v > a ? a : v) * 255 + 0.5) | 0;
        v = src[i + 2] ?? 0;
        b = ((v < 0 ? 0 : v > a ? a : v) * 255 + 0.5) | 0;
        a8 = (a * 255 + 0.5) | 0;
      } else {
        const inv = 1 / a;
        const f = a * 255;
        r = (lookup(t, (src[i] ?? 0) * inv) * f + 0.5) | 0;
        g = (lookup(t, (src[i + 1] ?? 0) * inv) * f + 0.5) | 0;
        b = (lookup(t, (src[i + 2] ?? 0) * inv) * f + 0.5) | 0;
        a8 = (f + 0.5) | 0;
      }
      if (words !== undefined) words[p] = (r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a8 & 255) << 24);
      else {
        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
        out[i + 3] = a8;
      }
    }
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Wandelt ein Float-Bild zwischen zwei Räumen (in place); vormultipliziert.
 *
 * @example
 * ```ts
 * convertFloatInPlace(img, 'srgb', 'linear');
 * convertFloatInPlace(img, 'linear', 'srgb', { x0: 0, y0: 0, x1: 64, y1: 64 }); // nur die Region
 * ```
 */
export function convertFloatInPlace(image: FloatImage, from: ColorSpace, to: ColorSpace, region?: Bounds): void {
  if (from === to) return;
  const t = transferTable(from, to);
  const d = image.data;
  const w = image.width;
  const y0 = region?.y0 ?? 0;
  const y1 = region?.y1 ?? image.height;
  for (let y = y0; y < y1; y++) {
    const start = region === undefined ? y * w * 4 : (y * w + region.x0) * 4;
    const end = region === undefined ? (y + 1) * w * 4 : (y * w + region.x1) * 4;
    for (let i = start; i < end; i += 4) {
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

/**
 * Komponiert nur 8-Bit-Bildlayer (`normal`) über einen Hintergrund und kodiert direkt in 8 Bit
 * (Story 18.1): ein Durchlauf je Pixel über alle Layer, ohne Float-Zwischenbild in Ausgabegröße.
 * Jede Zwischensumme wird wie beim Speichern in ein Float32-Bild mit `Math.fround` gerundet;
 * das Ergebnis ist bitgleich zu Hintergrund füllen → je Layer mischen → {@link floatToRgba}.
 * `background` enthält die vormultiplizierten Werte im Arbeitsraum `space` (Float32-gerundet).
 *
 * @example
 * ```ts
 * const frame = flattenImageLayers([layer], [0, 0, 0, 0], 'srgb', 'srgb', 1920, 1080);
 * ```
 */
export function flattenImageLayers(layers: readonly RgbaImage[], background: readonly [number, number, number, number], space: ColorSpace, to: ColorSpace, width: number, height: number): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  const words = LITTLE_ENDIAN ? new Uint32Array(out.buffer, out.byteOffset, out.length >> 2) : undefined;
  const table = decodeTable(space);
  const t = space === to ? undefined : transferTable(space, to);
  const k = 1 / 255;
  const [bgR, bgG, bgB, bgA] = background;
  const only = layers.length === 1 ? layers[0] : undefined;
  if (only !== undefined && words !== undefined) {
    // Ein Layer: Das Ergebnis eines Kanals hängt nur von (Alpha, Wert) des Layers ab. Tabellen je
    // Kanal (65 536 Einträge, einmal je Frame mit derselben Rechnung wie unten) ersetzen die
    // Float-Rechnung je Pixel.
    const shift = [0, 8, 16] as const;
    const bgc = [bgR, bgG, bgB] as const;
    const luts = shift.map(() => new Uint32Array(65536));
    const alphaLut = new Uint32Array(256);
    for (let a8 = 0; a8 < 256; a8++) {
      let a = bgA;
      if (a8 === 255) a = 1;
      else if (a8 !== 0) a = Math.fround(a8 * k + bgA * (1 - a8 * k));
      if (!(a > 0)) continue;
      if (a > 1) a = 1;
      alphaLut[a8] = ((((a * 255 + 0.5) | 0) & 255) << 24) >>> 0;
      const row = a8 << 8;
      for (let c = 0; c < 3; c++) {
        const lut = luts[c];
        const base = bgc[c] ?? 0;
        if (lut === undefined) continue;
        for (let v = 0; v < 256; v++) {
          let x = base;
          if (a8 === 255) x = table[row | v] ?? 0;
          else if (a8 !== 0) x = Math.fround((table[row | v] ?? 0) + base * (1 - a8 * k));
          const b8 = t === undefined ? ((x < 0 ? 0 : x > a ? a : x) * 255 + 0.5) | 0 : (lookup(t, x * (1 / a)) * (a * 255) + 0.5) | 0;
          lut[row | v] = ((b8 & 255) << (shift[c] ?? 0)) >>> 0;
        }
      }
    }
    const [lr, lg, lb] = luts;
    const s = only.data;
    if (lr === undefined || lg === undefined || lb === undefined) return { width, height, data: out };
    const n = width * height;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a8 = s[i + 3] ?? 0;
      const row = a8 << 8;
      words[p] = (lr[row | (s[i] ?? 0)] ?? 0) | (lg[row | (s[i + 1] ?? 0)] ?? 0) | (lb[row | (s[i + 2] ?? 0)] ?? 0) | (alphaLut[a8] ?? 0);
    }
    return { width, height, data: out };
  }
  const sources = layers.map((l) => l.data);
  const count = sources.length;
  const n = width * height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    let r = bgR;
    let g = bgG;
    let b = bgB;
    let a = bgA;
    for (let l = 0; l < count; l++) {
      const s = sources[l];
      if (s === undefined) continue;
      const a8 = s[i + 3] ?? 0;
      if (a8 === 0) continue;
      const row = a8 << 8;
      const lr = table[row | (s[i] ?? 0)] ?? 0;
      const lg = table[row | (s[i + 1] ?? 0)] ?? 0;
      const lb = table[row | (s[i + 2] ?? 0)] ?? 0;
      if (a8 === 255) {
        r = lr;
        g = lg;
        b = lb;
        a = 1;
        continue;
      }
      const inv = 1 - a8 * k;
      r = Math.fround(lr + r * inv);
      g = Math.fround(lg + g * inv);
      b = Math.fround(lb + b * inv);
      a = Math.fround(a8 * k + a * inv);
    }
    if (!(a > 0)) continue;
    if (a > 1) a = 1;
    let r8: number;
    let g8: number;
    let b8: number;
    let a8: number;
    if (t === undefined) {
      r8 = ((r < 0 ? 0 : r > a ? a : r) * 255 + 0.5) | 0;
      g8 = ((g < 0 ? 0 : g > a ? a : g) * 255 + 0.5) | 0;
      b8 = ((b < 0 ? 0 : b > a ? a : b) * 255 + 0.5) | 0;
      a8 = (a * 255 + 0.5) | 0;
    } else {
      const inv = 1 / a;
      const f = a * 255;
      r8 = (lookup(t, r * inv) * f + 0.5) | 0;
      g8 = (lookup(t, g * inv) * f + 0.5) | 0;
      b8 = (lookup(t, b * inv) * f + 0.5) | 0;
      a8 = (f + 0.5) | 0;
    }
    if (words !== undefined) words[p] = (r8 & 255) | ((g8 & 255) << 8) | ((b8 & 255) << 16) | ((a8 & 255) << 24);
    else {
      out[i] = r8;
      out[i + 1] = g8;
      out[i + 2] = b8;
      out[i + 3] = a8;
    }
  }
  return { width, height, data: out };
}
