/**
 * Grafik-Komponenten: Logo, Cursor, Arrow, Connector, Grid, ParticleField,
 * GradientBackground, Spotlight, ProgressBar.
 */
import { random, type IrNode } from '@agentic-video/core';
import Type from 'typebox';
import { ColorProp, clamp01, defineComponent, framesOf, mix, withAlpha, type Pt } from '../define.js';
import { formatNumber } from './text.js';

const PointSchema = Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false });
const Time = Type.Union([Type.Number(), Type.String()]);

const LOGO_REVEALS = ['scale', 'mask', 'trim', 'none'] as const;

export const Logo = defineComponent({
  name: 'Logo',
  description:
    'Logo from an image asset (`asset`), an SVG asset (`svgAsset`), inline SVG (`markup`) or SVG path data (`path`, drawn in `color`). Reveal: `scale` (pop in), `mask` (wipe from left), `trim` (outline draws, then fill fades in; needs `path`, otherwise falls back to `mask`).',
  props: {
    asset: Type.Optional(Type.String({ description: 'Image asset id.' })),
    svgAsset: Type.Optional(Type.String({ description: 'SVG asset id.' })),
    markup: Type.Optional(Type.String({ description: 'Inline SVG markup.' })),
    path: Type.Optional(Type.String({ description: 'SVG path data in viewBox coordinates.' })),
    viewBox: Type.Optional(Type.Object({ width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }) }, { description: 'Coordinate size of `path`. Default: width × height.' })),
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    color: ColorProp('Color for `path`. Default: theme.colors.primary.'),
    reveal: Type.Optional(Type.Enum(LOGO_REVEALS)),
    duration: Type.Optional(Time),
  },
  example: { path: 'M 20 100 L 100 20 L 180 100 L 100 180 Z M 70 100 L 100 70 L 130 100 L 100 130 Z', viewBox: { width: 200, height: 200 }, width: 200, height: 200, reveal: 'trim' },
  enter: 'none',
  build({ p, ctx, theme }) {
    const width = p.num('width', 240);
    const height = p.num('height', 240);
    const dur = p.frames('duration', theme.motion.slow, ctx.fps);
    const color = p.color('color', theme.colors.primary);
    const path = p.optStr('path');
    let mode = p.oneOf('reveal', LOGO_REVEALS, 'scale');
    if (mode === 'trim' && path === undefined) mode = 'mask';
    const nodes: IrNode[] = [];
    if (path !== undefined) {
      const vb = p.raw['viewBox'];
      const vbw = typeof vb === 'object' && vb !== null && 'width' in vb && typeof vb.width === 'number' && vb.width > 0 ? vb.width : width;
      const vbh = typeof vb === 'object' && vb !== null && 'height' in vb && typeof vb.height === 'number' && vb.height > 0 ? vb.height : height;
      const s = Math.min(width / vbw, height / vbh);
      const shapes: IrNode[] =
        mode === 'trim'
          ? [
              { id: 'fill', type: 'path', d: path, fillRule: 'evenodd', fill: color, opacity: { $keyframes: [{ t: dur * 0.6, v: 0 }, { t: dur, v: 1, ease: theme.easing.enter }] } },
              { id: 'outline', type: 'path', d: path, stroke: mix(color, theme.colors.text, 0.3), strokeWidth: 3 / s, strokeJoin: 'round', trimEnd: { $keyframes: [{ t: 0, v: 0 }, { t: dur * 0.7, v: 1, ease: theme.easing.standard }] } },
            ]
          : [{ id: 'fill', type: 'path', d: path, fillRule: 'evenodd', fill: color }];
      nodes.push({ id: 'mark', type: 'group', x: (width - vbw * s) / 2, y: (height - vbh * s) / 2, width: vbw, height: vbh, origin: { x: 0, y: 0 }, scale: { x: s, y: s }, children: shapes });
    } else {
      const asset = p.optStr('asset');
      const svgAsset = p.optStr('svgAsset');
      const markup = p.optStr('markup');
      if (asset !== undefined) nodes.push({ id: 'mark', type: 'image', asset, width, height, fit: 'contain' });
      else if (svgAsset !== undefined || markup !== undefined) nodes.push({ id: 'mark', type: 'svg', ...(svgAsset !== undefined ? { asset: svgAsset } : {}), ...(markup !== undefined ? { markup } : {}), width, height, fit: 'contain' });
      else nodes.push({ id: 'mark', type: 'rect', width, height, cornerRadius: theme.radii.lg, fill: color });
    }
    if (mode === 'mask') {
      return {
        width,
        height,
        nodes: [{ id: 'reveal', type: 'group', width, height, mask: { node: { id: 'reveal-mask', type: 'rect', height, width: { $keyframes: [{ t: 0, v: 0 }, { t: dur, v: width, ease: theme.easing.standard }] }, fill: '#FFFFFF' } }, children: nodes }],
      };
    }
    if (mode === 'scale') {
      return {
        width,
        height,
        nodes: [
          {
            id: 'reveal',
            type: 'group',
            width,
            height,
            scale: { $keyframes: [{ t: 0, v: { x: 0.4, y: 0.4 } }, { t: dur, v: { x: 1, y: 1 }, ease: 'easeOutBack' }] },
            opacity: { $keyframes: [{ t: 0, v: 0 }, { t: dur * 0.5, v: 1, ease: theme.easing.enter }] },
            children: nodes,
          },
        ],
      };
    }
    return { width, height, nodes };
  },
});

/** Lineare Interpolation entlang von Punkten mit gleich langen Zeitabschnitten. */
function cursorKeys(points: readonly Pt[], start: number, dur: number, ease: string, axis: 'x' | 'y'): { t: number; v: number; ease?: string }[] {
  if (points.length === 1) return [{ t: 0, v: points[0]?.[axis] ?? 0 }];
  const step = dur / Math.max(1, points.length - 1);
  return points.map((pt, i) => (i === 0 ? { t: start, v: pt[axis] } : { t: start + i * step, v: pt[axis], ease }));
}

export const Cursor = defineComponent({
  name: 'Cursor',
  description: 'Mouse pointer that moves through `points` over `duration` (or follows an animated `position`) and shows a ripple at each time in `clicks`.',
  props: {
    points: Type.Optional(Type.Array(PointSchema, { description: 'Waypoints in local pixels.' })),
    position: Type.Optional(PointSchema),
    duration: Type.Optional(Time),
    delay: Type.Optional(Time),
    clicks: Type.Optional(Type.Array(Time, { description: 'Click times (local), e.g. ["1s", 45].' })),
    size: Type.Optional(Type.Number({ minimum: 4 })),
    color: ColorProp('Pointer fill. Default: theme.colors.text.'),
  },
  example: {
    points: [
      { x: 40, y: 40 },
      { x: 360, y: 180 },
      { x: 200, y: 320 },
    ],
    duration: '2s',
    clicks: ['1.2s'],
  },
  enter: 'fade',
  build({ p, ctx, theme }) {
    const size = p.num('size', 36);
    const k = size / 20;
    const pts = p.points('points');
    const position = p.has('position') ? p.point('position', { x: 0, y: 0 }) : undefined;
    const delay = p.frames('delay', 0, ctx.fps);
    const dur = p.frames('duration', theme.motion.slow, ctx.fps);
    const ease = theme.easing.standard;
    const clicks = (Array.isArray(p.raw['clicks']) ? p.raw['clicks'] : []).map((c) => framesOf(c, ctx.fps)).filter((c): c is number => c !== undefined).sort((a, b) => a - b);
    const rippleDur = framesOf(theme.motion.normal, ctx.fps) ?? 15;
    const press = Math.max(1, Math.round(ctx.fps * 0.08));
    const ripples: IrNode[] = clicks.map((c, i) => ({
      id: `ripple-${String(i)}`,
      type: 'ellipse',
      x: -size,
      y: -size,
      width: size * 2,
      height: size * 2,
      stroke: theme.colors.accent,
      strokeWidth: 3,
      fill: withAlpha(theme.colors.accent, 0.2),
      scale: { $keyframes: [{ t: c, v: { x: 0.1, y: 0.1 } }, { t: c + rippleDur, v: { x: 1, y: 1 }, ease: 'easeOutCubic' }] },
      opacity: { $keyframes: [{ t: c - 1, v: 0 }, { t: c, v: 1 }, { t: c + rippleDur, v: 0, ease: 'easeOutCubic' }] },
    }));
    const pressKeys = clicks.flatMap((c) => [
      { t: c - press, v: { x: 1, y: 1 } },
      { t: c, v: { x: 0.82, y: 0.82 } },
      { t: c + press * 2, v: { x: 1, y: 1 } },
    ]);
    const arrow: IrNode = {
      id: 'pointer',
      type: 'polygon',
      points: [
        [0, 0],
        [0, 17 * k],
        [4.4 * k, 13 * k],
        [7.4 * k, 19.8 * k],
        [10.2 * k, 18.6 * k],
        [7.3 * k, 12.1 * k],
        [13 * k, 12.1 * k],
      ],
      fill: p.color('color', theme.colors.text),
      stroke: theme.colors.background,
      strokeWidth: 1.5,
      strokeJoin: 'round',
      shadow: theme.shadows.sm,
      origin: { x: 0, y: 0 },
      ...(pressKeys.length > 0 ? { scale: { $keyframes: pressKeys } } : {}),
    };
    const move =
      position !== undefined
        ? { x: position.x, y: position.y }
        : pts.length > 0
          ? { x: { $keyframes: cursorKeys(pts, delay, dur, ease, 'x') }, y: { $keyframes: cursorKeys(pts, delay, dur, ease, 'y') } }
          : {};
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    return {
      width: Math.max(size, ...xs) + size,
      height: Math.max(size, ...ys) + size,
      nodes: [{ id: 'cursor', type: 'group', ...move, children: [...ripples, arrow] }],
    };
  },
});

/** Pfeilspitze als Dreieck an `tip`, ausgerichtet entlang des Winkels `angle` (Radiant). */
function head(id: string, tip: Pt, angle: number, size: number, fill: string, opacity: OpacityValue): IrNode {
  const back = (a: number) => [tip.x - size * Math.cos(angle + a), tip.y - size * Math.sin(angle + a)] as const;
  const [ax, ay] = back(0.45);
  const [bx, by] = back(-0.45);
  return {
    id,
    type: 'polygon',
    points: [
      [tip.x, tip.y],
      [ax, ay],
      [bx, by],
    ],
    fill,
    strokeJoin: 'round',
    opacity,
  };
}

type OpacityValue = number | { $keyframes: { t: number; v: number; ease?: string }[] };

function bounds(points: readonly Pt[], pad: number): { width: number; height: number } {
  return { width: Math.max(0, ...points.map((q) => q.x)) + pad, height: Math.max(0, ...points.map((q) => q.y)) + pad };
}

export const Arrow = defineComponent({
  name: 'Arrow',
  description: 'Arrow from `from` to `to` that draws itself (trim) and then shows its head. `curve` bends it (fraction of its length, sign = side).',
  props: {
    from: PointSchema,
    to: PointSchema,
    curve: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
    color: ColorProp('Default: theme.colors.primary.'),
    strokeWidth: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    headSize: Type.Optional(Type.Number({ minimum: 0 })),
    dashed: Type.Optional(Type.Boolean()),
    duration: Type.Optional(Time),
  },
  example: { from: { x: 20, y: 200 }, to: { x: 380, y: 40 }, curve: 0.25 },
  enter: 'none',
  build({ p, ctx, theme }) {
    const a = p.point('from', { x: 0, y: 0 });
    const b = p.point('to', { x: 200, y: 0 });
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const curve = p.num('curve', 0.2);
    const nx = len > 0 ? -(b.y - a.y) / len : 0;
    const ny = len > 0 ? (b.x - a.x) / len : 0;
    const c = { x: (a.x + b.x) / 2 + nx * curve * len, y: (a.y + b.y) / 2 + ny * curve * len };
    const color = p.color('color', theme.colors.primary);
    const sw = p.num('strokeWidth', 6);
    const hs = p.num('headSize', sw * 4);
    const dur = p.frames('duration', theme.motion.normal, ctx.fps);
    const angle = Math.atan2(b.y - c.y, b.x - c.x);
    // Linie endet vor der Spitze, damit die Spitze scharf bleibt.
    const end = { x: b.x - Math.cos(angle) * hs * 0.6, y: b.y - Math.sin(angle) * hs * 0.6 };
    const d = `M ${String(a.x)} ${String(a.y)} Q ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    const nodes: IrNode[] = [
      { id: 'shaft', type: 'path', d, stroke: color, strokeWidth: sw, strokeCap: 'round', ...(p.bool('dashed', false) ? { strokeDash: [sw * 2.5, sw * 2] } : {}), trimEnd: { $keyframes: [{ t: 0, v: 0 }, { t: dur, v: 1, ease: theme.easing.standard }] } },
      head('head', b, angle, hs, color, { $keyframes: [{ t: dur * 0.85, v: 0 }, { t: dur, v: 1 }] }),
    ];
    return { ...bounds([a, b, c], sw + hs), nodes };
  },
});

const CONNECTOR_STYLES = ['straight', 'elbow', 'curve'] as const;

export const Connector = defineComponent({
  name: 'Connector',
  description: 'Diagram connector between two points: straight, elbow or curve, with end dots, optional arrow head and a pulse that travels along it.',
  props: {
    from: PointSchema,
    to: PointSchema,
    style: Type.Optional(Type.Enum(CONNECTOR_STYLES)),
    color: ColorProp('Default: theme.colors.accent.'),
    strokeWidth: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    arrow: Type.Optional(Type.Boolean()),
    pulse: Type.Optional(Type.Boolean({ description: 'A dot travels along the line (loops). Default true.' })),
    dashed: Type.Optional(Type.Boolean()),
    duration: Type.Optional(Time),
  },
  example: { from: { x: 20, y: 40 }, to: { x: 380, y: 220 }, style: 'elbow', arrow: true },
  enter: 'none',
  build({ p, ctx, theme }) {
    const a = p.point('from', { x: 0, y: 0 });
    const b = p.point('to', { x: 200, y: 100 });
    const style = p.oneOf('style', CONNECTOR_STYLES, 'elbow');
    const color = p.color('color', theme.colors.accent);
    const sw = p.num('strokeWidth', 3);
    const dur = p.frames('duration', theme.motion.normal, ctx.fps);
    const f = (n: number) => n.toFixed(2);
    const mx = (a.x + b.x) / 2;
    const d =
      style === 'straight'
        ? `M ${f(a.x)} ${f(a.y)} L ${f(b.x)} ${f(b.y)}`
        : style === 'elbow'
          ? `M ${f(a.x)} ${f(a.y)} L ${f(mx)} ${f(a.y)} L ${f(mx)} ${f(b.y)} L ${f(b.x)} ${f(b.y)}`
          : `M ${f(a.x)} ${f(a.y)} C ${f(mx)} ${f(a.y)} ${f(mx)} ${f(b.y)} ${f(b.x)} ${f(b.y)}`;
    const dot = sw * 3;
    const draw = { $keyframes: [{ t: 0, v: 0 }, { t: dur, v: 1, ease: theme.easing.standard }] };
    const nodes: IrNode[] = [
      { id: 'line', type: 'path', d, stroke: color, strokeWidth: sw, strokeJoin: 'round', strokeCap: 'round', ...(p.bool('dashed', false) ? { strokeDash: [sw * 3, sw * 2] } : {}), trimEnd: draw },
      { id: 'start', type: 'ellipse', x: a.x - dot / 2, y: a.y - dot / 2, width: dot, height: dot, fill: color },
    ];
    // Richtung am Ende: bei elbow und curve horizontal
    const endAngle = style === 'straight' ? Math.atan2(b.y - a.y, b.x - a.x) : b.x >= a.x ? 0 : Math.PI;
    if (p.bool('arrow', false)) nodes.push(head('head', b, endAngle, sw * 5, color, { $keyframes: [{ t: dur * 0.9, v: 0 }, { t: dur, v: 1 }] }));
    else nodes.push({ id: 'end', type: 'ellipse', x: b.x - dot / 2, y: b.y - dot / 2, width: dot, height: dot, fill: color, opacity: { $keyframes: [{ t: dur * 0.9, v: 0 }, { t: dur, v: 1 }] } });
    if (p.bool('pulse', true)) {
      const r = sw * 2;
      const loop = (framesOf(theme.motion.slow, ctx.fps) ?? 30) * 1.5;
      nodes.push({
        id: 'pulse',
        type: 'ellipse',
        x: -r,
        y: -r,
        width: r * 2,
        height: r * 2,
        fill: mix(color, '#FFFFFF', 0.5),
        shadow: { color: color, blur: r * 2 },
        motionPath: { d, progress: { $keyframes: [{ t: dur, v: 0 }, { t: dur + loop, v: 1, ease: theme.easing.standard }], loop: 'repeat' } },
        opacity: { $keyframes: [{ t: dur, v: 0 }, { t: dur + 1, v: 1 }] },
      });
    }
    return { ...bounds([a, b], dot + sw * 5), nodes };
  },
});

export const Grid = defineComponent({
  name: 'Grid',
  description: 'Background grid of lines or dots with major lines, an optional drift and a radial fade toward the edges.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    spacing: Type.Optional(Type.Number({ minimum: 4, description: 'Cell size. Default theme.spacing.xl.' })),
    majorEvery: Type.Optional(Type.Integer({ minimum: 0, description: 'Every n-th line is stronger. 0 = none. Default 4.' })),
    style: Type.Optional(Type.Union([Type.Literal('lines'), Type.Literal('dots')])),
    drift: Type.Optional(PointSchema),
    fade: Type.Optional(Type.Boolean()),
    color: ColorProp('Default: theme.colors.muted.'),
  },
  example: { style: 'lines', majorEvery: 4, drift: { x: 10, y: 0 } },
  exit: 'none',
  build({ p, ctx, theme }) {
    const width = p.num('width', ctx.compositionWidth);
    const height = p.num('height', ctx.compositionHeight);
    const s = Math.max(4, p.num('spacing', theme.spacing.xl));
    const major = Math.max(0, Math.round(p.num('majorEvery', 4)));
    const drift = p.point('drift', { x: 0, y: 0 });
    const t = ctx.frame / ctx.fps;
    const ox = (((drift.x * t) % (s * Math.max(1, major))) + s * Math.max(1, major)) % (s * Math.max(1, major));
    const oy = (((drift.y * t) % (s * Math.max(1, major))) + s * Math.max(1, major)) % (s * Math.max(1, major));
    const color = p.color('color', theme.colors.muted);
    const f = (n: number) => n.toFixed(1);
    let minor = '';
    let strong = '';
    const dots = p.oneOf('style', ['lines', 'dots'], 'lines') === 'dots';
    const cols: number[] = [];
    const rows: number[] = [];
    for (let x = ox - s * Math.max(1, major); x <= width; x += s) cols.push(x);
    for (let y = oy - s * Math.max(1, major); y <= height; y += s) rows.push(y);
    const isMajor = (idx: number) => major > 0 && idx % major === 0;
    if (dots) {
      cols.forEach((x, ci) => {
        rows.forEach((y, ri) => {
          const r = isMajor(ci) && isMajor(ri) ? 2.5 : 1.5;
          const seg = `M ${f(x - r)} ${f(y - r)} h ${f(r * 2)} v ${f(r * 2)} h ${f(-r * 2)} Z `;
          if (r > 2) strong += seg;
          else minor += seg;
        });
      });
    } else {
      cols.forEach((x, ci) => {
        const seg = `M ${f(x)} 0 V ${f(height)} `;
        if (isMajor(ci)) strong += seg;
        else minor += seg;
      });
      rows.forEach((y, ri) => {
        const seg = `M 0 ${f(y)} H ${f(width)} `;
        if (isMajor(ri)) strong += seg;
        else minor += seg;
      });
    }
    const shapes: IrNode[] = [];
    if (minor !== '') shapes.push(dots ? { id: 'minor', type: 'path', d: minor.trim(), fill: withAlpha(color, 0.35) } : { id: 'minor', type: 'path', d: minor.trim(), stroke: withAlpha(color, 0.18), strokeWidth: 1 });
    if (strong !== '') shapes.push(dots ? { id: 'major', type: 'path', d: strong.trim(), fill: withAlpha(color, 0.6) } : { id: 'major', type: 'path', d: strong.trim(), stroke: withAlpha(color, 0.35), strokeWidth: 1.5 });
    const fade = p.bool('fade', true);
    return {
      width,
      height,
      nodes: [
        {
          id: 'grid',
          type: 'group',
          width,
          height,
          clip: true,
          ...(fade
            ? {
                mask: {
                  node: {
                    id: 'grid-fade',
                    type: 'rect',
                    width,
                    height,
                    fill: { type: 'radial', center: { x: 0.5, y: 0.5 }, radius: 0.6, stops: [{ offset: 0, color: '#FFFFFFFF' }, { offset: 0.55, color: '#FFFFFFCC' }, { offset: 1, color: '#FFFFFF00' }] },
                  },
                },
              }
            : {}),
          children: shapes,
        },
      ],
    };
  },
});

export const ParticleField = defineComponent({
  name: 'ParticleField',
  description: 'Ambient particle field (seeded, deterministic) drifting upward across the box. Colors fade from theme.colors.primary to theme.colors.accent. Pre-warmed: particles are visible from frame 0.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
    speed: Type.Optional(Type.Number({ minimum: 0, description: 'Mean speed in px/s. Default 30.' })),
    size: Type.Optional(Type.Number({ minimum: 0.5, description: 'Start size in px. Default 6.' })),
    direction: Type.Optional(Type.Number({ description: 'Drift direction in degrees (0 = right, 270 = up). Default 270.' })),
    colorStart: ColorProp('Default: theme.colors.primary.'),
    colorEnd: ColorProp('Default: theme.colors.accent.'),
  },
  example: { count: 150 },
  exit: 'fade',
  build({ p, ctx, theme }) {
    const width = p.num('width', ctx.compositionWidth);
    const height = p.num('height', ctx.compositionHeight);
    const speed = p.num('speed', 30);
    const lifeMax = Math.max(2, (Math.max(width, height) / Math.max(1, speed)) * 0.6);
    const prewarm = Math.round(lifeMax * ctx.fps);
    const dir = p.num('direction', 270);
    const seed = Math.floor(random(ctx.seed, ctx.id, 'particle-field') * 2147483647);
    const size = p.num('size', 6);
    return {
      width,
      height,
      nodes: [
        {
          id: 'field',
          type: 'group',
          width,
          height,
          clip: true,
          children: [
            {
              id: 'particles',
              type: 'particles',
              timing: { from: -prewarm, duration: ctx.durationFrames + prewarm },
              width,
              height,
              count: Math.round(p.num('count', 160)),
              seed,
              emitter: { x: width / 2, y: height / 2, radius: Math.max(width, height) / 2, shape: 'rect' },
              lifetime: { min: lifeMax * 0.5, max: lifeMax },
              speed: { min: speed * 0.4, max: speed * 1.6 },
              angle: { min: dir - 25, max: dir + 25 },
              size: { start: size, end: size * 0.2 },
              fade: { start: 0.2, end: 0.4 },
              color: { start: p.color('colorStart', theme.colors.primary), end: p.color('colorEnd', theme.colors.accent) },
              emitDuration: ctx.durationFrames + prewarm,
            },
          ],
        },
      ],
    };
  },
});

export const GradientBackground = defineComponent({
  name: 'GradientBackground',
  description: 'Full-frame animated background: a slowly rotating linear gradient from theme colors plus soft, drifting color blobs.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    colors: Type.Optional(Type.Array(Type.String(), { minItems: 2, description: 'Gradient colors. Default: background, primary and secondary tints.' })),
    angle: Type.Optional(Type.Number({ description: 'Start angle in degrees. Default 135.' })),
    speed: Type.Optional(Type.Number({ description: 'Rotation in degrees per second. Default 8.' })),
    blobs: Type.Optional(Type.Boolean({ description: 'Soft drifting blobs. Default true.' })),
  },
  example: { angle: 135, speed: 8 },
  exit: 'none',
  build({ p, ctx, theme }) {
    const width = p.num('width', ctx.compositionWidth);
    const height = p.num('height', ctx.compositionHeight);
    const c = theme.colors;
    const given = p.strings('colors').filter((x) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.test(x));
    const colors = given.length >= 2 ? given : [c.background, mix(c.background, c.primary, 0.35), mix(c.background, c.secondary, 0.3)];
    const t = ctx.frame / ctx.fps;
    const a = ((p.num('angle', 135) + p.num('speed', 8) * t) * Math.PI) / 180;
    const dx = Math.cos(a) * 0.5;
    const dy = Math.sin(a) * 0.5;
    const nodes: IrNode[] = [
      {
        id: 'gradient',
        type: 'rect',
        width,
        height,
        fill: { type: 'linear', start: { x: 0.5 - dx, y: 0.5 - dy }, end: { x: 0.5 + dx, y: 0.5 + dy }, stops: colors.map((color, i) => ({ offset: i / (colors.length - 1), color })) },
      },
    ];
    if (p.bool('blobs', true)) {
      const size = Math.max(width, height) * 0.55;
      [c.primary, c.secondary, c.accent].forEach((color, i) => {
        const phase = random(ctx.seed, ctx.id, 'blob', i) * Math.PI * 2;
        const bx = width * (0.2 + 0.3 * i) - size / 2;
        const by = height * (0.3 + 0.2 * ((i + 1) % 2)) - size / 2;
        const amp = Math.min(width, height) * 0.08;
        nodes.push({
          id: `blob-${String(i)}`,
          type: 'ellipse',
          x: { $expr: `${bx.toFixed(2)} + sin(time * ${(0.25 + i * 0.07).toFixed(2)} + ${phase.toFixed(3)}) * ${amp.toFixed(2)}` },
          y: { $expr: `${by.toFixed(2)} + cos(time * ${(0.2 + i * 0.05).toFixed(2)} + ${phase.toFixed(3)}) * ${amp.toFixed(2)}` },
          width: size,
          height: size,
          fill: { type: 'radial', stops: [{ offset: 0, color: withAlpha(color, 0.35) }, { offset: 1, color: withAlpha(color, 0) }] },
          blendMode: 'screen',
        });
      });
    }
    return { width, height, nodes: [{ id: 'background', type: 'group', width, height, clip: true, children: nodes }] };
  },
});

export const Spotlight = defineComponent({
  name: 'Spotlight',
  description: 'Dims the frame except a soft circle around `target`. The circle closes in from a larger size (iris). Animate `target` or `radius` to move it.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    target: Type.Optional(PointSchema),
    radius: Type.Optional(Type.Number({ minimum: 1 })),
    softness: Type.Optional(Type.Number({ minimum: 0, description: 'Edge blur in px. Default 24.' })),
    dim: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'Darkness outside the circle. Default 0.7.' })),
    ring: Type.Optional(Type.Boolean()),
    color: ColorProp('Dim color. Default: theme.colors.background.'),
  },
  example: { target: { x: 640, y: 360 }, radius: 160 },
  build({ p, ctx, theme }) {
    const width = p.num('width', ctx.compositionWidth);
    const height = p.num('height', ctx.compositionHeight);
    const target = p.point('target', { x: width / 2, y: height / 2 });
    const r = p.num('radius', 180);
    const dur = framesOf(theme.motion.slow, ctx.fps) ?? 30;
    const iris = { $keyframes: [{ t: 0, v: { x: 3, y: 3 } }, { t: dur, v: { x: 1, y: 1 }, ease: theme.easing.standard }] };
    const nodes: IrNode[] = [
      {
        id: 'dim',
        type: 'rect',
        width,
        height,
        fill: withAlpha(p.color('color', theme.colors.background), p.num('dim', 0.7)),
        mask: { invert: true, node: { id: 'hole', type: 'ellipse', x: target.x - r, y: target.y - r, width: r * 2, height: r * 2, fill: '#FFFFFF', scale: iris, filters: [{ type: 'blur', radius: p.num('softness', 24) }] } },
      },
    ];
    if (p.bool('ring', true)) nodes.push({ id: 'ring', type: 'ellipse', x: target.x - r, y: target.y - r, width: r * 2, height: r * 2, stroke: withAlpha(theme.colors.accent, 0.7), strokeWidth: 2, scale: iris });
    return { width, height, nodes };
  },
});

export const ProgressBar = defineComponent({
  name: 'ProgressBar',
  description: 'Rounded progress bar with gradient fill and optional percentage label. `progress` (0..1) drives it; without it the bar fills over `duration` (default: the component\'s duration).',
  props: {
    progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    duration: Type.Optional(Time),
    delay: Type.Optional(Time),
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    label: Type.Optional(Type.Boolean({ description: 'Show a percentage label. Default true.' })),
    color: ColorProp('Default: theme.colors.primary.'),
  },
  example: { width: 640, label: true },
  enter: 'fade',
  build({ p, ctx, theme }) {
    const width = p.num('width', 600);
    const h = p.num('height', theme.spacing.md);
    const dur = p.frames('duration', ctx.durationFrames, ctx.fps);
    const delay = p.frames('delay', 0, ctx.fps);
    const direct = p.optNum('progress');
    const k = direct !== undefined ? clamp01(direct) : dur > 0 ? clamp01((ctx.frame - delay) / dur) : 1;
    const color = p.color('color', theme.colors.primary);
    const showLabel = p.bool('label', true);
    const fs = theme.fontSizes.xs;
    const top = showLabel ? fs * 1.6 : 0;
    const nodes: IrNode[] = [
      { id: 'track', type: 'rect', y: top, width, height: h, cornerRadius: h / 2, fill: withAlpha(theme.colors.muted, 0.25) },
      {
        id: 'fill',
        type: 'rect',
        y: top,
        width: width * k,
        height: h,
        cornerRadius: Math.min(h / 2, (width * k) / 2),
        fill: { type: 'linear', stops: [{ offset: 0, color }, { offset: 1, color: mix(color, theme.colors.accent, 0.6) }] },
      },
    ];
    if (showLabel) nodes.push({ id: 'label', type: 'text', text: `${formatNumber(k * 100, 0, ',', '.')}%`, width, textAlign: 'right', fontFamily: theme.fonts.body, fontSize: fs, fontWeight: 700, fontFeatures: { tnum: 1 }, fill: theme.colors.text });
    return { width, height: top + h, nodes };
  },
});
