/**
 * Tests für checkPixiNode (jede Einschränkung) und die reinen Hilfsfunktionen.
 */
import { describe, expect, it } from 'vitest';
import { PIXI_CAPABILITIES, PIXI_VERSION, checkPixiNode, filterMatrix, fragmentSource, shaderUniforms } from '../src/index.js';

const features = (node: Record<string, unknown>): string[] => checkPixiNode(node).map((d) => String(d.details?.['feature']));

describe('checkPixiNode', () => {
  it('akzeptiert unterstützte Nodes ohne Meldungen', () => {
    expect(
      checkPixiNode({
        id: 'g',
        type: 'group',
        clip: true,
        opacity: 0.5,
        blendMode: 'overlay',
        filters: [{ type: 'blur', radius: 2 }],
        mask: { node: { id: 'm', type: 'ellipse', width: 10, height: 10 }, mode: 'luminance', invert: true },
        children: [
          { id: 'r', type: 'rect', width: 10, height: 10, fill: { type: 'radial', stops: [] }, stroke: '#FFFFFF' },
          { id: 't', type: 'text', text: 'Hi', background: { color: '#000000', perLine: true } },
          { id: 's', type: 'shader', width: 10, height: 10, glsl: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }', uniforms: { tint: [1, 0, 0] } },
        ],
      }),
    ).toEqual([]);
  });

  it('meldet nicht unterstützte Node-Typen als Fehler mit Vorschlag skia', () => {
    for (const type of ['rich-text', 'svg', 'lottie', 'html', 'scene3d']) {
      const d = checkPixiNode({ id: 'x', type });
      expect(d).toHaveLength(1);
      expect(d[0]?.code).toBe('OV_PIXI_UNSUPPORTED');
      expect(d[0]?.severity).toBe('error');
      expect(d[0]?.suggestions[0]).toBe("Set renderer: 'skia' on this node.");
    }
  });

  it('meldet SkSL-Shader ohne GLSL als Fehler', () => {
    const d = checkPixiNode({ id: 's', type: 'shader', width: 1, height: 1, sksl: 'half4 main(float2 c) { return half4(1); }' });
    expect(d.map((x) => [x.details?.['feature'], x.severity])).toEqual([['shader.sksl', 'error']]);
  });

  it('meldet Uniform-Listen mit mehr als 4 Werten', () => {
    expect(features({ id: 's', type: 'shader', glsl: 'x', uniforms: { m: [1, 2, 3, 4, 5] } })).toEqual(['shader.uniform-array']);
  });

  it('meldet jede Text-Einschränkung', () => {
    expect(
      features({ id: 't', type: 'text', text: 'x', textPath: { d: 'M0 0' }, textAnimation: { unit: 'char', from: {} }, maxLines: 1, ellipsis: '…', fontFeatures: { liga: 0 }, fontVariations: { wght: 600 }, decoration: 'underline', direction: 'rtl', fontStretch: 75 }),
    ).toEqual(['text.textPath', 'text.textAnimation', 'text.maxLines', 'text.ellipsis', 'text.fontFeatures', 'text.fontVariations', 'text.decoration', 'text.rtl', 'text.fontStretch']);
    expect(features({ id: 't', type: 'text', text: 'x', decoration: 'none', fontStretch: 100, direction: 'ltr' })).toEqual([]);
  });

  it('meldet Paint- und Kontur-Einschränkungen', () => {
    expect(features({ id: 'r', type: 'rect', fill: { type: 'conic', stops: [] }, stroke: { type: 'conic', stops: [] } })).toEqual(['gradient.conic', 'gradient.conic']);
    expect(features({ id: 'r', type: 'path', d: 'M0 0', strokeDash: [4, 2], trimStart: 0.1, trimEnd: 0.9, trimOffset: 0.2, fillRule: 'evenodd' })).toEqual(['strokeDash', 'trim', 'trim', 'trim', 'fillRule.evenodd']);
  });

  it('meldet Blend Mode hue und Schatten', () => {
    expect(features({ id: 'r', type: 'rect', blendMode: 'hue', shadow: { color: '#000000' } })).toEqual(['blendMode.hue', 'shadow']);
  });

  it('meldet cubic-Glättung (info) und Video-Loop', () => {
    const d = checkPixiNode({ id: 'i', type: 'image', asset: 'a', smoothing: 'cubic' });
    expect(d.map((x) => [x.details?.['feature'], x.severity])).toEqual([['image.smoothing.cubic', 'info']]);
    expect(features({ id: 'v', type: 'video', asset: 'a', loop: true })).toEqual(['video.loop']);
  });

  it('prüft Kinder und Masken rekursiv mit Pointer', () => {
    const d = checkPixiNode({ id: 'g', type: 'group', mask: { node: { id: 'm', type: 'svg' } }, children: [{ id: 'a', type: 'group', children: [{ id: 'b', type: 'lottie' }] }] });
    expect(d.map((x) => [x.nodeId, x.pointer])).toEqual([
      ['m', '/mask/node'],
      ['b', '/children/0/children/0'],
    ]);
  });
});

describe('Konstanten', () => {
  it('nennen Version und Fähigkeiten', () => {
    expect(PIXI_VERSION).toMatch(/^8\.\d+\.\d+/u);
    for (const c of ['pixi.gradient.linear', 'pixi.gradient.radial', 'pixi.mask.alpha', 'pixi.filter.blur', 'pixi.node.shader.glsl', 'pixi.text.background.per-line']) expect(PIXI_CAPABILITIES).toContain(c);
  });
});

describe('filterMatrix', () => {
  const apply = (m: number[], rgb: [number, number, number]): number[] => [0, 1, 2].map((r) => (m[r * 5] ?? 0) * rgb[0] + (m[r * 5 + 1] ?? 0) * rgb[1] + (m[r * 5 + 2] ?? 0) * rgb[2] + (m[r * 5 + 4] ?? 0));
  it('grayscale 1 macht Grau mit Rec.-709-Gewichten', () => {
    const [r, g, b] = apply(filterMatrix({ type: 'grayscale', amount: 1 }) ?? [], [1, 0, 0]);
    expect(r).toBeCloseTo(0.2126);
    expect(g).toBeCloseTo(0.2126);
    expect(b).toBeCloseTo(0.2126);
  });
  it('invert 1 kehrt um, contrast 1 und hue-rotate 0 ändern nichts', () => {
    expect(apply(filterMatrix({ type: 'invert', amount: 1 }) ?? [], [0.2, 0.5, 1])).toEqual([0.8, 0.5, 0]);
    expect(apply(filterMatrix({ type: 'contrast', amount: 1 }) ?? [], [0.2, 0.5, 1])).toEqual([0.2, 0.5, 1]);
    apply(filterMatrix({ type: 'hue-rotate', degrees: 0 }) ?? [], [0.2, 0.5, 1]).forEach((v, i) => { expect(v).toBeCloseTo([0.2, 0.5, 1][i] ?? 0); });
  });
  it('übernimmt color-matrix und ignoriert blur', () => {
    const m = Array.from({ length: 20 }, (_, i) => i);
    expect(filterMatrix({ type: 'color-matrix', matrix: m })).toEqual(m);
    expect(filterMatrix({ type: 'blur', radius: 3 })).toBeUndefined();
  });
});

describe('Shader-Uniforms', () => {
  it('liefert time, frame, resolution und typisiert eigene Werte', () => {
    const u = shaderUniforms({ a: 1, b: [1, 2], c: [1, 2, 3, 4], d: [1, 2, 3, 4, 5], time: 99 }, 1.5, 45, 320, 180);
    expect(Object.keys(u)).toEqual(['a', 'b', 'c', 'time', 'frame', 'resolution']);
    expect(u['time']?.value).toBe(1.5);
    expect(u['b']?.type).toBe('vec2<f32>');
    const src = fragmentSource('void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }', u);
    expect(src.startsWith('#version 300 es')).toBe(true);
    expect(src).toContain('uniform vec4 c;');
    expect(src).toContain('uniform vec2 resolution;');
  });
});
