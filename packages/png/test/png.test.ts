import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, decodeRawFrame, encodePng, encodeRawFrame, premultiply, unpremultiply } from '@agentic-video/png';

function opaqueImage(width: number, height: number, seed: number) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + seed * 7) % 256;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

describe('PNG', () => {
  it('kodiert und dekodiert deckende Bilder verlustfrei', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 1000 }), (w, h, seed) => {
        const img = opaqueImage(w, h, seed);
        expect(decodePng(encodePng(img))).toEqual(img);
      }),
      { numRuns: 50 },
    );
  });

  it('erhält vormultiplizierte Pixel ohne Rundungsfehler beim Rückweg', () => {
    const straight = new Uint8Array([200, 100, 50, 128, 0, 0, 0, 0, 255, 255, 255, 1]);
    const pre = premultiply(straight);
    expect(pre).toEqual(new Uint8Array([100, 50, 25, 128, 0, 0, 0, 0, 1, 1, 1, 1]));
    expect(unpremultiply(pre)[0]).toBe(199);
  });

  it('ist lesbar für FFmpeg und liest FFmpeg-PNGs', () => {
    const ffmpeg = join(process.env['HOME'] ?? '', '.local/bin/ffmpeg');
    if (!existsSync(ffmpeg)) throw new Error('FFmpeg fehlt: Test braucht ~/.local/bin/ffmpeg');
    const dir = mkdtempSync(join(tmpdir(), 'ov-png-'));
    const img = opaqueImage(16, 8, 3);
    writeFileSync(join(dir, 'a.png'), encodePng(img));
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', join(dir, 'a.png'), '-pix_fmt', 'rgb24', join(dir, 'b.png')]);
    const back = decodePng(readFileSync(join(dir, 'b.png')));
    expect(back.width).toBe(16);
    expect(Array.from(back.data.subarray(0, 8))).toEqual(Array.from(img.data.subarray(0, 8)));
    execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x336699@0.5:s=4x2,format=rgba', '-frames:v', '1', join(dir, 'c.png')]);
    const c = decodePng(readFileSync(join(dir, 'c.png')));
    expect(c.data[3]).toBe(127); // FFmpeg rundet 0,5 · 255 ab
  });
});

describe('Rohformat', () => {
  it('ist bitgleich', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (data) => {
        const img = { width: 4, height: 4, data };
        expect(decodeRawFrame(encodeRawFrame(img))).toEqual(img);
      }),
    );
  });
});
