/**
 * Flächen und Rahmen: Card, GlassPanel, BrowserWindow, DeviceFrame, Phone, Laptop.
 * Kind-Nodes (`children`) erscheinen im Inhaltsbereich.
 */
import type { IrNode } from '@agentic-video/core';
import Type from 'typebox';
import { ColorProp, defineComponent, mix, withAlpha, type BuildInput, type Built } from '../define.js';

const Children = Type.Optional(Type.Array(Type.Unknown(), { description: 'Child nodes shown in the content area (node children or props.children).' }));

/** Bildschirmfläche mit abgerundeter Maske, Hintergrund und Kindern. */
function screen(x: number, y: number, width: number, height: number, radius: number, bg: string, children: IrNode[]): IrNode {
  return {
    id: 'screen',
    type: 'group',
    x,
    y,
    width,
    height,
    mask: { node: { id: 'screen-mask', type: 'rect', width, height, cornerRadius: radius, fill: '#FFFFFF' } },
    children: [{ id: 'screen-bg', type: 'rect', width, height, fill: bg }, { id: 'content', type: 'group', width, height, children }],
  };
}

export const Card = defineComponent({
  name: 'Card',
  description: 'Rounded surface with shadow, optional title, body text and children below the text.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    title: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    accent: ColorProp('Color of the top strip. Default: theme.colors.primary. Use "transparent" to hide it.'),
    children: Children,
  },
  example: { title: 'Render farm', body: 'Split frames across workers and stitch them losslessly.', width: 480, height: 260 },
  enter: 'slide-up',
  build({ p, theme }) {
    const width = p.num('width', 480);
    const height = p.num('height', 320);
    const pad = theme.spacing.lg;
    const r = theme.radii.lg;
    const nodes: IrNode[] = [
      { id: 'bg', type: 'rect', width, height, cornerRadius: r, fill: theme.colors.surface, stroke: withAlpha(theme.colors.text, 0.08), strokeWidth: 1, shadow: theme.shadows.md },
      {
        id: 'strip',
        type: 'group',
        width,
        height,
        mask: { node: { id: 'strip-mask', type: 'rect', width, height, cornerRadius: r, fill: '#FFFFFF' } },
        children: [{ id: 'strip-bar', type: 'rect', width, height: theme.spacing.sm, fill: p.color('accent', theme.colors.primary) }],
      },
    ];
    let y = pad + theme.spacing.sm;
    const title = p.optStr('title');
    if (title !== undefined) {
      nodes.push({ id: 'title', type: 'text', text: title, x: pad, y, width: width - pad * 2, maxLines: 2, ellipsis: '…', fontFamily: theme.fonts.heading, fontSize: theme.fontSizes.md, fontWeight: 700, fill: theme.colors.text });
      y += theme.fontSizes.md * 1.2 + theme.spacing.sm;
    }
    const body = p.optStr('body');
    if (body !== undefined) {
      nodes.push({ id: 'body', type: 'text', text: body, x: pad, y, width: width - pad * 2, fontFamily: theme.fonts.body, fontSize: theme.fontSizes.sm, lineHeight: 1.4, fill: theme.colors.muted });
      y += theme.fontSizes.sm * 1.4 * 2 + theme.spacing.md;
    }
    const children = p.children();
    if (children.length > 0) nodes.push({ id: 'content', type: 'group', x: pad, y, width: width - pad * 2, height: Math.max(0, height - y - pad), clip: true, children });
    return { width, height, nodes };
  },
});

export const GlassPanel = defineComponent({
  name: 'GlassPanel',
  description:
    'Translucent panel with border, shadow and a gloss gradient. Real backdrop blur (blurring what lies behind the panel) is not possible in a pure node tree; `childBlur` blurs only the panel\'s own children through a layer with a blur effect.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 1 })),
    height: Type.Optional(Type.Number({ minimum: 1 })),
    tint: ColorProp('Glass tint. Default: theme.colors.text (light glass on dark themes).'),
    opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'Tint strength. Default 0.1.' })),
    childBlur: Type.Optional(Type.Number({ minimum: 0, description: 'Blur radius for the children (layer effect). Default 0.' })),
    children: Children,
  },
  example: { width: 520, height: 300, children: [{ id: 'label', type: 'text', text: 'Glass', x: 32, y: 32, fontSize: 48, fill: '#FFFFFF' }] },
  build({ p, theme }) {
    const width = p.num('width', 480);
    const height = p.num('height', 320);
    const tint = p.color('tint', theme.colors.text);
    const r = theme.radii.lg;
    const blur = p.num('childBlur', 0);
    const children = p.children();
    const nodes: IrNode[] = [
      { id: 'bg', type: 'rect', width, height, cornerRadius: r, fill: withAlpha(tint, p.num('opacity', 0.1)), shadow: theme.shadows.lg },
      {
        id: 'gloss',
        type: 'rect',
        width,
        height,
        cornerRadius: r,
        fill: { type: 'linear', start: { x: 0, y: 0 }, end: { x: 0.6, y: 1 }, stops: [{ offset: 0, color: withAlpha(tint, 0.22) }, { offset: 0.45, color: withAlpha(tint, 0.04) }, { offset: 1, color: withAlpha(tint, 0) }] },
      },
      { id: 'border', type: 'rect', width, height, cornerRadius: r, stroke: withAlpha(tint, 0.3), strokeWidth: 1.5 },
      { id: 'tint-edge', type: 'rect', x: r, width: width - r * 2, height: 1.5, fill: withAlpha(theme.colors.accent, 0.6) },
    ];
    if (children.length > 0) {
      nodes.push(blur > 0 ? { id: 'content', type: 'layer', width, height, effects: [{ type: 'blur', radius: blur }], children } : { id: 'content', type: 'group', width, height, children });
    }
    return { width, height, nodes };
  },
});

export const BrowserWindow = defineComponent({
  name: 'BrowserWindow',
  description: 'Browser window mockup with traffic-light buttons, address bar and a content area for children.',
  props: {
    width: Type.Optional(Type.Number({ minimum: 120 })),
    height: Type.Optional(Type.Number({ minimum: 80 })),
    url: Type.Optional(Type.String()),
    children: Children,
  },
  example: {
    url: 'https://openvideo.dev',
    width: 960,
    height: 560,
    children: [
      { id: 'hero', type: 'text', text: 'Video as code', x: 48, y: 64, fontSize: 56, fontWeight: 800, fill: '#FFFFFF' },
      { id: 'cta', type: 'rect', x: 48, y: 160, width: 200, height: 56, cornerRadius: 12, fill: '#4F7CFF' },
    ],
  },
  enter: 'slide-up',
  build({ p, theme }) {
    const width = p.num('width', 960);
    const height = p.num('height', 600);
    const bar = 48;
    const r = theme.radii.md;
    const c = theme.colors;
    const chrome = mix(c.surface, c.text, 0.06);
    const dots: IrNode[] = [c.danger, c.warning, c.success].map((fill, i) => ({ id: `dot-${String(i)}`, type: 'ellipse', x: 18 + i * 22, y: bar / 2 - 7, width: 14, height: 14, fill }));
    const urlX = 96;
    const nodes: IrNode[] = [
      { id: 'frame', type: 'rect', width, height, cornerRadius: r, fill: chrome, shadow: theme.shadows.lg },
      ...dots,
      { id: 'address', type: 'rect', x: urlX, y: 10, width: Math.max(0, width - urlX - 24), height: bar - 20, cornerRadius: (bar - 20) / 2, fill: withAlpha(c.background, 0.7) },
      {
        id: 'url',
        type: 'text',
        text: p.str('url', 'https://example.com'),
        x: urlX + 16,
        y: bar / 2 - theme.fontSizes.xs * 0.6,
        width: Math.max(0, width - urlX - 56),
        maxLines: 1,
        ellipsis: '…',
        fontFamily: theme.fonts.body,
        fontSize: theme.fontSizes.xs,
        fill: c.muted,
      },
      screen(0, bar, width, height - bar, 0, c.background, p.children()),
    ];
    return { width, height, nodes };
  },
});

const DEVICES = ['phone', 'tablet', 'laptop', 'desktop'] as const;
type Device = (typeof DEVICES)[number];

/** Baut einen Geräterahmen; `width` ist die Breite des Gehäuses. */
function device(kind: Device, { p, theme }: BuildInput): Built {
  const c = theme.colors;
  const body = p.color('bodyColor', mix(c.surface, '#000000', 0.55));
  const screenBg = p.color('screenColor', mix(c.background, c.primary, 0.12));
  const children = p.children();
  const edge = withAlpha(c.text, 0.18);
  if (kind === 'phone' || kind === 'tablet') {
    const width = p.num('width', kind === 'phone' ? 360 : 600);
    const height = width * (kind === 'phone' ? 2.05 : 1.36);
    const bezel = width * (kind === 'phone' ? 0.035 : 0.05);
    const r = width * (kind === 'phone' ? 0.15 : 0.07);
    const nodes: IrNode[] = [
      { id: 'body', type: 'rect', width, height, cornerRadius: r, fill: body, stroke: edge, strokeWidth: 2, shadow: theme.shadows.lg },
      screen(bezel, bezel, width - bezel * 2, height - bezel * 2, Math.max(0, r - bezel), screenBg, children),
    ];
    if (kind === 'phone') {
      const iw = width * 0.3;
      nodes.push(
        { id: 'island', type: 'rect', x: (width - iw) / 2, y: bezel + width * 0.03, width: iw, height: width * 0.085, cornerRadius: width * 0.0425, fill: '#000000' },
        { id: 'button-power', type: 'rect', x: width - 1, y: height * 0.22, width: 4, height: height * 0.1, cornerRadius: 2, fill: body },
        { id: 'button-volume', type: 'rect', x: -3, y: height * 0.18, width: 4, height: height * 0.07, cornerRadius: 2, fill: body },
      );
    } else {
      nodes.push({ id: 'camera', type: 'ellipse', x: width / 2 - 5, y: bezel / 2 - 5, width: 10, height: 10, fill: withAlpha(c.text, 0.3) });
    }
    return { width, height, nodes };
  }
  const width = p.num('width', kind === 'laptop' ? 960 : 900);
  const lidH = width * 0.63;
  const bezel = width * 0.025;
  const r = width * 0.025;
  const screenAt = (x: number) => screen(x, bezel * 1.4, width - bezel * 2, lidH - bezel * 2.4, 4, screenBg, children);
  if (kind === 'laptop') {
    const over = width * 0.07;
    const baseH = width * 0.035;
    const nodes: IrNode[] = [
      { id: 'lid', type: 'rect', x: over, width, height: lidH, cornerRadius: [r, r, 0, 0], fill: body, stroke: edge, strokeWidth: 2 },
      screenAt(over + bezel),
      { id: 'camera', type: 'ellipse', x: over + width / 2 - 4, y: bezel * 0.45, width: 8, height: 8, fill: withAlpha(c.text, 0.3) },
      {
        id: 'base',
        type: 'polygon',
        points: [
          [0, lidH],
          [width + over * 2, lidH],
          [width + over * 1.6, lidH + baseH],
          [over * 0.4, lidH + baseH],
        ],
        fill: mix(body, c.text, 0.18),
        shadow: theme.shadows.lg,
      },
      { id: 'notch', type: 'rect', x: over + width / 2 - width * 0.08, y: lidH, width: width * 0.16, height: baseH * 0.35, cornerRadius: [0, 0, 6, 6], fill: body },
    ];
    return { width: width + over * 2, height: lidH + baseH, nodes };
  }
  const standH = width * 0.12;
  const nodes: IrNode[] = [
    {
      id: 'stand',
      type: 'polygon',
      points: [
        [width * 0.44, lidH - 2],
        [width * 0.56, lidH - 2],
        [width * 0.6, lidH + standH],
        [width * 0.4, lidH + standH],
      ],
      fill: mix(body, c.text, 0.12),
    },
    { id: 'foot', type: 'rect', x: width * 0.3, y: lidH + standH - 4, width: width * 0.4, height: 10, cornerRadius: 5, fill: mix(body, c.text, 0.18) },
    { id: 'monitor', type: 'rect', width, height: lidH, cornerRadius: r, fill: body, stroke: edge, strokeWidth: 2, shadow: theme.shadows.lg },
    screenAt(bezel),
  ];
  return { width, height: lidH + standH + 6, nodes };
}

const DeviceProps = {
  width: Type.Optional(Type.Number({ minimum: 40, description: 'Body width in pixels.' })),
  bodyColor: ColorProp('Body color. Default: theme.colors.surface darkened.'),
  screenColor: ColorProp('Screen background. Default: theme.colors.background tinted with theme.colors.primary.'),
  children: Children,
};

const screenDemo = [{ id: 'hello', type: 'text', text: 'Hello', x: 24, y: 80, fontSize: 40, fontWeight: 700, fill: '#FFFFFF' }];

export const DeviceFrame = defineComponent({
  name: 'DeviceFrame',
  description: 'Device mockup (`device`: phone, tablet, laptop, desktop). Children render inside the screen, clipped to its rounded corners.',
  props: { device: Type.Optional(Type.Enum(DEVICES)), ...DeviceProps },
  example: { device: 'tablet', width: 480, children: screenDemo },
  enter: 'slide-up',
  build: (input) => device(input.p.oneOf('device', DEVICES, 'phone'), input),
});

export const Phone = defineComponent({
  name: 'Phone',
  description: 'Smartphone mockup with dynamic island and side buttons. Children render inside the screen.',
  props: DeviceProps,
  example: { width: 320, children: screenDemo },
  enter: 'slide-up',
  build: (input) => device('phone', input),
});

export const Laptop = defineComponent({
  name: 'Laptop',
  description: 'Laptop mockup with lid, camera and base. `width` is the lid width. Children render inside the screen.',
  props: DeviceProps,
  example: { width: 800, children: screenDemo },
  enter: 'slide-up',
  build: (input) => device('laptop', input),
});
