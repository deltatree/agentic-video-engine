/**
 * @packageDocumentation
 * PNG- und Rohbild-Kodierung für {@link RgbaImage} (vormultipliziertes RGBA, sRGB).
 *
 * - PNG speichert gerades (nicht vormultipliziertes) Alpha. Die Umwandlung ist bei
 *   halbtransparenten Pixeln verlustbehaftet; für den Frame-Cache gibt es daher das
 *   exakte Rohformat `OVRF`.
 * - Nutzt `node:zlib`; läuft nur in Node.
 *
 * @example
 * ```ts
 * import { encodePng, decodePng } from '@agentic-video/png';
 * const bytes = encodePng(image);
 * const back = decodePng(bytes);
 * ```
 */
import { deflateSync, inflateSync, constants } from 'node:zlib';
import { OpenVideoError, type RgbaImage } from '@agentic-video/core';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngError(problem: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_PNG_INVALID', errorClass: 'ImageError', problem, suggestions: ['Re-export the image as 8-bit RGBA PNG.'] });
}

/** Wandelt vormultipliziertes RGBA in gerades RGBA um (neuer Puffer). */
export function unpremultiply(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 255) {
      out[i] = data[i] ?? 0;
      out[i + 1] = data[i + 1] ?? 0;
      out[i + 2] = data[i + 2] ?? 0;
    } else if (a > 0) {
      out[i] = Math.min(255, Math.round(((data[i] ?? 0) * 255) / a));
      out[i + 1] = Math.min(255, Math.round(((data[i + 1] ?? 0) * 255) / a));
      out[i + 2] = Math.min(255, Math.round(((data[i + 2] ?? 0) * 255) / a));
    }
    out[i + 3] = a;
  }
  return out;
}

/** Wandelt gerades RGBA in vormultipliziertes RGBA um (neuer Puffer). */
export function premultiply(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 255) {
      out[i] = data[i] ?? 0;
      out[i + 1] = data[i + 1] ?? 0;
      out[i + 2] = data[i + 2] ?? 0;
    } else if (a > 0) {
      out[i] = Math.round(((data[i] ?? 0) * a) / 255);
      out[i + 1] = Math.round(((data[i + 1] ?? 0) * a) / 255);
      out[i + 2] = Math.round(((data[i + 2] ?? 0) * a) / 255);
    }
    out[i + 3] = a;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Optionen für {@link encodePng}. */
export interface EncodePngOptions {
  /** zlib-Stufe 0–9. Standard 6. */
  readonly level?: number;
  /** Eingabe ist bereits gerades Alpha. Standard: vormultipliziert. */
  readonly straightAlpha?: boolean;
}

/**
 * Kodiert ein Bild als 8-Bit-RGBA-PNG mit sRGB-Chunk. Deterministisch.
 *
 * @example
 * ```ts
 * writeFileSync('frame.png', encodePng(image));
 * ```
 */
export function encodePng(image: RgbaImage, options: EncodePngOptions = {}): Uint8Array {
  const { width, height } = image;
  if (image.data.length !== width * height * 4) throw pngError(`Image data has ${String(image.data.length)} bytes, expected ${String(width * height * 4)}.`);
  const pixels = options.straightAlpha === true ? image.data : unpremultiply(image.data);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1; // Filter „Sub“
    const src = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? (pixels[src + x - 4] ?? 0) : 0;
      raw[row + 1 + x] = ((pixels[src + x] ?? 0) - left) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(raw, { level: options.level ?? 6, strategy: constants.Z_FILTERED });
  return concat([SIGNATURE, chunk('IHDR', ihdr), chunk('sRGB', new Uint8Array([0])), chunk('IDAT', new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)), chunk('IEND', new Uint8Array(0))]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Ergebnis von {@link decodePngInfo}. */
export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
}

/** Liest nur die Maße und das Format eines PNG. */
export function decodePngInfo(bytes: Uint8Array): PngInfo {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw pngError('Not a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: bytes[24] ?? 0, colorType: bytes[25] ?? 0 };
}

/**
 * Dekodiert ein PNG (Graustufen, RGB, RGBA, Palette; 8 oder 16 Bit; ohne Interlacing)
 * in ein vormultipliziertes {@link RgbaImage}.
 *
 * @example
 * ```ts
 * const image = decodePng(readFileSync('logo.png'));
 * ```
 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  const info = decodePngInfo(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  let interlace = 0;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') interlace = data[12] ?? 0;
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (interlace !== 0) throw pngError('Interlaced PNG is not supported.');
  const { width, height, bitDepth, colorType } = info;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0 || (bitDepth !== 8 && bitDepth !== 16 && !(colorType === 3 && bitDepth <= 8))) throw pngError(`Unsupported PNG format (color type ${String(colorType)}, bit depth ${String(bitDepth)}).`);
  const inflated = inflateSync(concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart] ?? 0;
    for (let x = 0; x < stride; x++) {
      const v = inflated[rowStart + 1 + x] ?? 0;
      const a = x >= bpp ? (cur[x - bpp] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw pngError(`Invalid PNG filter ${String(filter)}.`);
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const sample = (i: number): number => (bitDepth === 16 ? (cur[(x * channels + i) * 2] ?? 0) : (cur[x * channels + i] ?? 0));
      if (colorType === 3) {
        const bits = bitDepth;
        const byte = cur[(x * bits) >> 3] ?? 0;
        const index = (byte >> (8 - bits - ((x * bits) & 7))) & ((1 << bits) - 1);
        out[o] = palette?.[index * 3] ?? 0;
        out[o + 1] = palette?.[index * 3 + 1] ?? 0;
        out[o + 2] = palette?.[index * 3 + 2] ?? 0;
        out[o + 3] = trns?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(0);
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = colorType === 4 ? sample(1) : 255;
      } else {
        out[o] = sample(0);
        out[o + 1] = sample(1);
        out[o + 2] = sample(2);
        out[o + 3] = colorType === 6 ? sample(3) : 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, data: premultiply(out) };
}

const RAW_MAGIC = 'OVRF';

/**
 * Exaktes, verlustfreies Rohformat für den Frame-Cache: Kopf `OVRF`, Breite, Höhe,
 * danach die vormultiplizierten Pixel, mit zlib komprimiert.
 *
 * @example
 * ```ts
 * const back = decodeRawFrame(encodeRawFrame(image)); // bitgleich
 * ```
 */
export function encodeRawFrame(image: RgbaImage, level = 1): Uint8Array {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  for (let i = 0; i < 4; i++) header[i] = RAW_MAGIC.charCodeAt(i);
  view.setUint32(4, image.width);
  view.setUint32(8, image.height);
  const body = deflateSync(image.data, { level });
  return concat([header, new Uint8Array(body.buffer, body.byteOffset, body.byteLength)]);
}

/** Dekodiert {@link encodeRawFrame}. */
export function decodeRawFrame(bytes: Uint8Array): RgbaImage {
  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (magic !== RAW_MAGIC) throw pngError('Not an OpenVideo raw frame.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  const body = inflateSync(bytes.subarray(12));
  const data = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (data.length !== width * height * 4) throw pngError('Raw frame is truncated.');
  return { width, height, data };
}
