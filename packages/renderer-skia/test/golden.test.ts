/**
 * Golden-Tests: jede Node-Art und jeder Effekt aus der Spec. Jedes Bild wurde visuell geprüft.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeBounds, type EvaluatedNode, type RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createSkiaTextMeasurer, renderContactSheet, renderDebugOverlay } from '@agentic-video/renderer-skia';
import { asset, assets, backend, canvasKit, expectGolden, fonts, hash, here, n, render, scene } from './helpers.js';

const BG = (w: number, h: number, color = '#15161C') => n('rect', { width: w, height: h, fill: color });

/** Buntes Testmuster für Filter und Blend Modes. */
function swatch(x: number, y: number, size: number): EvaluatedNode {
  return n('group', { x, y }, {
    children: [
      n('rect', { width: size, height: size, fill: { type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [{ offset: 0, color: '#FF3B30' }, { offset: 0.5, color: '#FFD60A' }, { offset: 1, color: '#0A84FF' }] } }),
      n('ellipse', { x: size * 0.25, y: size * 0.25, width: size * 0.5, height: size * 0.5, fill: '#34C759' }),
    ],
  });
}

function grid<T>(items: readonly T[], columns: number, cell: number, make: (item: T, x: number, y: number) => EvaluatedNode): EvaluatedNode[] {
  return items.map((item, i) => make(item, 8 + (i % columns) * cell, 8 + Math.floor(i / columns) * cell));
}

/** Kleines PNG-Testbild: Schachbrett mit Farbecken. */
function checkerPng(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = (Math.floor(x / (size / 4)) + Math.floor(y / (size / 4))) % 2 === 0;
      data[i] = on ? 240 : x < size / 2 ? 255 : 30;
      data[i + 1] = on ? 240 : y < size / 2 ? 80 : 200;
      data[i + 2] = on ? 240 : 60;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: size, height: size, data });
}

/** Sprite Sheet 4 × 2 mit Zahlenbalken je Zelle. */
function spritePng(): Uint8Array {
  const cw = 16;
  const w = cw * 4;
  const h = cw * 2;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cell = Math.floor(x / cw) + Math.floor(y / cw) * 4;
      const lx = x % cw;
      const ly = y % cw;
      const bar = ly >= 2 && ly < 14 && lx >= 2 && lx < 2 + (cell + 1) * 1.5;
      const i = (y * w + x) * 4;
      data[i] = bar ? 255 : 40;
      data[i + 1] = bar ? 200 : 40 + cell * 20;
      data[i + 2] = bar ? 0 : 90;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, data });
}

/** Videobild: Balken, dessen Position von der Quellzeit abhängt. */
function videoFrame(_: string, seconds: number): RgbaImage {
  const w = 64;
  const h = 36;
  const data = new Uint8Array(w * h * 4);
  const bar = Math.floor((seconds * 20) % w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const on = Math.abs(x - bar) < 4;
      data[i] = on ? 255 : 20;
      data[i + 1] = on ? 255 : 60;
      data[i + 2] = on ? 255 : 120;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const LOTTIE = readFileSync(join(here, 'fixtures', 'box.lottie.json'));

describe('golden images', () => {
  it('shapes, strokes, dashes, trim and fill rules', async () => {
    const img = await render(
      [
        BG(360, 240),
        n('rect', { x: 16, y: 16, width: 90, height: 60, fill: '#FF6B6B', cornerRadius: [0, 20, 8, 30], stroke: '#FFFFFF', strokeWidth: 3 }),
        n('ellipse', { x: 124, y: 16, width: 100, height: 60, fill: '#4ECDC4' }),
        n('rect', { x: 244, y: 16, width: 100, height: 60, stroke: '#FFE66D', strokeWidth: 4, strokeDash: [12, 6], strokeJoin: 'round' }),
        n('line', { from: { x: 16, y: 100 }, to: { x: 106, y: 140 }, strokeWidth: 8, strokeCap: 'round', fill: '#C7F464' }),
        n('polyline', { points: [[124, 140], [150, 96], [176, 140], [202, 96], [224, 140]], stroke: '#FF9F1C', strokeWidth: 6, strokeJoin: 'miter' }),
        n('polygon', { points: [[294, 92], [340, 140], [248, 140]], fill: '#A06CD5', stroke: '#FFFFFF', strokeWidth: 2, strokeJoin: 'bevel' }),
        n('path', { x: 16, y: 156, d: 'M0 0 H70 V70 H0 Z M20 20 H50 V50 H20 Z', fill: '#2EC4B6', fillRule: 'evenodd' }),
        n('path', { x: 100, y: 156, d: 'M0 0 H70 V70 H0 Z M20 20 H50 V50 H20 Z', fill: '#2EC4B6' }),
        n('path', { x: 190, y: 160, d: 'M0 30 C 20 -20, 60 80, 80 30 S 140 -20, 150 30', stroke: '#F72585', strokeWidth: 6, strokeCap: 'round', trimStart: 0.1, trimEnd: 0.7 }),
        n('path', { x: 190, y: 196, d: 'M0 30 C 20 -20, 60 80, 80 30 S 140 -20, 150 30', stroke: '#4CC9F0', strokeWidth: 6, strokeCap: 'butt', trimStart: 0, trimEnd: 0.5, trimOffset: 0.75 }),
      ],
      { width: 360, height: 240 },
    );
    expectGolden('shapes', img);
  });

  it('linear, radial and conic gradients for fill and stroke', async () => {
    const stops = [{ offset: 0, color: '#F72585' }, { offset: 0.5, color: '#7209B7' }, { offset: 1, color: '#4CC9F0' }];
    const img = await render(
      [
        BG(360, 140),
        n('rect', { x: 12, y: 12, width: 100, height: 100, fill: { type: 'linear', stops, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } }),
        n('ellipse', { x: 128, y: 12, width: 100, height: 100, fill: { type: 'radial', stops } }),
        n('rect', { x: 244, y: 12, width: 100, height: 100, cornerRadius: 50, fill: { type: 'conic', stops: [...stops, { offset: 1, color: '#F72585' }], angle: -90 } }),
        n('rect', { x: 20, y: 118, width: 320, height: 12, fill: 'transparent', stroke: { type: 'linear', stops }, strokeWidth: 4 }),
      ],
      { width: 360, height: 140 },
    );
    expectGolden('gradients', img);
  });

  it('filters, shadow and opacity', async () => {
    const filters: Record<string, unknown>[] = [
      { type: 'blur', radius: 4 },
      { type: 'brightness', amount: 1.6 },
      { type: 'contrast', amount: 2 },
      { type: 'saturate', amount: 0.2 },
      { type: 'grayscale', amount: 1 },
      { type: 'sepia', amount: 1 },
      { type: 'invert', amount: 1 },
      { type: 'hue-rotate', degrees: 120 },
      { type: 'color-matrix', matrix: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0] },
    ];
    const tiles = grid(filters, 5, 72, (f, x, y) => {
      const s = swatch(0, 0, 60);
      return n('group', { x, y, filters: [f] }, { children: [s] });
    });
    const img = await render(
      [
        BG(368, 160),
        ...tiles,
        n('group', { x: 296, y: 80, shadow: { color: '#000000C0', blur: 4, offsetX: 5, offsetY: 5 }, opacity: 0.6 }, { children: [n('rect', { width: 56, height: 56, fill: '#FFFFFF', cornerRadius: 10 })] }),
      ],
      { width: 368, height: 160 },
    );
    expectGolden('filters', img);
  });

  it('all 17 blend modes', async () => {
    const modes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'add'];
    const tiles = grid(modes, 6, 60, (mode, x, y) =>
      n('group', { x, y }, {
        children: [swatch(0, 0, 52), n('ellipse', { x: 14, y: 14, width: 38, height: 38, fill: '#8E44AD', blendMode: mode })],
      }),
    );
    const img = await render([BG(376, 196, '#303030'), ...tiles], { width: 376, height: 196 });
    expectGolden('blend-modes', img);
  });

  it('masks, clipping groups and reveal clips', async () => {
    const pattern = () => swatch(0, 0, 80);
    const circle = (fill: string) => n('ellipse', { x: 10, y: 10, width: 60, height: 60, fill });
    const lumaMask = n('rect', { width: 80, height: 80, fill: { type: 'linear', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#FFFFFF' }] } });
    const img = await render(
      [
        BG(460, 200),
        n('group', { x: 10, y: 10 }, { children: [pattern()], mask: { node: circle('#FFFFFF'), mode: 'alpha', invert: false } }),
        n('group', { x: 100, y: 10 }, { children: [pattern()], mask: { node: circle('#FFFFFF'), mode: 'alpha', invert: true } }),
        n('group', { x: 190, y: 10 }, { children: [pattern()], mask: { node: lumaMask, mode: 'luminance', invert: false } }),
        n('group', { x: 280, y: 10 }, { children: [pattern()], mask: { node: lumaMask, mode: 'luminance', invert: true } }),
        n('group', { x: 370, y: 10, width: 60, height: 60, clip: true }, { children: [n('ellipse', { x: 20, y: 20, width: 80, height: 80, fill: '#FFB703' })] }),
        n('group', { x: 10, y: 110 }, { children: [pattern()], reveal: { shape: 'rect', direction: 'left', progress: 0.5 } }),
        n('group', { x: 100, y: 110 }, { children: [pattern()], reveal: { shape: 'rect', direction: 'down', progress: 0.4 } }),
        n('rect', { x: 190, y: 110, width: 80, height: 80, fill: '#8ECAE6' }, { reveal: { shape: 'ellipse', direction: 'center', progress: 0.5 } }),
        n('group', { x: 280, y: 110, rotation: 20, opacity: 0.5 }, { children: [pattern()], mask: { node: n('rect', { x: 20, y: 0, width: 40, height: 80 }), mode: 'alpha', invert: false } }),
      ],
      { width: 460, height: 200 },
    );
    expectGolden('masks-clips', img);
  });

  it('typography: wrap, alignment, spacing, variable weight, features, decoration, stroke, gradient', async () => {
    const img = await render(
      [
        BG(480, 400),
        n('text', { x: 12, y: 8, text: 'Thin 100 · Regular 400 · Black 900', fontSize: 18 }),
        n('text', { x: 12, y: 32, text: 'Thin', fontSize: 30, fontWeight: 100 }),
        n('text', { x: 90, y: 32, text: 'Semi', fontSize: 30, fontWeight: 600 }),
        n('text', { x: 180, y: 32, text: 'Black', fontSize: 30, fontWeight: 900 }),
        n('text', { x: 280, y: 32, text: 'Italic', fontSize: 30, fontStyle: 'italic', fontVariations: { wght: 700 } }),
        n('text', { x: 12, y: 76, text: '0123456789 tabular', fontSize: 20, fontFeatures: { tnum: 1 }, fontFamily: 'JetBrains Mono' }),
        n('text', { x: 12, y: 104, text: 'Wide tracking', fontSize: 20, letterSpacing: 6, decoration: 'underline' }),
        n('text', { x: 250, y: 104, text: 'Struck', fontSize: 20, decoration: 'line-through', fill: '#FF6B6B' }),
        n('rect', { x: 12, y: 136, width: 200, height: 100, fill: '#FFFFFF10' }),
        n('text', { x: 12, y: 136, width: 200, text: 'Centered text that wraps at word boundaries.', fontSize: 18, textAlign: 'center', lineHeight: 1.5 }),
        n('rect', { x: 240, y: 136, width: 220, height: 60, fill: '#FFFFFF10' }),
        n('text', { x: 240, y: 136, width: 220, text: 'Right aligned text limited to two lines with an ellipsis at the end of it all.', fontSize: 16, textAlign: 'right', maxLines: 2, ellipsis: '…' }),
        n('text', { x: 12, y: 250, text: 'OUTLINE', fontSize: 56, fontWeight: 800, fill: 'transparent', stroke: '#4CC9F0', strokeWidth: 2 }),
        n('text', { x: 12, y: 320, text: 'Gradient fill', fontSize: 52, fontWeight: 800, fill: { type: 'linear', stops: [{ offset: 0, color: '#F72585' }, { offset: 1, color: '#4CC9F0' }] }, stroke: '#FFFFFF', strokeWidth: 1 }),
      ],
      { width: 480, height: 400 },
    );
    expectGolden('typography', img);
  });

  it('shaping: ffi ligature, Hebrew RTL and color emoji', async () => {
    const img = await render(
      [
        BG(420, 200),
        n('text', { x: 12, y: 10, text: 'office ffi fi', fontSize: 40, fontFamily: 'Noto Serif' }),
        n('text', { x: 12, y: 60, text: 'office ffi fi', fontSize: 40, fontFamily: 'Noto Serif', fontFeatures: { liga: 0 }, fill: '#999999' }),
        n('text', { x: 280, y: 14, text: 'a -> b', fontSize: 30 }),
        n('text', { x: 280, y: 64, text: 'a -> b', fontSize: 30, fontFeatures: { calt: 0 }, fill: '#999999' }),
        n('text', { x: 12, y: 110, width: 396, text: 'שלום עולם 123', fontSize: 34, textAlign: 'right' }),
        n('text', { x: 12, y: 156, text: 'Emoji 😀🎬🚀 👍🏽', fontSize: 30 }),
      ],
      { width: 420, height: 200 },
    );
    expectGolden('shaping', img);
  });

  it('rich text and text backgrounds', async () => {
    const img = await render(
      [
        BG(420, 230, '#2B2D42'),
        n('rich-text', { x: 12, y: 12, fontSize: 28, spans: [{ text: 'Rich ' }, { text: 'bold ', fontWeight: 800, fill: '#FFD166' }, { text: 'italic ', fontStyle: 'italic', fill: '#06D6A0' }, { text: 'mono', fontFamily: 'JetBrains Mono', fill: '#EF476F' }] }),
        n('text', { x: 20, y: 70, text: 'Label box', fontSize: 26, fill: '#000000', background: { color: '#FFD166', paddingX: 12, paddingY: 6, radius: 10 } }),
        n('text', { x: 20, y: 130, width: 260, text: 'Per line boxes behind every wrapped line of text', fontSize: 22, background: { color: '#EF476FE0', paddingX: 8, paddingY: 2, radius: 6, perLine: true } }),
        n('text', { x: 300, y: 70, text: 'Faded', fontSize: 26, opacity: 0.5, rotation: -10, background: { color: '#118AB2', paddingX: 10, paddingY: 4, radius: 4 } }),
      ],
      { width: 420, height: 230 },
    );
    expectGolden('rich-text-background', img);
  });

  it('text along a path', async () => {
    const d = 'M20 150 C 100 20, 260 20, 340 150';
    const img = await render([BG(360, 180), n('path', { d, stroke: '#FFFFFF40', strokeWidth: 1 }), n('text', { text: 'Text follows the curve ✨', fontSize: 26, textPath: { d, offset: 12 }, fill: '#FFD166' })], { width: 360, height: 180 });
    expectGolden('text-path', img);
  });

  it('textAnimation per character at start, middle and end (contact sheet)', async () => {
    const skia = await backend();
    const make = (frame: number) => [
      BG(320, 90),
      n('text', { x: 16, y: 20, text: 'Staggered', fontSize: 40, fontWeight: 700, textAnimation: { unit: 'char', stagger: 3, duration: 12, from: { opacity: 0, y: 30, scale: 0.4, rotation: -30, color: '#FF0000' } } }, { frame }),
    ];
    const frames: { image: RgbaImage; label: string }[] = [];
    for (const f of [0, 14, 40]) frames.push({ image: await render(make(f), { width: 320, height: 90, frame: f }, skia), label: `frame ${String(f)}` });
    expect(hash(frames[0]?.image ?? frames[1]!.image)).not.toBe(hash(frames[1]!.image));
    expect(hash(frames[1]!.image)).not.toBe(hash(frames[2]!.image));
    const sheet = renderContactSheet(await canvasKit(), await fonts(), frames, { columns: 1, cellWidth: 320, background: '#E9ECEF' });
    expectGolden('text-animation-sheet', sheet);
  });

  it('word and line units', async () => {
    const make = (unit: string) => n('text', { x: 12, y: unit === 'word' ? 8 : 60, width: 300, text: 'Words fly in\none by one', fontSize: 22, textAnimation: { unit, stagger: 4, duration: 10, from: { opacity: 0, x: -40, blur: 4 } } }, { frame: 8 });
    const img = await render([BG(320, 120), make('word'), make('line')], { width: 320, height: 120, frame: 8 });
    expectGolden('text-animation-units', img);
  });

  it('images with fit modes and smoothing, sprites and video frames', async () => {
    const list = assets([asset('checker', 'image', checkerPng(16)), asset('sprite', 'image', spritePng()), asset('clip', 'video', new Uint8Array([1]), { duration: 2 })], videoFrame);
    const img = await render(
      [
        BG(420, 220),
        n('rect', { x: 10, y: 10, width: 120, height: 60, fill: '#FFFFFF20' }),
        n('image', { asset: 'checker', x: 10, y: 10, width: 120, height: 60, fit: 'contain', smoothing: 'nearest' }),
        n('rect', { x: 140, y: 10, width: 120, height: 60, fill: '#FFFFFF20' }),
        n('image', { asset: 'checker', x: 140, y: 10, width: 120, height: 60, fit: 'cover', smoothing: 'linear' }),
        n('image', { asset: 'checker', x: 270, y: 10, width: 120, height: 60, fit: 'fill', smoothing: 'cubic' }),
        n('image', { asset: 'checker', x: 10, y: 80 }),
        n('sprite', { asset: 'sprite', x: 40, y: 80, width: 48, height: 48, columns: 4, rows: 2, frame: 5 }),
        n('sprite', { asset: 'sprite', x: 100, y: 80, width: 48, height: 48, columns: 4, rows: 2, frameRate: 8, loop: true }, { frame: 30 }),
        n('video', { asset: 'clip', x: 160, y: 80, width: 128, height: 72, startFrom: '0.5s' }, { frame: 30 }),
        n('video', { asset: 'clip', x: 160, y: 150, width: 128, height: 72, loop: true, playbackRate: 2 }, { frame: 45 }),
      ],
      { width: 420, height: 220, assets: list, frame: 30 },
    );
    expectGolden('media', img);
  });

  it('inline SVG with gradients, use, transforms and text', async () => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" width="200" height="100">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0080"/><stop offset="100%" stop-color="#00c0ff"/></linearGradient>
        <radialGradient id="r"><stop offset="0%" style="stop-color:white"/><stop offset="1" stop-color="navy" stop-opacity="0.5"/></radialGradient>
        <path id="star" d="M10 0 L13 7 L20 7 L14 12 L16 20 L10 15 L4 20 L6 12 L0 7 L7 7 Z"/>
      </defs>
      <rect x="4" y="4" width="120" height="50" rx="10" fill="url(#g)" stroke="white" stroke-width="2"/>
      <circle cx="160" cy="30" r="26" fill="url(#r)"/>
      <g transform="translate(10 62) scale(1.5)" fill="gold" style="stroke: orange; stroke-width: 1">
        <use href="#star"/><use xlink:href="#star" x="24"/><use href="#star" x="48" opacity="0.4"/>
      </g>
      <ellipse cx="150" cy="80" rx="30" ry="10" fill="rgb(40, 200, 120)" fill-opacity="0.8"/>
      <polyline points="100,95 110,70 120,95" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="4 2"/>
      <line x1="4" y1="96" x2="90" y2="96" stroke="#f00" stroke-width="2"/>
      <text x="150" y="98" font-size="10" text-anchor="middle" fill="#ffffff">SVG text</text>
      <filter id="ignored"/>
    </svg>`;
    const svgBytes = new TextEncoder().encode('<svg viewBox="0 0 10 10"><polygon points="5,0 10,10 0,10" fill="#ffb703"/></svg>');
    const img = await render(
      [BG(420, 220), n('svg', { x: 10, y: 10, width: 400, height: 200, markup }), n('svg', { asset: 'tri', x: 370, y: 170, width: 40, height: 40 })],
      { width: 420, height: 220, assets: assets([asset('tri', 'svg', svgBytes)]) },
    );
    expectGolden('svg', img);
  });

  it('lottie is frame-exact and deterministic', async () => {
    const skia = await backend();
    const list = assets([asset('box', 'lottie', new Uint8Array(LOTTIE))]);
    const make = (frame: number) => [BG(200, 200), n('lottie', { asset: 'box', width: 200, height: 200 }, { frame })];
    const a = await render(make(30), { width: 200, height: 200, assets: list, frame: 30 }, skia);
    const other = await render(make(10), { width: 200, height: 200, assets: list, frame: 10 }, skia);
    const b = await render(make(30), { width: 200, height: 200, assets: list, frame: 30 }, skia);
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe(hash(other));
    expectGolden('lottie-frame-30', a);
  });

  it('SkSL shader with time, frame, resolution and custom uniforms', async () => {
    const sksl = `
      uniform float time;
      uniform float frame;
      uniform float2 resolution;
      uniform float3 tint;
      half4 main(float2 coord) {
        float2 uv = coord / resolution;
        float wave = 0.5 + 0.5 * sin(uv.x * 12.0 + time * 3.0);
        float band = step(abs(uv.y - wave), 0.05);
        return half4(half3(tint * uv.y + band), 1.0);
      }`;
    const img = await render([n('shader', { x: 10, y: 10, width: 220, height: 120, sksl, uniforms: { tint: [0.2, 0.6, 1.0] } }, { frame: 15 })], { width: 240, height: 140, frame: 15 });
    expectGolden('shader', img);
  });

  it('particles as circles, squares and sparks', async () => {
    const base = { width: 140, height: 140, count: 60, seed: 7, lifetime: { min: 1, max: 2 }, speed: { min: 20, max: 60 }, gravity: { x: 0, y: 40 }, size: { start: 8, end: 2 }, color: { start: '#FFD166', end: '#EF476F' } };
    const img = await render(
      [BG(440, 160), n('particles', { ...base, x: 10, y: 10 }, { frame: 30 }), n('particles', { ...base, x: 150, y: 10, shape: 'square' }, { frame: 30 }), n('particles', { ...base, x: 290, y: 10, shape: 'spark', emitter: { x: 70, y: 70, radius: 10, shape: 'circle' } }, { frame: 30 })],
      { width: 440, height: 160, frame: 30 },
    );
    expectGolden('particles', img);
  });

  it('debug overlay: bounds, anchors, safe areas, baselines, grid and node ids', async () => {
    const ck = await canvasKit();
    const f = await fonts();
    const nodes = [n('rect', { id: 'card', x: 60, y: 60, width: 160, height: 90, rotation: 12, fill: '#4CC9F0' }, { id: 'card' }), n('text', { x: 260, y: 90, text: 'Title', fontSize: 40 }, { id: 'title' })];
    const s = scene(nodes, 480, 270);
    const measurer = createSkiaTextMeasurer(ck, f);
    const overlay = renderDebugOverlay(ck, f, s, computeBounds(s, measurer), { showBounds: true, showAnchors: true, showSafeArea: true, showBaseline: true, showGrid: true, showNodeIds: true, showCameraFrustum: true }, { width: 480, height: 270 });
    measurer.dispose();
    const layer = await render([BG(480, 270), ...nodes], { width: 480, height: 270, debug: { showBounds: true, showNodeIds: true } });
    const sheet = renderContactSheet(ck, f, [{ image: overlay, label: 'renderDebugOverlay' }, { image: layer, label: 'renderLayer with debug' }], { columns: 2, cellWidth: 480, background: '#6C757D' });
    expectGolden('debug-overlay', sheet);
  });

  it('preview scale renders the same picture at half size', async () => {
    const nodes = [BG(280, 120), n('text', { x: 12, y: 12, text: 'Preview ½', fontSize: 40 }), n('ellipse', { x: 206, y: 40, width: 60, height: 60, fill: '#EF476F', shadow: { color: '#000000', blur: 6, offsetY: 4 } })];
    const img = await render(nodes, { width: 280, height: 120, scale: 0.5 });
    expect([img.width, img.height]).toEqual([140, 60]);
    expectGolden('preview-half', img);
  });
});
