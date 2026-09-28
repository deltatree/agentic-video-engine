import { describe, expect, it } from 'vitest';
import { computeBounds, isOpenVideoError } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createSkiaBackend, createSkiaTextMeasurer, decodeImage } from '@agentic-video/renderer-skia';
import { asset, assets, backend, canvasKit, fonts, hash, n, pixel, render, request, scene } from './helpers.js';

describe('skia backend contract', () => {
  it('describes itself', async () => {
    const skia = await backend();
    expect(skia.id).toBe('skia');
    expect(skia.fusable).toBe(true);
    expect(skia.versions()).toEqual({ 'canvaskit-wasm': '0.42.0' });
    expect(skia.nodeTypes).toEqual(expect.arrayContaining(['group', 'rect', 'text', 'rich-text', 'svg', 'lottie', 'shader', 'particles', 'video', 'sprite']));
    expect(skia.capabilities).toEqual(expect.arrayContaining(['skia.text.shaping', 'skia.text.variable-fonts', 'skia.lottie', 'skia.sksl', 'skia.blend.all']));
  });

  it('renders an empty layer as a transparent image', async () => {
    const img = await render([], { width: 16, height: 8 });
    expect([img.width, img.height]).toEqual([16, 8]);
    expect(img.data.every((v) => v === 0)).toBe(true);
  });

  it('writes premultiplied sRGB pixels', async () => {
    const img = await render([n('rect', { width: 10, height: 10, fill: '#FF000080' })], { width: 10, height: 10 });
    const [r, g, b, a] = pixel(img, 5, 5);
    expect(Math.abs((r ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(g).toBe(0);
    expect(b).toBe(0);
    expect(Math.abs((a ?? 0) - 128)).toBeLessThanOrEqual(1);
  });

  it('scales the preview output', async () => {
    const nodes = [n('rect', { x: 20, y: 20, width: 40, height: 40, fill: '#00FF00' })];
    const full = await render(nodes, { width: 100, height: 100 });
    const half = await render(nodes, { width: 100, height: 100, scale: 0.5 });
    expect([half.width, half.height]).toEqual([50, 50]);
    expect(pixel(full, 30, 30)).toEqual([0, 255, 0, 255]);
    expect(pixel(half, 15, 15)).toEqual([0, 255, 0, 255]);
    expect(pixel(half, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(pixel(half, 35, 35)).toEqual([0, 0, 0, 0]);
  });

  it('is deterministic, also in reverse frame order', async () => {
    const frames = [0, 15, 30, 45];
    const build = (f: number) => [
      n('rect', { x: f, y: 10, width: 60, height: 40, fill: { type: 'linear', stops: [{ offset: 0, color: '#FF0080' }, { offset: 1, color: '#00C0FF' }] }, rotation: f, shadow: { color: '#00000080', blur: 4, offsetY: 3 } }, { frame: f }),
      n('text', { x: 10, y: 60, text: 'Hallo ffi 😀', fontSize: 24, textAnimation: { unit: 'char', stagger: 2, duration: 10, from: { opacity: 0, y: 20 } } }, { frame: f }),
      n('particles', { width: 160, height: 120, count: 40, seed: 3 }, { frame: f }),
    ];
    const skiaA = await backend();
    const forward: string[] = [];
    for (const f of frames) forward.push(hash(await render(build(f), { width: 160, height: 120, frame: f }, skiaA)));
    const skiaB = await backend();
    const backward: string[] = [];
    for (const f of [...frames].reverse()) backward.push(hash(await render(build(f), { width: 160, height: 120, frame: f }, skiaB)));
    expect(backward.reverse()).toEqual(forward);
    expect(new Set(forward).size).toBe(frames.length);
    expect(hash(await render(build(15), { width: 160, height: 120, frame: 15 }, skiaA))).toBe(forward[1]);
  });

  it('falls back to the default font and reports the missing family in check()', async () => {
    const skia = await backend();
    const withMissing = await render([n('text', { text: 'Fallback', fontFamily: 'Nope' })], { width: 240, height: 64 }, skia);
    const withInter = await render([n('text', { text: 'Fallback', fontFamily: 'Inter' })], { width: 240, height: 64 }, skia);
    expect(hash(withMissing)).toBe(hash(withInter));
    expect(withMissing.data.some((v) => v > 0)).toBe(true);
    const result = skia.check({ id: 'title', type: 'text', text: 'x', fontFamily: 'Nope' });
    expect(result.supported).toBe(true);
    expect(result.diagnostics[0]).toMatchObject({ code: 'OV_FONT_MISSING', nodeId: 'title', severity: 'warning' });
  });

  it('throws OV_ASSET_MISSING for unknown assets', async () => {
    const error = await render([n('image', { asset: 'x', width: 10, height: 10 })], { width: 10, height: 10 }).catch((e: unknown) => e);
    expect(isOpenVideoError(error)).toBe(true);
    expect(error).toMatchObject({ diagnostic: { code: 'OV_ASSET_MISSING', details: { asset: 'x' } } });
  });

  it('checks unsupported features', async () => {
    const skia = await backend();
    expect(skia.check({ id: 's', type: 'shader', width: 10, height: 10, glsl: 'void main(){}' })).toMatchObject({ supported: false, diagnostics: [{ code: 'OV_SKIA_UNSUPPORTED' }] });
    expect(skia.check({ id: 's', type: 'shader', width: 10, height: 10, glsl: 'void main(){}' }).diagnostics[0]?.suggestions.join(' ')).toMatch(/renderer: "pixi"/u);
    expect(skia.check({ id: 's', type: 'shader', width: 10, height: 10, sksl: 'half4 main(float2 p) { return oops; }' })).toMatchObject({ supported: false, diagnostics: [{ code: 'OV_SKIA_SHADER_INVALID' }] });
    expect(skia.check({ id: 's', type: 'shader', width: 10, height: 10, sksl: 'half4 main(float2 p) { return half4(1); }' })).toEqual({ supported: true, diagnostics: [] });
    expect(skia.check({ id: 'h', type: 'html', html: '<b>x</b>', width: 1, height: 1 })).toMatchObject({ supported: false, diagnostics: [{ code: 'OV_SKIA_UNSUPPORTED' }] });
    expect(skia.check({ id: 'v', type: 'svg', markup: '<svg><filter id="f"/><rect width="1" height="1"/><foreignObject/></svg>' })).toMatchObject({
      supported: true,
      diagnostics: [{ code: 'OV_SVG_UNSUPPORTED', severity: 'warning', details: { elements: 'filter,foreignObject' } }],
    });
  });

  it('reports invalid SkSL at render time', async () => {
    const error = await render([n('shader', { width: 10, height: 10, sksl: 'nope' })], { width: 10, height: 10 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ diagnostic: { code: 'OV_SKIA_SHADER_INVALID' } });
  });

  it('frees resources on dispose', async () => {
    const skia = createSkiaBackend({ canvasKit: await canvasKit(), fonts: await fonts() });
    await skia.renderLayer(await request([n('text', { text: 'x' })], { width: 10, height: 10 }));
    await expect(skia.dispose()).resolves.toBeUndefined();
  });
});

describe('text measurer', () => {
  it('measures width, lines, overflow, missing glyphs, baseline and background padding', async () => {
    const measurer = createSkiaTextMeasurer(await canvasKit(), await fonts());
    const one = measurer.measure(n('text', { text: 'Hello', fontSize: 40 }));
    expect(one.lines).toBe(1);
    expect(one.width).toBeGreaterThan(80);
    expect(one.height).toBeCloseTo(48, 0);
    expect(one.baseline).toBeGreaterThan(20);
    expect(one.baseline).toBeLessThan(one.height);
    expect(one.overflow).toBe(false);
    expect(one.missingGlyphs).toBe(0);
    const wrapped = measurer.measure(n('text', { text: 'one two three four five six', fontSize: 20, width: 80 }));
    expect(wrapped.lines).toBeGreaterThan(2);
    expect(wrapped.width).toBe(80);
    const limited = measurer.measure(n('text', { text: 'one two three four five six', fontSize: 20, width: 80, maxLines: 2, ellipsis: '…' }));
    expect(limited.lines).toBe(2);
    expect(limited.overflow).toBe(true);
    const missing = measurer.measure(n('text', { text: 'ab\u{10FFFD}', fontSize: 20 }));
    expect(missing.missingGlyphs).toBeGreaterThan(0);
    const padded = measurer.measure(n('text', { text: 'Hello', fontSize: 40, background: { color: '#000000', paddingX: 10, paddingY: 6 } }));
    expect(padded.width).toBeCloseTo(one.width + 20, 5);
    expect(padded.height).toBeCloseTo(one.height + 12, 5);
    expect(padded.baseline).toBeCloseTo(one.baseline + 6, 5);
    const s = scene([n('text', { id: 'label', x: 10, y: 20, text: 'Hello', fontSize: 40, background: { color: '#000000', paddingX: 10, paddingY: 6 } })], 400, 200);
    const bounds = computeBounds(s, measurer);
    expect(bounds[0]?.bounds.width).toBeCloseTo(padded.width, 5);
    measurer.dispose();
  });
});

describe('decodeImage', () => {
  it('decodes PNG into premultiplied RGBA', async () => {
    const src = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 64, 64, 0, 128]) };
    const img = decodeImage(await canvasKit(), encodePng(src));
    expect(img.width).toBe(2);
    expect(pixel(img, 0, 0)).toEqual([255, 0, 0, 255]);
    const [r, g, , a] = pixel(img, 1, 0);
    expect(Math.abs((r ?? 0) - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs((g ?? 0) - 64)).toBeLessThanOrEqual(1);
    expect(a).toBe(128);
  });

  it('rejects garbage with OV_IMAGE_DECODE', async () => {
    let caught: unknown;
    try {
      decodeImage(await canvasKit(), new Uint8Array([1, 2, 3, 4]));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({ diagnostic: { code: 'OV_IMAGE_DECODE' } });
  });

  it('draws image assets', async () => {
    const png = encodePng({ width: 1, height: 1, data: new Uint8Array([0, 0, 255, 255]) });
    const img = await render([n('image', { asset: 'blue', width: 4, height: 4 })], { width: 4, height: 4, assets: assets([asset('blue', 'image', png)]) });
    expect(pixel(img, 2, 2)).toEqual([0, 0, 255, 255]);
  });
});
