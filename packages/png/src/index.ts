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
import { deflate, deflateSync, inflate, inflateSync, constants } from 'node:zlib';
import { OpenVideoError, premultiplyInPlace, unpremultiplyInto, type RgbaImage } from '@agentic-video/core';

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

/**
 * Wandelt vormultipliziertes RGBA in gerades RGBA um (neuer Puffer). Rechnet mit der
 * gemeinsamen Pixel-Hilfe aus `@agentic-video/core` (Story 18.9).
 *
 * @example
 * ```ts
 * unpremultiply(new Uint8Array([100, 50, 25, 128])); // [199, 100, 50, 128]
 * ```
 */
export function unpremultiply(data: Uint8Array): Uint8Array {
  return unpremultiplyInto(data, new Uint8Array(data.length));
}

/**
 * Wandelt gerades RGBA in vormultipliziertes RGBA um (neuer Puffer). Für eigene Puffer ohne
 * Kopie: `premultiplyInPlace` aus `@agentic-video/core`.
 *
 * @example
 * ```ts
 * premultiply(new Uint8Array([200, 100, 50, 128])); // [100, 50, 25, 128]
 * ```
 */
export function premultiply(data: Uint8Array): Uint8Array {
  return premultiplyInPlace(new Uint8Array(data));
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
  if (colorType === 6 && bitDepth === 8) return { width, height, data: premultiplyInPlace(unfilterRgba8(inflated, width, height)) };
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
  return { width, height, data: premultiplyInPlace(out) };
}

/**
 * Schneller Pfad für 8-Bit-RGBA (Story 18.4, Chromium-Screenshots): Zeilenfilter direkt in den
 * Ausgabepuffer rückgängig machen (vorige Zeile = Ausgabe der Zeile darüber), ohne Kopien je Zeile.
 * Ergebnis gleich dem allgemeinen Pfad.
 */
function unfilterRgba8(inflated: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  if (inflated.length < (stride + 1) * height) throw pngError('PNG image data is truncated.');
  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1) + 1;
    const filter = inflated[src - 1] ?? 0;
    const row = y * stride;
    const up = row - stride;
    switch (filter) {
      case 0:
        out.set(inflated.subarray(src, src + stride), row);
        break;
      case 1:
        for (let x = 0; x < stride; x++) out[row + x] = ((inflated[src + x] ?? 0) + (x >= 4 ? (out[row + x - 4] ?? 0) : 0)) & 0xff;
        break;
      case 2:
        if (y === 0) out.set(inflated.subarray(src, src + stride), row);
        else for (let x = 0; x < stride; x++) out[row + x] = ((inflated[src + x] ?? 0) + (out[up + x] ?? 0)) & 0xff;
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const a = x >= 4 ? (out[row + x - 4] ?? 0) : 0;
          const b = y > 0 ? (out[up + x] ?? 0) : 0;
          out[row + x] = ((inflated[src + x] ?? 0) + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const a = x >= 4 ? (out[row + x - 4] ?? 0) : 0;
          const b = y > 0 ? (out[up + x] ?? 0) : 0;
          const c = x >= 4 && y > 0 ? (out[up + x - 4] ?? 0) : 0;
          out[row + x] = ((inflated[src + x] ?? 0) + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw pngError(`Invalid PNG filter ${String(filter)}.`);
    }
  }
  return out;
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
  const body = deflateSync(image.data, { level });
  return concat([rawHeader(image), new Uint8Array(body.buffer, body.byteOffset, body.byteLength)]);
}

function rawHeader(image: RgbaImage, magic = RAW_MAGIC, extra = 0): Uint8Array {
  const header = new Uint8Array(12 + extra);
  const view = new DataView(header.buffer);
  for (let i = 0; i < 4; i++) header[i] = magic.charCodeAt(i);
  view.setUint32(4, image.width);
  view.setUint32(8, image.height);
  return header;
}

/** Rohformat mit mehreren unabhängig komprimierten Abschnitten (parallel kodierbar). */
const RAW_CHUNKED_MAGIC = 'OVRC';
/** Abschnitte je Frame; Node rechnet standardmäßig vier zlib-Aufträge gleichzeitig. */
const RAW_CHUNKS = 4;

function deflateAsync(data: Uint8Array, level: number): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    deflate(data, { level }, (error, body) => {
      if (error !== null) {
        reject(pngError(`Compressing a raw frame failed: ${error.message}`));
        return;
      }
      resolvePromise(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    });
  });
}

/**
 * Wie {@link encodeRawFrame}, aber die Kompression läuft im Thread-Pool von Node, in vier
 * Abschnitten gleichzeitig (Kopf `OVRC`). Der Haupt-Thread rechnet derweil weiter,
 * z. B. im Compositor. {@link decodeRawFrame} liest beide Formate; die Pixel sind bitgleich.
 *
 * @example
 * ```ts
 * const bytes = await encodeRawFrameAsync(image);
 * const back = decodeRawFrame(bytes); // bitgleich
 * ```
 */
export async function encodeRawFrameAsync(image: RgbaImage, level = 1): Promise<Uint8Array> {
  const data = image.data;
  const count = data.length >= RAW_CHUNKS * 4096 ? RAW_CHUNKS : 1;
  const step = Math.ceil(data.length / count);
  const bodies = await Promise.all(Array.from({ length: count }, (_, i) => deflateAsync(data.subarray(i * step, Math.min(data.length, (i + 1) * step)), level)));
  // Kopf: Magic, Breite, Höhe, Anzahl der Abschnitte, dann die Länge jedes Abschnitts.
  const header = rawHeader(image, RAW_CHUNKED_MAGIC, 4 + 4 * count);
  const view = new DataView(header.buffer);
  view.setUint32(12, count);
  bodies.forEach((b, i) => {
    view.setUint32(16 + 4 * i, b.byteLength);
  });
  return concat([header, ...bodies]);
}

function inflateAsync(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    inflate(data, (error, body) => {
      if (error !== null) {
        reject(pngError(`Decompressing a raw frame failed: ${error.message}`));
        return;
      }
      resolvePromise(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    });
  });
}

/**
 * Wie {@link decodeRawFrame}, aber das Entpacken läuft im Thread-Pool von Node (Story 18.6):
 * bei `OVRC` alle Abschnitte gleichzeitig, der Haupt-Thread bleibt frei (z. B. für den Encoder).
 *
 * @example
 * ```ts
 * const frame = await decodeRawFrameAsync(bytes);
 * ```
 */
export async function decodeRawFrameAsync(bytes: Uint8Array): Promise<RgbaImage> {
  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (magic !== RAW_MAGIC && magic !== RAW_CHUNKED_MAGIC) throw pngError('Not an OpenVideo raw frame.');
  if (bytes.length < 12) throw pngError('Raw frame is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  let parts: Uint8Array[];
  if (magic === RAW_MAGIC) parts = [await inflateAsync(bytes.subarray(12))];
  else {
    const count = bytes.length >= 16 ? view.getUint32(12) : 0;
    let offset = 16 + 4 * count;
    if (count === 0 || offset > bytes.length) throw pngError('Raw frame is truncated.');
    const slices: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const length = view.getUint32(16 + 4 * i);
      if (offset + length > bytes.length) throw pngError('Raw frame is truncated.');
      slices.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    parts = await Promise.all(slices.map(inflateAsync));
  }
  const data = parts.length === 1 ? (parts[0] ?? new Uint8Array()) : concat(parts);
  if (data.length !== width * height * 4) throw pngError('Raw frame is truncated.');
  return { width, height, data };
}

/** Dekodiert {@link encodeRawFrame} (`OVRF`) und {@link encodeRawFrameAsync} (`OVRC`). */
export function decodeRawFrame(bytes: Uint8Array): RgbaImage {
  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (magic !== RAW_MAGIC && magic !== RAW_CHUNKED_MAGIC) throw pngError('Not an OpenVideo raw frame.');
  if (bytes.length < 12) throw pngError('Raw frame is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(4);
  const height = view.getUint32(8);
  let data: Uint8Array;
  if (magic === RAW_MAGIC) {
    const body = inflateSync(bytes.subarray(12));
    data = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else {
    const count = bytes.length >= 16 ? view.getUint32(12) : 0;
    let offset = 16 + 4 * count;
    if (count === 0 || offset > bytes.length) throw pngError('Raw frame is truncated.');
    const parts: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const length = view.getUint32(16 + 4 * i);
      if (offset + length > bytes.length) throw pngError('Raw frame is truncated.');
      const body = inflateSync(bytes.subarray(offset, offset + length));
      parts.push(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      offset += length;
    }
    data = concat(parts);
  }
  if (data.length !== width * height * 4) throw pngError('Raw frame is truncated.');
  return { width, height, data };
}
