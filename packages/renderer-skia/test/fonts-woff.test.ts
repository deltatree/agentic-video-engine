/**
 * Story 17.9: Schriften aus WOFF2 zeichnen exakt wie die TTF-Datei, aus der sie stammen.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadFontSet } from '@agentic-video/fonts';
import { createSkiaBackend } from '@agentic-video/renderer-skia';
import { HEBREW_FONT, canvasKit, hash, here, n, request } from './helpers.js';

const WOFF2 = join(here, '../../fonts/test/fixtures/noto-sans-hebrew/NotoSansHebrew-Regular.woff2');

describe('WOFF2-Schriften in Skia (Story 17.9)', () => {
  it('rendert Text aus WOFF2 bitgleich zur TTF-Quelle', async () => {
    const fonts = await loadFontSet({ includeDefaults: false, fonts: [{ family: 'From TTF', src: HEBREW_FONT }, { family: 'From WOFF2', src: WOFF2 }] });
    expect(fonts.diagnostics).toEqual([]);
    const skia = createSkiaBackend({ canvasKit: await canvasKit(), fonts });
    const text = (family: string) => [n('text', { text: 'שלום עולם', fontFamily: family, fontSize: 40, fill: '#FFFFFF', x: 10, y: 10 })];
    const base = await request(text('From TTF'), { width: 240, height: 80 });
    const ttf = await skia.renderLayer({ ...base, fonts });
    const woff2 = await skia.renderLayer({ ...(await request(text('From WOFF2'), { width: 240, height: 80 })), fonts });
    expect(ttf.data.some((v) => v > 0)).toBe(true);
    expect(hash(woff2)).toBe(hash(ttf));
    await skia.dispose();
  });
});
