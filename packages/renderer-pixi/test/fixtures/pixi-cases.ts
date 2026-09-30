/**
 * Testfälle für den PixiJS-Renderer: je Node-Typ und je Paint-/Effekt-Merkmal ein Layer.
 * Reine Daten, damit Node-Tests die Fallnamen kennen.
 */
import type { EvaluatedNode, Reveal } from '@agentic-video/core';

export const FPS = 30;
export const WIDTH = 200;
export const HEIGHT = 150;

/** Ein Testfall: Nodes als Funktion des Frames. */
export interface PixiCase {
  readonly nodes: (frame: number) => EvaluatedNode[];
  readonly frame?: number;
  readonly scale?: number;
}

let counter = 0;

/** Baut eine ausgewertete Node (lokale Zeit = Frame). */
export function ev(type: string, props: Record<string, unknown>, children: EvaluatedNode[] = [], extra: { frame?: number; mask?: EvaluatedNode['mask']; reveal?: Reveal } = {}): EvaluatedNode {
  counter++;
  const frame = extra.frame ?? 0;
  return {
    id: `${type}-${String(counter)}`,
    type,
    props,
    children,
    time: { localFrame: frame, relFrame: frame, durationFrames: 60, progress: frame / 60, compositionFrame: frame },
    pointer: `/test/${String(counter)}`,
    ...(extra.mask !== undefined ? { mask: extra.mask } : {}),
    ...(extra.reveal !== undefined ? { reveal: extra.reveal } : {}),
  };
}

const bg = (): EvaluatedNode => ev('rect', { width: WIDTH, height: HEIGHT, fill: '#1E2230' });
const linear = (a: string, b: string): Record<string, unknown> => ({ type: 'linear', stops: [{ offset: 0, color: a }, { offset: 1, color: b }] });

const cases: Record<string, PixiCase> = {
  rect: {
    nodes: () => [
      bg(),
      ev('rect', { x: 20, y: 20, width: 100, height: 70, cornerRadius: [0, 20, 8, 30], fill: linear('#FF6B6B', '#4ECDC4'), stroke: '#FFFFFF', strokeWidth: 4 }),
      ev('rect', { x: 130, y: 40, width: 50, height: 90, cornerRadius: 12, stroke: '#FFD93D', strokeWidth: 3, strokeJoin: 'round' }),
      ev('rect', { x: 20, y: 105, width: 90, height: 30 }),
    ],
  },
  ellipse: {
    nodes: () => [bg(), ev('ellipse', { x: 20, y: 15, width: 160, height: 120, fill: { type: 'radial', stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 0.6, color: '#6C5CE7' }, { offset: 1, color: '#6C5CE700' }] } })],
  },
  line: {
    nodes: () => [
      bg(),
      ev('line', { from: { x: 20, y: 20 }, to: { x: 180, y: 130 }, stroke: '#00D2D3', strokeWidth: 8, strokeCap: 'round' }),
      ev('line', { from: { x: 20, y: 130 }, to: { x: 180, y: 20 }, fill: '#FF9F43', strokeWidth: 3 }),
    ],
  },
  polyline: {
    nodes: () => [
      bg(),
      ev('polyline', { points: [[20, 120], [60, 30], [100, 100], [140, 40], [180, 110]], stroke: '#FECA57', strokeWidth: 6, strokeJoin: 'round', strokeCap: 'round' }),
      ev('polyline', { points: [[20, 140], [180, 140]] }),
    ],
  },
  polygon: {
    nodes: () => {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 60 : 25;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        pts.push([100 + Math.cos(a) * r, 75 + Math.sin(a) * r]);
      }
      return [bg(), ev('polygon', { points: pts, fill: '#FF6B81', stroke: '#FFFFFF', strokeWidth: 2 })];
    },
  },
  path: {
    nodes: () => [bg(), ev('path', { x: 10, y: 10, d: 'M10 100 C 40 10, 80 10, 100 70 S 160 130, 170 40 L 170 120 A 30 30 0 0 1 110 120 Z', fill: '#48DBFB', stroke: '#0A3D62', strokeWidth: 3 })],
  },
  'group-clip': {
    nodes: () => [
      bg(),
      ev('group', { x: 40, y: 25, width: 120, height: 100, clip: true, rotation: 10 }, [ev('ellipse', { x: -30, y: -30, width: 120, height: 120, fill: '#FF6B6B' }), ev('rect', { x: 60, y: 40, width: 100, height: 100, fill: '#4ECDC4' })]),
    ],
  },
  'opacity-group': {
    nodes: () => [bg(), ev('group', { opacity: 0.5 }, [ev('rect', { x: 30, y: 30, width: 90, height: 70, fill: '#FF6B6B' }), ev('rect', { x: 80, y: 60, width: 90, height: 70, fill: '#FF6B6B' })]), ev('rect', { x: 10, y: 110, width: 60, height: 30, fill: '#FFFFFF', opacity: 0.3 })],
  },
  transform: {
    nodes: () => [
      bg(),
      ev('rect', { x: 20, y: 20, width: 60, height: 40, fill: '#FF9F43', rotation: 30 }),
      ev('rect', { x: 110, y: 20, width: 60, height: 40, fill: '#54A0FF', scale: { x: 1.4, y: 0.6 }, origin: { x: 0, y: 0 } }),
      ev('rect', { x: 20, y: 90, width: 60, height: 40, fill: '#5F27CD', skew: { x: 20, y: 0 } }),
      ev('ellipse', { x: 110, y: 90, width: 60, height: 40, fill: '#1DD1A1', motionPath: { d: 'M0 0 L20 -10', progress: 1 } }),
    ],
  },
  text: {
    nodes: () => [bg(), ev('text', { x: 12, y: 16, text: 'OpenVideo\nPixiJS', fontSize: 30, fontWeight: 700, fill: '#FFFFFF' })],
  },
  'text-wrap-center': {
    nodes: () => [bg(), ev('text', { x: 20, y: 20, width: 160, text: 'Centered text wraps at word boundaries.', fontSize: 20, textAlign: 'center', fill: '#1E2230', background: { color: '#FECA57', paddingX: 6, paddingY: 4, radius: 8 } })],
  },
  'text-background-per-line': {
    nodes: () => [bg(), ev('text', { x: 20, y: 25, text: 'One box\nper line here', fontSize: 24, lineHeight: 1.5, fill: '#FFFFFF', background: { color: '#E84C4CCC', paddingX: 8, paddingY: 2, radius: 6, perLine: true } })],
  },
  'text-gradient-stroke': {
    nodes: () => [bg(), ev('text', { x: 15, y: 40, text: 'Gradient', fontSize: 44, fontWeight: 800, fill: linear('#FF6B6B', '#FECA57'), stroke: '#FFFFFF', strokeWidth: 2 })],
  },
  image: {
    nodes: () => [
      bg(),
      ev('image', { asset: 'photo', x: 5, y: 40, width: 60, height: 70, fit: 'fill' }),
      ev('rect', { x: 70, y: 40, width: 60, height: 70, stroke: '#FFFFFF55', strokeWidth: 1 }),
      ev('image', { asset: 'photo', x: 70, y: 40, width: 60, height: 70, fit: 'contain' }),
      ev('image', { asset: 'photo', x: 135, y: 40, width: 60, height: 70, fit: 'cover' }),
    ],
  },
  'image-nearest': {
    nodes: () => [bg(), ev('image', { asset: 'tiny', x: 20, y: 15, width: 120, height: 120, smoothing: 'nearest' }), ev('image', { asset: 'tiny', x: 145, y: 55, width: 40, height: 40 })],
  },
  video: {
    frame: 45,
    nodes: (f) => [bg(), ev('video', { asset: 'clip', x: 20, y: 15, width: 160, height: 120, startFrom: '1s', playbackRate: 2 }, [], { frame: f })],
  },
  sprite: {
    frame: 10,
    nodes: (f) => [bg(), ev('sprite', { asset: 'sheet', x: 50, y: 25, width: 100, height: 100, columns: 4, rows: 2, frameRate: 12, loop: true }, [], { frame: f })],
  },
  shader: {
    frame: 15,
    nodes: (f) => [
      ev(
        'shader',
        {
          x: 10,
          y: 10,
          width: 180,
          height: 130,
          uniforms: { tint: [1, 0.4, 0.2], rings: 12 },
          glsl: 'void mainImage(out vec4 fragColor, in vec2 fragCoord) { vec2 uv = fragCoord / resolution; float d = length(uv - 0.5); float s = 0.5 + 0.5 * sin(d * rings * 6.2831 - time * 4.0); fragColor = vec4(tint * s + vec3(0.0, uv.y * 0.5, 0.0), 1.0 - uv.x * 0.5); }',
        },
        [],
        { frame: f },
      ),
    ],
  },
  particles: {
    frame: 30,
    nodes: (f) => [
      ev('rect', { width: WIDTH, height: HEIGHT, fill: '#0B0D14' }),
      ev('particles', { x: 0, y: 0, width: 66, height: 150, count: 80, seed: 3, speed: { min: 20, max: 60 }, gravity: { x: 0, y: 30 }, size: { start: 8, end: 2 }, color: { start: '#FECA57', end: '#FF6B6B' } }, [], { frame: f }),
      ev('particles', { x: 66, y: 0, width: 66, height: 150, count: 60, seed: 4, shape: 'square', speed: { min: 20, max: 50 }, size: { start: 10, end: 4 }, color: { start: '#48DBFB', end: '#5F27CD' } }, [], { frame: f }),
      ev('particles', { x: 132, y: 0, width: 66, height: 150, count: 60, seed: 5, shape: 'spark', speed: { min: 40, max: 80 }, size: { start: 6, end: 3 }, color: { start: '#FFFFFF', end: '#FF9F43' } }, [], { frame: f }),
    ],
  },
  'mask-alpha': {
    nodes: () => [bg(), ev('image', { asset: 'photo', x: 20, y: 15, width: 160, height: 120 }, [], { mask: { node: ev('ellipse', { x: 20, y: 10, width: 120, height: 100, fill: { type: 'radial', stops: [{ offset: 0.5, color: '#FFFFFFFF' }, { offset: 1, color: '#FFFFFF00' }] } }), mode: 'alpha', invert: false } })],
  },
  'mask-luminance-invert': {
    nodes: () => [bg(), ev('rect', { x: 20, y: 15, width: 160, height: 120, fill: '#FF9F43' }, [], { mask: { node: ev('rect', { width: 160, height: 120, fill: linear('#FFFFFF', '#000000') }), mode: 'luminance', invert: true } })],
  },
  'reveal-wipe': {
    nodes: () => [bg(), ev('rect', { x: 20, y: 20, width: 160, height: 110, fill: '#54A0FF' }, [], { reveal: { shape: 'rect', direction: 'right', progress: 0.6 } })],
  },
  'reveal-iris': {
    nodes: () => [bg(), ev('rect', { x: 20, y: 20, width: 160, height: 110, fill: '#1DD1A1' }, [], { reveal: { shape: 'ellipse', direction: 'center', progress: 0.5 } })],
  },
  'blend-modes': {
    nodes: () => [
      ev('rect', { width: WIDTH, height: HEIGHT, fill: linear('#FF6B6B', '#48DBFB') }),
      ...['multiply', 'screen', 'difference', 'overlay'].map((mode, i) => ev('ellipse', { x: 10 + i * 47, y: 45, width: 60, height: 60, fill: '#FECA57', blendMode: mode })),
    ],
  },
  'blend-hue': {
    nodes: () => [
      ev('rect', { width: WIDTH, height: HEIGHT, fill: linear('#FF6B6B', '#48DBFB') }),
      ev('ellipse', { x: 20, y: 30, width: 90, height: 90, fill: '#1DD1A1', blendMode: 'hue' }),
      ev('rect', { x: 110, y: 30, width: 70, height: 90, fill: '#5F27CD', blendMode: 'hue' }),
    ],
  },
  'rich-text': {
    nodes: () => [
      bg(),
      ev('rich-text', {
        x: 10,
        y: 20,
        width: 180,
        fontSize: 22,
        fill: '#FFFFFF',
        spans: [
          { text: 'Rich ' },
          { text: 'text', fill: '#FECA57', fontWeight: 800 },
          { text: ' in ', fontStyle: 'italic' },
          { text: 'PixiJS <b>', fontSize: 30, fill: linear('#FF6B6B', '#48DBFB'), stroke: '#000000', strokeWidth: 1 },
        ],
      }),
    ],
  },
  'filters-blur': {
    nodes: () => [bg(), ev('rect', { x: 40, y: 35, width: 120, height: 80, fill: '#FF6B6B', filters: [{ type: 'blur', radius: 6 }] })],
  },
  'filters-color': {
    nodes: () => [
      ev('image', { asset: 'photo', x: 0, y: 0, width: 100, height: 75, filters: [{ type: 'grayscale', amount: 1 }] }),
      ev('image', { asset: 'photo', x: 100, y: 0, width: 100, height: 75, filters: [{ type: 'hue-rotate', degrees: 120 }] }),
      ev('image', { asset: 'photo', x: 0, y: 75, width: 100, height: 75, filters: [{ type: 'sepia', amount: 1 }, { type: 'contrast', amount: 1.5 }] }),
      ev('image', { asset: 'photo', x: 100, y: 75, width: 100, height: 75, filters: [{ type: 'invert', amount: 1 }] }),
    ],
  },
  'preview-scale': { scale: 0.5, nodes: () => [bg(), ev('ellipse', { x: 50, y: 25, width: 100, height: 100, fill: '#FF6B6B' }), ev('text', { x: 55, y: 60, text: 'half', fontSize: 28, fill: '#FFFFFF' })] },
};

/** Alle Testfälle nach Name. */
export const PIXI_CASES: Readonly<Record<string, PixiCase>> = cases;
