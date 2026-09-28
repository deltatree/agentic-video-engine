/**
 * Text-Komponenten: Title, Subtitle, LowerThird, Callout, Badge, Counter, Typewriter.
 */
import { easing, luminance, parseColor, type IrNode, type NodeOf } from '@agentic-video/core';
import Type from 'typebox';
import { ColorProp, clamp01, defineComponent, estimateTextWidth, framesOf, withAlpha, type Props } from '../define.js';
import type { ResolvedTheme } from '../theme.js';

const Align = Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')]));
const ALIGNS = ['left', 'center', 'right'] as const;
const REVEALS = ['words', 'chars', 'lines', 'none'] as const;

/**
 * Wählt die Theme-Textfarbe mit dem besseren Kontrast auf einer Hintergrundfarbe.
 *
 * @example
 * ```ts
 * contrastOn('#FFFFFF', DEFAULT_THEME); // DEFAULT_THEME.colors.background (dunkel)
 * ```
 */
export function contrastOn(bg: string, theme: ResolvedTheme): string {
  const lum = (c: string) => {
    const x = parseColor(c);
    return luminance(x.r, x.g, x.b);
  };
  const b = lum(bg);
  const a = theme.colors.text;
  const c = theme.colors.background;
  return Math.abs(lum(a) - b) >= Math.abs(lum(c) - b) ? a : c;
}

/** Text-Animation je Wort/Zeichen/Zeile aus Theme-Timing. */
function reveal(p: Props, theme: ResolvedTheme, fallback: (typeof REVEALS)[number], offset: number): Pick<NodeOf<'text'>, 'textAnimation'> {
  const mode = p.oneOf('reveal', REVEALS, fallback);
  if (mode === 'none') return {};
  const unit = mode === 'words' ? 'word' : mode === 'chars' ? 'char' : 'line';
  return {
    textAnimation: {
      unit,
      stagger: unit === 'char' ? 1 : 3,
      duration: theme.motion.normal,
      ease: theme.easing.enter,
      from: { opacity: 0, y: offset },
    },
  };
}

/** Geschätzte Zeilenzahl für umbrochenen Text. */
function lineCount(text: string, fontSize: number, width: number): number {
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(estimateTextWidth(line, fontSize) / Math.max(1, width))), 0);
}

function alignX(align: (typeof ALIGNS)[number], width: number, w: number): number {
  return align === 'center' ? (width - w) / 2 : align === 'right' ? width - w : 0;
}

export const Title = defineComponent({
  name: 'Title',
  description: 'Large headline with per-word reveal and an optional accent bar. Colors, font and size come from the theme (fonts.heading, fontSizes.display, colors.text, colors.primary).',
  props: {
    text: Type.String({ description: 'Headline text.' }),
    width: Type.Optional(Type.Number({ minimum: 1, description: 'Wrap width. Default: 80 % of the composition width.' })),
    align: Align,
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
    fontWeight: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    color: ColorProp('Text color. Default: theme.colors.text.'),
    accent: Type.Optional(Type.Boolean({ description: 'Draw an accent bar under the title. Default true.' })),
    reveal: Type.Optional(Type.Enum(REVEALS)),
  },
  example: { text: 'Ship videos with agents', align: 'left' },
  enter: 'fade',
  build({ p, ctx, theme }) {
    const width = p.num('width', ctx.compositionWidth * 0.8);
    const fontSize = p.num('fontSize', theme.fontSizes.display);
    const align = p.oneOf('align', ALIGNS, 'left');
    const text = p.str('text', '');
    const lines = lineCount(text, fontSize, width);
    const textH = lines * fontSize * 1.1;
    const nodes: IrNode[] = [
      {
        id: 'text',
        type: 'text',
        text,
        width,
        textAlign: align,
        fontFamily: theme.fonts.heading,
        fontSize,
        fontWeight: p.num('fontWeight', 800),
        lineHeight: 1.1,
        letterSpacing: -fontSize * 0.02,
        fill: p.color('color', theme.colors.text),
        ...reveal(p, theme, 'words', fontSize * 0.3),
      },
    ];
    let height = textH;
    if (p.bool('accent', true)) {
      const barW = theme.spacing.xl * 2;
      const y = textH + theme.spacing.md;
      nodes.push({
        id: 'accent',
        type: 'rect',
        x: alignX(align, width, barW),
        y,
        width: { $keyframes: [{ t: 0, v: 0 }, { t: theme.motion.slow, v: barW, ease: theme.easing.enter }] },
        height: theme.spacing.sm,
        cornerRadius: theme.spacing.sm / 2,
        fill: theme.colors.primary,
      });
      height = y + theme.spacing.sm;
    }
    return { width, height, nodes };
  },
});

export const Subtitle = defineComponent({
  name: 'Subtitle',
  description: 'Secondary line below a title: body font, theme.fontSizes.lg, theme.colors.muted.',
  props: {
    text: Type.String(),
    width: Type.Optional(Type.Number({ minimum: 1 })),
    align: Align,
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
    color: ColorProp('Default: theme.colors.muted.'),
    reveal: Type.Optional(Type.Enum(REVEALS)),
  },
  example: { text: 'Deterministic rendering from a JSON composition' },
  enter: 'slide-up',
  build({ p, ctx, theme }) {
    const width = p.num('width', ctx.compositionWidth * 0.8);
    const fontSize = p.num('fontSize', theme.fontSizes.lg);
    const text = p.str('text', '');
    return {
      width,
      height: lineCount(text, fontSize, width) * fontSize * 1.3,
      nodes: [
        {
          id: 'text',
          type: 'text',
          text,
          width,
          textAlign: p.oneOf('align', ALIGNS, 'left'),
          fontFamily: theme.fonts.body,
          fontSize,
          fontWeight: 400,
          lineHeight: 1.3,
          fill: p.color('color', theme.colors.muted),
          ...reveal(p, theme, 'none', fontSize * 0.4),
        },
      ],
    };
  },
});

export const LowerThird = defineComponent({
  name: 'LowerThird',
  description: 'Name and role banner for the lower third of the frame. An accent bar grows first, then the panel opens and the text fades in.',
  props: {
    name: Type.String(),
    role: Type.Optional(Type.String()),
    width: Type.Optional(Type.Number({ minimum: 1, description: 'Panel width. Default 720.' })),
    color: ColorProp('Accent color. Default: theme.colors.primary.'),
  },
  example: { name: 'Ada Lovelace', role: 'Chief Engine Officer' },
  enter: 'slide-right',
  build({ p, theme }) {
    const width = p.num('width', 720);
    const pad = theme.spacing.lg;
    const nameSize = theme.fontSizes.lg;
    const roleSize = theme.fontSizes.sm;
    const role = p.optStr('role');
    const height = pad * 2 + nameSize * 1.2 + (role !== undefined ? theme.spacing.sm + roleSize * 1.3 : 0);
    const bar = theme.spacing.sm;
    const t1 = theme.motion.fast;
    const t2 = theme.motion.normal;
    const accent = p.color('color', theme.colors.primary);
    const nodes: IrNode[] = [
      {
        id: 'panel',
        type: 'rect',
        x: bar,
        width: { $keyframes: [{ t: t1, v: 0 }, { t: t2, v: width - bar, ease: theme.easing.enter }] },
        height,
        cornerRadius: [0, theme.radii.sm, theme.radii.sm, 0],
        fill: withAlpha(theme.colors.surface, 0.94),
        shadow: theme.shadows.md,
      },
      {
        id: 'bar',
        type: 'rect',
        width: bar,
        height: { $keyframes: [{ t: 0, v: 0 }, { t: t1, v: height, ease: theme.easing.enter }] },
        fill: accent,
      },
      {
        id: 'name',
        type: 'text',
        text: p.str('name', ''),
        x: bar + pad,
        y: pad,
        width: width - bar - pad * 2,
        maxLines: 1,
        ellipsis: '…',
        fontFamily: theme.fonts.heading,
        fontSize: nameSize,
        fontWeight: 700,
        fill: theme.colors.text,
        opacity: { $keyframes: [{ t: t2, v: 0 }, { t: theme.motion.slow, v: 1, ease: theme.easing.enter }] },
      },
    ];
    if (role !== undefined) {
      nodes.push({
        id: 'role',
        type: 'text',
        text: role,
        x: bar + pad,
        y: pad + nameSize * 1.2 + theme.spacing.sm,
        width: width - bar - pad * 2,
        maxLines: 1,
        ellipsis: '…',
        fontFamily: theme.fonts.body,
        fontSize: roleSize,
        fontWeight: 500,
        letterSpacing: 1,
        fill: accent,
        opacity: { $keyframes: [{ t: t2, v: 0 }, { t: theme.motion.slow, v: 1, ease: theme.easing.enter }] },
      });
    }
    return { width, height, nodes };
  },
});

export const Callout = defineComponent({
  name: 'Callout',
  description: 'Annotation box with a leader line that draws to a target point. The box sits at the local origin; `target` is in the same local pixels.',
  props: {
    text: Type.String(),
    target: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { description: 'Point the line points to. Default { x: -120, y: 160 }.' })),
    width: Type.Optional(Type.Number({ minimum: 40 })),
    color: ColorProp('Line and border color. Default: theme.colors.accent.'),
  },
  example: { text: 'Frame-exact: every frame is a pure function of time.', target: { x: -120, y: 160 } },
  build({ p, theme }) {
    const width = p.num('width', 360);
    const pad = theme.spacing.md;
    const fontSize = theme.fontSizes.sm;
    const text = p.str('text', '');
    const height = lineCount(text, fontSize, width - pad * 2) * fontSize * 1.35 + pad * 2;
    const target = p.point('target', { x: -120, y: 160 });
    const anchor = { x: Math.min(Math.max(target.x, 0), width), y: Math.min(Math.max(target.y, 0), height) };
    const color = p.color('color', theme.colors.accent);
    const dot = theme.spacing.md;
    const draw = theme.motion.normal;
    return {
      width,
      height,
      nodes: [
        {
          id: 'line',
          type: 'line',
          from: anchor,
          to: target,
          stroke: color,
          strokeWidth: 3,
          strokeCap: 'round',
          trimEnd: { $keyframes: [{ t: 0, v: 0 }, { t: draw, v: 1, ease: theme.easing.standard }] },
        },
        {
          id: 'pulse',
          type: 'ellipse',
          x: target.x - dot,
          y: target.y - dot,
          width: dot * 2,
          height: dot * 2,
          stroke: color,
          strokeWidth: 2,
          scale: { $keyframes: [{ t: 0, v: { x: 0.5, y: 0.5 } }, { t: theme.motion.slow, v: { x: 1.6, y: 1.6 }, ease: 'easeOutCubic' }], loop: 'repeat' },
          opacity: { $keyframes: [{ t: 0, v: 1 }, { t: theme.motion.slow, v: 0, ease: 'easeOutCubic' }], loop: 'repeat' },
        },
        { id: 'dot', type: 'ellipse', x: target.x - dot / 2, y: target.y - dot / 2, width: dot, height: dot, fill: color },
        { id: 'box', type: 'rect', width, height, cornerRadius: theme.radii.md, fill: theme.colors.surface, stroke: color, strokeWidth: 2, shadow: theme.shadows.md },
        { id: 'text', type: 'text', text, x: pad, y: pad, width: width - pad * 2, fontFamily: theme.fonts.body, fontSize, lineHeight: 1.35, fill: theme.colors.text },
      ],
    };
  },
});

const VARIANTS = ['primary', 'secondary', 'accent', 'success', 'warning', 'danger', 'muted'] as const;

export const Badge = defineComponent({
  name: 'Badge',
  description: 'Pill-shaped label. `variant` picks a theme color; `appearance: soft` uses a tinted background with colored text.',
  props: {
    label: Type.String(),
    variant: Type.Optional(Type.Enum(VARIANTS)),
    appearance: Type.Optional(Type.Union([Type.Literal('solid'), Type.Literal('soft')])),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
  },
  example: { label: 'NEW', variant: 'accent' },
  enter: 'scale',
  build({ p, theme }) {
    const variant = p.oneOf('variant', VARIANTS, 'primary');
    const color = theme.colors[variant];
    const soft = p.oneOf('appearance', ['solid', 'soft'], 'solid') === 'soft';
    const fontSize = p.num('fontSize', theme.fontSizes.sm);
    const padX = theme.spacing.md;
    const padY = theme.spacing.xs + 2;
    const label = p.str('label', '');
    const bg = soft ? withAlpha(color, 0.2) : color;
    return {
      width: estimateTextWidth(label, fontSize) + padX * 2,
      height: fontSize * 1.2 + padY * 2,
      nodes: [
        {
          id: 'label',
          type: 'text',
          text: label,
          x: padX,
          y: padY,
          fontFamily: theme.fonts.body,
          fontSize,
          fontWeight: 700,
          letterSpacing: fontSize * 0.05,
          fill: soft ? color : contrastOn(color, theme),
          background: { color: bg, paddingX: padX, paddingY: padY, radius: theme.radii.full },
        },
      ],
    };
  },
});

/**
 * Formatiert eine Zahl mit Dezimalstellen und Tausendertrennzeichen.
 *
 * @example
 * ```ts
 * formatNumber(1234567.891, 2, ',', '.'); // '1,234,567.89'
 * ```
 */
export function formatNumber(value: number, decimals: number, thousands: string, decimalSep: string): string {
  const d = Math.max(0, Math.min(10, Math.round(decimals)));
  const fixed = Math.abs(value).toFixed(d);
  const [int = '0', frac] = fixed.split('.');
  const grouped = thousands === '' ? int : int.replace(/\B(?=(\d{3})+(?!\d))/gu, thousands);
  const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
  return sign + grouped + (frac !== undefined ? decimalSep + frac : '');
}

export const Counter = defineComponent({
  name: 'Counter',
  description: 'Animated number that counts from `from` to `to` over `duration` (default theme.motion.slow × 2). Set `value` to drive it directly (e.g. with keyframes).',
  props: {
    from: Type.Optional(Type.Number()),
    to: Type.Optional(Type.Number()),
    value: Type.Optional(Type.Number({ description: 'Explicit value; overrides from/to.' })),
    duration: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    delay: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    ease: Type.Optional(Type.String()),
    decimals: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    thousands: Type.Optional(Type.String({ description: 'Thousands separator. Default ",".' })),
    decimal: Type.Optional(Type.String({ description: 'Decimal separator. Default ".".' })),
    prefix: Type.Optional(Type.String()),
    suffix: Type.Optional(Type.String()),
    label: Type.Optional(Type.String()),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
    color: ColorProp('Default: theme.colors.text.'),
  },
  example: { from: 0, to: 12500, prefix: '$', suffix: '+', label: 'monthly renders' },
  enter: 'scale',
  build({ p, ctx, theme }) {
    const from = p.num('from', 0);
    const to = p.num('to', 100);
    const slow = framesOf(theme.motion.slow, ctx.fps) ?? ctx.fps;
    const dur = p.frames('duration', slow * 2, ctx.fps);
    const delay = p.frames('delay', 0, ctx.fps);
    const t = dur > 0 ? clamp01((ctx.frame - delay) / dur) : 1;
    const value = p.optNum('value') ?? from + (to - from) * easing(p.str('ease', theme.easing.standard))(t);
    const decimals = p.num('decimals', 0);
    const text = p.str('prefix', '') + formatNumber(value, decimals, p.str('thousands', ','), p.str('decimal', '.')) + p.str('suffix', '');
    const fontSize = p.num('fontSize', theme.fontSizes.xxl);
    const label = p.optStr('label');
    const labelSize = theme.fontSizes.sm;
    const width = estimateTextWidth(p.str('prefix', '') + formatNumber(to, decimals, p.str('thousands', ','), '.') + p.str('suffix', ''), fontSize);
    const nodes: IrNode[] = [
      {
        id: 'value',
        type: 'text',
        text,
        fontFamily: theme.fonts.heading,
        fontSize,
        fontWeight: 800,
        fontFeatures: { tnum: 1 },
        lineHeight: 1.1,
        fill: p.color('color', theme.colors.text),
      },
    ];
    if (label !== undefined) {
      nodes.push({ id: 'label', type: 'text', text: label, y: fontSize * 1.15, fontFamily: theme.fonts.body, fontSize: labelSize, fontWeight: 500, fill: theme.colors.muted });
    }
    return { width, height: fontSize * 1.1 + (label !== undefined ? labelSize * 1.4 : 0), nodes };
  },
});

export const Typewriter = defineComponent({
  name: 'Typewriter',
  description: 'Types text character by character with a blinking cursor. `speed` is characters per second (default 20).',
  props: {
    text: Type.String(),
    speed: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    delay: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    cursor: Type.Optional(Type.Boolean()),
    cursorChar: Type.Optional(Type.String({ minLength: 1 })),
    mono: Type.Optional(Type.Boolean({ description: 'Use theme.fonts.mono. Default false.' })),
    width: Type.Optional(Type.Number({ minimum: 1 })),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
    color: ColorProp('Default: theme.colors.text.'),
  },
  example: { text: 'Hello, agentic video.', speed: 18 },
  enter: 'none',
  build({ p, ctx, theme }) {
    const text = p.str('text', '');
    const chars = Array.from(text);
    const delay = p.frames('delay', 0, ctx.fps);
    const speed = p.num('speed', 20);
    const typedFrames = (ctx.frame - delay) / ctx.fps;
    const count = Math.max(0, Math.min(chars.length, Math.floor(typedFrames * speed)));
    const typing = count < chars.length;
    // Während des Tippens steht der Cursor, danach blinkt er (zwei Mal pro Sekunde).
    const blinkOn = typing || Math.floor((ctx.frame / ctx.fps) * 2) % 2 === 0;
    const fontSize = p.num('fontSize', theme.fontSizes.lg);
    const width = p.optNum('width');
    const color = p.color('color', theme.colors.text);
    const spans: { text: string; fill?: string }[] = [{ text: chars.slice(0, count).join('') }];
    if (p.bool('cursor', true)) spans.push({ text: p.str('cursorChar', '|'), fill: blinkOn ? theme.colors.accent : 'transparent' });
    const mono = p.bool('mono', false);
    return {
      width: width ?? estimateTextWidth(text, fontSize, mono) + fontSize,
      height: (width !== undefined ? lineCount(text, fontSize, width) : text.split('\n').length) * fontSize * 1.3,
      nodes: [
        {
          id: 'text',
          type: 'rich-text',
          spans,
          ...(width !== undefined ? { width } : {}),
          fontFamily: mono ? theme.fonts.mono : theme.fonts.body,
          fontSize,
          lineHeight: 1.3,
          fill: color,
        },
      ],
    };
  },
});
