/**
 * Story 18.4: schneller Decode für 8-Bit-RGBA (alle Zeilenfilter) mit Premultiply in place;
 * Story 18.6: asynchrones Entpacken des Rohformats.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng, decodeRawFrame, decodeRawFrameAsync, encodeRawFrame, encodeRawFrameAsync, premultiply } from '@agentic-video/png';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = (CRC[(c ^ (out[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Kodiert gerades RGBA als PNG; Zeile y nutzt Filter y % 5 (0 None … 4 Paeth). */
function pngWithAllFilters(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x] ?? 0;
      const a = x >= 4 ? (rgba[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[(y - 1) * stride + x - 4] ?? 0) : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('schneller RGBA-Decode (Story 18.4)', () => {
  it('dekodiert alle fünf Zeilenfilter und vormultipliziert wie premultiply()', () => {
    const width = 13;
    const height = 11;
    const rgba = new Uint8Array(width * height * 4).map((_, i) => (i * 37 + (i >> 5) * 11) % 256);
    const image = decodePng(pngWithAllFilters(width, height, rgba));
    expect(image.width).toBe(width);
    expect(Buffer.from(image.data).equals(Buffer.from(premultiply(rgba)))).toBe(true);
  });
});

describe('asynchrones Rohformat (Story 18.6)', () => {
  it('decodeRawFrameAsync liefert dieselben Pixel wie decodeRawFrame (OVRF und OVRC)', async () => {
    const image = { width: 64, height: 40, data: new Uint8Array(64 * 40 * 4).map((_, i) => (i * 13) % 256) };
    for (const bytes of [encodeRawFrame(image), await encodeRawFrameAsync(image)]) {
      const sync = decodeRawFrame(bytes);
      const parallel = await decodeRawFrameAsync(bytes);
      expect(parallel.width).toBe(64);
      expect(Buffer.from(parallel.data).equals(Buffer.from(sync.data))).toBe(true);
    }
    await expect(decodeRawFrameAsync(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/raw frame/u);
  });
});
