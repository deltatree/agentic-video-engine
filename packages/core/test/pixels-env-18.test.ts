/**
 * Story 18.9: Pixel-Hilfen einmal in core (bitgleich zu den früheren Kopien in png und ffmpeg),
 * feste Segmenter-Locale; Story 16.5: minimale Umgebung für Kindprozesse.
 */
import { describe, expect, it } from 'vitest';
import { minimalChildEnv, premultiplyInPlace, splitTextUnits, unpremultiplyInto } from '@agentic-video/core';

describe('Pixel-Hilfen (Story 18.9)', () => {
  it('vormultiplizieren bitgleich zu round(c · a / 255) für alle Werte', () => {
    const data = new Uint8Array(256 * 256 * 4);
    for (let a = 0; a < 256; a++) for (let c = 0; c < 256; c++) data.set([c, 255 - c, (c * 7) % 256, a], (a * 256 + c) * 4);
    const expected = Uint8Array.from(data, (v, i) => {
      const a = data[i - (i % 4) + 3] ?? 0;
      if (i % 4 === 3) return v;
      return a === 0 ? 0 : Math.round((v * a) / 255);
    });
    expect(Buffer.from(premultiplyInPlace(data)).equals(Buffer.from(expected))).toBe(true);
  });

  it('entmultiplizieren bitgleich zu min(255, round(c · 255 / a)) für alle Werte', () => {
    const data = new Uint8Array(256 * 256 * 4);
    for (let a = 0; a < 256; a++) for (let c = 0; c < 256; c++) data.set([c, c >> 1, 255 - c, a], (a * 256 + c) * 4);
    const expected = Uint8Array.from(data, (v, i) => {
      const a = data[i - (i % 4) + 3] ?? 0;
      if (i % 4 === 3) return v;
      return a === 0 ? 0 : a === 255 ? v : Math.min(255, Math.round((v * 255) / a));
    });
    const out = unpremultiplyInto(data, new Uint8Array(data.length));
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
    // In place (out = data) liefert dasselbe.
    expect(Buffer.from(unpremultiplyInto(data, data)).equals(Buffer.from(expected))).toBe(true);
  });
});

describe('Segmenter-Locale (Story 18.9)', () => {
  it('zerlegt Grapheme unabhängig von der Systemsprache', () => {
    expect(splitTextUnits('ǅe👩‍👩‍👧x', 'char')).toEqual(['ǅ', 'e', '👩‍👩‍👧', 'x']);
  });
});

describe('minimale Kindprozess-Umgebung (Story 16.5)', () => {
  it('übernimmt nur erlaubte Namen und Präfixe', () => {
    const env = { PATH: '/usr/bin', HOME: '/h', OPENVIDEO_WORKER_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'x', CUDA_VISIBLE_DEVICES: '0', PYTHONPATH: '/p', EMPTY: undefined };
    expect(minimalChildEnv(env)).toEqual({ PATH: '/usr/bin', HOME: '/h' });
    expect(minimalChildEnv(env, { names: ['PYTHONPATH'], prefixes: ['CUDA_'] })).toEqual({ PATH: '/usr/bin', HOME: '/h', PYTHONPATH: '/p', CUDA_VISIBLE_DEVICES: '0' });
  });
});
