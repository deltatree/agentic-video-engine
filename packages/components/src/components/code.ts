/**
 * Code-Komponenten: CodeEditor und Terminal mit Syntax-Hervorhebung als `rich-text`.
 */
import type { IrNode } from '@agentic-video/core';
import Type from 'typebox';
import { defineComponent, mix, withAlpha, type Props } from '../define.js';
import type { ResolvedTheme } from '../theme.js';
import { LANGUAGES, isLanguage, tokenize, type Token, type TokenKind } from '../tokenizer.js';

/**
 * Farbe einer Token-Art aus dem Theme.
 *
 * @example
 * ```ts
 * tokenColor('keyword', DEFAULT_THEME); // DEFAULT_THEME.colors.secondary
 * ```
 */
export function tokenColor(kind: TokenKind, theme: ResolvedTheme): string {
  const c = theme.colors;
  switch (kind) {
    case 'keyword':
      return c.secondary;
    case 'string':
      return c.success;
    case 'number':
      return c.warning;
    case 'comment':
      return c.muted;
    case 'type':
      return c.accent;
    case 'function':
      return c.primary;
    case 'punctuation':
      return mix(c.text, c.muted, 0.5);
    case 'plain':
      return c.text;
  }
}

interface Span {
  text: string;
  fill?: string;
  fontStyle?: 'italic';
}

function spansOf(tokens: readonly Token[], theme: ResolvedTheme): Span[] {
  return tokens.map((t) => ({ text: t.text, fill: tokenColor(t.kind, theme), ...(t.kind === 'comment' ? { fontStyle: 'italic' as const } : {}) }));
}

/** Kürzt Tokens auf die ersten `count` Zeichen (Tipp-Animation). */
function truncate(tokens: readonly Token[], count: number): Token[] {
  const out: Token[] = [];
  let left = count;
  for (const t of tokens) {
    if (left <= 0) break;
    const chars = Array.from(t.text);
    out.push(chars.length <= left ? t : { text: chars.slice(0, left).join(''), kind: t.kind });
    left -= chars.length;
  }
  return out;
}

/** Fensterrahmen mit Titelleiste für Editor und Terminal. */
function chrome(width: number, height: number, bar: number, title: string | undefined, bg: string, theme: ResolvedTheme): IrNode[] {
  const c = theme.colors;
  const nodes: IrNode[] = [
    { id: 'frame', type: 'rect', width, height, cornerRadius: theme.radii.md, fill: bg, stroke: withAlpha(c.text, 0.1), strokeWidth: 1, shadow: theme.shadows.lg },
    { id: 'bar', type: 'rect', width, height: bar, cornerRadius: [theme.radii.md, theme.radii.md, 0, 0], fill: mix(bg, c.text, 0.06) },
    ...[c.danger, c.warning, c.success].map((fill, i): IrNode => ({ id: `dot-${String(i)}`, type: 'ellipse', x: 16 + i * 20, y: bar / 2 - 6, width: 12, height: 12, fill })),
  ];
  if (title !== undefined) {
    nodes.push({ id: 'title', type: 'text', text: title, x: 80, y: bar / 2 - theme.fontSizes.xs * 0.6, width: Math.max(0, width - 160), textAlign: 'center', maxLines: 1, ellipsis: '…', fontFamily: theme.fonts.body, fontSize: theme.fontSizes.xs, fill: c.muted });
  }
  return nodes;
}

/** Anzahl sichtbarer Zeichen der Tipp-Animation; `undefined` = keine Animation. */
function typedChars(p: Props, frame: number, fps: number, defaultSpeed: number): number | undefined {
  const typing = p.raw['typing'];
  if (typing === false || typing === undefined) return undefined;
  const speed = typeof typing === 'number' && typing > 0 ? typing : defaultSpeed;
  const delay = p.frames('typingDelay', 0, fps);
  return Math.max(0, Math.floor(((frame - delay) / fps) * speed));
}

const Typing = Type.Optional(Type.Union([Type.Boolean(), Type.Number({ exclusiveMinimum: 0 })], { description: 'Typing animation. true or characters per second.' }));

export const CodeEditor = defineComponent({
  name: 'CodeEditor',
  description: `Code editor window with syntax highlighting (${LANGUAGES.join(', ')}), line numbers, highlighted lines and an optional typing animation. Uses theme.fonts.mono.`,
  props: {
    code: Type.String(),
    language: Type.Optional(Type.Enum(LANGUAGES)),
    title: Type.Optional(Type.String({ description: 'File name in the title bar.' })),
    lineNumbers: Type.Optional(Type.Boolean()),
    highlightLines: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: '1-based line numbers to highlight.' })),
    typing: Typing,
    typingDelay: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    width: Type.Optional(Type.Number({ minimum: 100 })),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
  },
  example: {
    code: "// Render a frame\nexport function render(frame: number): string {\n  const label = 'frame ' + frame;\n  return label.toUpperCase();\n}",
    language: 'ts',
    title: 'render.ts',
    highlightLines: [3],
  },
  enter: 'slide-up',
  build({ p, ctx, theme }) {
    const code = p.str('code', '');
    const rawLang = p.raw['language'];
    const language = isLanguage(rawLang) ? rawLang : 'ts';
    const fontSize = p.num('fontSize', theme.fontSizes.sm);
    const lh = fontSize * 1.5;
    const lines = code.split('\n');
    const width = p.num('width', 880);
    const bar = 40;
    const pad = theme.spacing.lg;
    const showNumbers = p.bool('lineNumbers', true);
    const gutter = showNumbers ? String(lines.length).length * fontSize * 0.6 + theme.spacing.lg : 0;
    const height = bar + pad * 2 + lines.length * lh;
    const top = bar + pad;
    const bg = mix(theme.colors.background, theme.colors.surface, 0.6);
    const nodes = chrome(width, height, bar, p.optStr('title'), bg, theme);

    for (const n of p.numbers('highlightLines')) {
      if (n < 1 || n > lines.length) continue;
      nodes.push({ id: `highlight-${String(n)}`, type: 'rect', x: 0, y: top + (n - 1) * lh, width, height: lh, fill: withAlpha(theme.colors.primary, 0.16) });
      nodes.push({ id: `highlight-mark-${String(n)}`, type: 'rect', x: 0, y: top + (n - 1) * lh, width: 3, height: lh, fill: theme.colors.primary });
    }

    let tokens = tokenize(code, language);
    const count = typedChars(p, ctx.frame, ctx.fps, 30);
    const typing = count !== undefined && count < Array.from(code).length;
    if (count !== undefined) tokens = truncate(tokens, count);
    const visibleLines = tokens.reduce((n, t) => n + (t.text.match(/\n/gu)?.length ?? 0), 1);
    const spans = spansOf(tokens, theme);
    if (typing) spans.push({ text: '▍', fill: theme.colors.accent });
    if (spans.length === 0) spans.push({ text: '' });

    if (showNumbers) {
      const numbers = Array.from({ length: count !== undefined ? visibleLines : lines.length }, (_, i) => String(i + 1)).join('\n');
      nodes.push({ id: 'numbers', type: 'text', text: numbers, x: pad, y: top, width: gutter - theme.spacing.md, textAlign: 'right', fontFamily: theme.fonts.mono, fontSize, lineHeight: 1.5, fill: withAlpha(theme.colors.muted, 0.7) });
    }
    nodes.push({ id: 'code', type: 'rich-text', spans, x: pad + gutter, y: top, fontFamily: theme.fonts.mono, fontSize, lineHeight: 1.5, fill: theme.colors.text });
    return { width, height, nodes };
  },
});

export const Terminal = defineComponent({
  name: 'Terminal',
  description: 'Terminal window. Each command is typed (bash highlighting), then its output appears. A cursor blinks on the last prompt. Uses theme.fonts.mono.',
  props: {
    commands: Type.Array(Type.Object({ command: Type.String(), output: Type.Optional(Type.String()) }, { additionalProperties: false })),
    prompt: Type.Optional(Type.String({ description: 'Prompt text. Default "$".' })),
    title: Type.Optional(Type.String()),
    typing: Typing,
    typingDelay: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    pause: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: 'Pause after each command before its output. Default theme.motion.fast.' })),
    width: Type.Optional(Type.Number({ minimum: 100 })),
    height: Type.Optional(Type.Number({ minimum: 60 })),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
  },
  example: {
    commands: [
      { command: 'npx openvideo render hero.json --out hero.mp4', output: 'Rendered 300 frames in 4.2s' },
      { command: 'echo "done"', output: 'done' },
    ],
    title: 'zsh',
  },
  enter: 'slide-up',
  build({ p, ctx, theme }) {
    const c = theme.colors;
    const commands = p.records('commands').map((r) => ({ command: typeof r['command'] === 'string' ? r['command'] : '', output: typeof r['output'] === 'string' ? r['output'] : undefined }));
    const prompt = p.str('prompt', '$');
    const fontSize = p.num('fontSize', theme.fontSizes.sm);
    const lh = fontSize * 1.5;
    const width = p.num('width', 880);
    const bar = 40;
    const pad = theme.spacing.lg;
    const allLines = commands.reduce((n, cmd) => n + 1 + (cmd.output !== undefined ? cmd.output.split('\n').length : 0), 1);
    const height = p.num('height', bar + pad * 2 + allLines * lh);

    const animate = p.raw['typing'] !== false;
    const speed = typeof p.raw['typing'] === 'number' && p.raw['typing'] > 0 ? p.raw['typing'] : 30;
    const pause = p.frames('pause', theme.motion.fast, ctx.fps) / ctx.fps;
    let budget = animate ? (ctx.frame - p.frames('typingDelay', 0, ctx.fps)) / ctx.fps : Number.POSITIVE_INFINITY;

    const spans: Span[] = [];
    const promptSpan = (): Span => ({ text: `${prompt} `, fill: c.success });
    let busy = false;
    for (const cmd of commands) {
      spans.push(promptSpan());
      const chars = Array.from(cmd.command);
      const need = chars.length / speed;
      const tokens = tokenize(cmd.command, 'bash');
      if (budget < need) {
        spans.push(...spansOf(truncate(tokens, Math.max(0, Math.floor(budget * speed))), theme));
        busy = true;
        break;
      }
      budget -= need;
      spans.push(...spansOf(tokens, theme));
      if (budget < pause) {
        busy = true;
        break;
      }
      budget -= pause;
      spans.push({ text: '\n' });
      if (cmd.output !== undefined) spans.push({ text: `${cmd.output}\n`, fill: mix(c.text, c.muted, 0.35) });
    }
    if (!busy) spans.push(promptSpan());
    const blinkOn = busy || Math.floor((ctx.frame / ctx.fps) * 2) % 2 === 0;
    spans.push({ text: '▍', fill: blinkOn ? c.text : 'transparent' });

    const bg = mix(c.background, '#000000', 0.35);
    const nodes = chrome(width, height, bar, p.optStr('title'), bg, theme);
    nodes.push({
      id: 'content',
      type: 'group',
      y: bar,
      width,
      height: height - bar,
      clip: true,
      children: [{ id: 'text', type: 'rich-text', spans, x: pad, y: pad, width: width - pad * 2, fontFamily: theme.fonts.mono, fontSize, lineHeight: 1.5, fill: c.text }],
    });
    return { width, height, nodes };
  },
});
