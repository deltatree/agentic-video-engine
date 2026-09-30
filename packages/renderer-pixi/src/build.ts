/**
 * Baut aus ausgewerteten 2D-Nodes einen PixiJS-Szenengraphen mit derselben Semantik wie Skia
 * (docs/reference/node-semantics.md): lokale Matrix aus `localMatrix`, Opacity als Gruppe,
 * Filter in Reihenfolge, Maske im lokalen System der Node, Reveal-Clip in Box-Koordinaten.
 */
import {
  DEFAULT_FILL,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  OpenVideoError,
  effectiveFill,
  fontFamilyOf,
  getNumber,
  getPoints,
  getString,
  getVec2,
  isRecord,
  localBox,
  localMatrix,
  particles2d,
  revealShape,
  toSeconds,
  type EvaluatedNode,
} from '@agentic-video/core';
import {
  AlphaFilter,
  BlurFilter,
  CanvasTextMetrics,
  ColorMatrixFilter,
  Container,
  FillGradient,
  Graphics,
  GraphicsPath,
  Matrix,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  Texture,
  type BLEND_MODES,
  type Filter,
  type Renderer,
  type TextStyleAlign,
  type TextStyleOptions,
} from 'pixi.js';
import { LUMINANCE_TO_ALPHA, filterMatrix, toColorMatrix } from './filters.js';
import { colorAlpha, toFill, toStroke, type Box } from './paint.js';
import { PIXI_BLEND_MODES } from './check.js';
import { createShaderMesh } from './shader.js';

/** Eingabe für einen PixiJS-Layer (siehe Paket-README). */
export interface PixiLayerInput {
  /** Die Nodes dieses Layers in Zeichenreihenfolge, in Composition-Koordinaten. */
  readonly nodes: readonly EvaluatedNode[];
  readonly width: number;
  readonly height: number;
  /** Vorschau-Skalierung: Das Canvas ist `width·scale × height·scale` groß. */
  readonly scale: number;
  readonly frame: number;
  readonly time: number;
  readonly fps: number;
  readonly seed: number;
  /** URL eines Assets auf der Host-Origin. */
  readonly assetUrl: (assetId: string) => string;
  /** Bild eines Videos zur Quellzeit in Sekunden. */
  readonly videoFrame: (assetId: string, seconds: number) => Promise<ImageBitmap | HTMLCanvasElement>;
  /** CSS-Schriftfamilie für Text ohne `fontFamily` (vom Host geladen). */
  readonly defaultFont: string;
}

/** Laufzeitkontext eines Frames. */
export interface BuildContext {
  readonly input: PixiLayerInput;
  readonly renderer: Renderer;
  /** Lädt eine Bildtextur (zwischengespeichert pro URL und Glättung). */
  readonly texture: (url: string, nearest: boolean) => Promise<Texture>;
  /** Ressourcen, die nach dem Frame freigegeben werden. */
  readonly disposables: { destroy(): void }[];
}

function track<T extends { destroy(): void }>(ctx: BuildContext, value: T): T {
  ctx.disposables.push(value);
  return value;
}

function fillOf(ctx: BuildContext, paint: unknown, box: Box): ReturnType<typeof toFill> {
  const f = toFill(paint, box);
  if (f instanceof FillGradient) track(ctx, f);
  return f;
}

function strokeOf(ctx: BuildContext, paint: unknown, box: Box, node: EvaluatedNode): ReturnType<typeof toStroke> {
  const s = toStroke(paint, box, node.props);
  if (s?.fill instanceof FillGradient) track(ctx, s.fill);
  return s;
}

function localSeconds(node: EvaluatedNode, fps: number): number {
  return node.time.localFrame / fps;
}

// ---------------------------------------------------------------------------
// Formen
// ---------------------------------------------------------------------------

function roundedRect(g: Graphics, w: number, h: number, radius: unknown): void {
  if (typeof radius === 'number' && radius > 0) {
    g.roundRect(0, 0, w, h, Math.min(radius, w / 2, h / 2));
    return;
  }
  if (Array.isArray(radius) && radius.length === 4) {
    const max = Math.min(w, h) / 2;
    const r = radius.map((v: unknown) => Math.min(Math.max(typeof v === 'number' ? v : 0, 0), max));
    const [tl = 0, tr = 0, br = 0, bl = 0] = r;
    g.moveTo(tl, 0)
      .lineTo(w - tr, 0)
      .arcTo(w, 0, w, tr, tr)
      .lineTo(w, h - br)
      .arcTo(w, h, w - br, h, br)
      .lineTo(bl, h)
      .arcTo(0, h, 0, h - bl, bl)
      .lineTo(0, tl)
      .arcTo(0, 0, tl, 0, tl)
      .closePath();
    return;
  }
  g.rect(0, 0, w, h);
}

function paintShape(g: Graphics, node: EvaluatedNode, box: Box, ctx: BuildContext, fill: unknown = effectiveFill(node)): void {
  const f = fill === undefined ? undefined : fillOf(ctx, fill, box);
  if (f !== undefined) g.fill(f);
  const stroke = node.props['stroke'];
  if (stroke !== undefined) {
    const s = strokeOf(ctx, stroke, box, node);
    if (s !== undefined) g.stroke(s);
  }
}

function buildShape(node: EvaluatedNode, box: Box, ctx: BuildContext): Graphics {
  const g = new Graphics();
  switch (node.type) {
    case 'rect':
      roundedRect(g, getNumber(node, 'width', 0), getNumber(node, 'height', 0), node.props['cornerRadius']);
      paintShape(g, node, box, ctx);
      break;
    case 'ellipse': {
      const w = getNumber(node, 'width', 0);
      const h = getNumber(node, 'height', 0);
      g.ellipse(w / 2, h / 2, w / 2, h / 2);
      paintShape(g, node, box, ctx);
      break;
    }
    case 'line': {
      const a = getVec2(node, 'from', { x: 0, y: 0 });
      const b = getVec2(node, 'to', { x: 0, y: 0 });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      // Ohne stroke zeichnet die Linie mit der fill-Farbe als Kontur.
      const paint = node.props['stroke'] ?? node.props['fill'] ?? DEFAULT_FILL;
      const s = strokeOf(ctx, paint, box, node);
      if (s !== undefined) g.stroke(s);
      break;
    }
    case 'polyline': {
      const pts = getPoints(node, 'points');
      const first = pts[0];
      if (first !== undefined) {
        g.moveTo(first[0], first[1]);
        for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
      }
      const fill = node.props['fill'];
      const stroke = node.props['stroke'];
      if (fill === undefined && stroke === undefined) {
        const s = strokeOf(ctx, DEFAULT_FILL, box, node);
        if (s !== undefined) g.stroke(s);
      } else paintShape(g, node, box, ctx, fill);
      break;
    }
    case 'polygon':
      g.poly(getPoints(node, 'points').flat(), true);
      paintShape(g, node, box, ctx);
      break;
    default: {
      g.path(new GraphicsPath(getString(node, 'd', '')));
      paintShape(g, node, box, ctx);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

interface BuiltText {
  readonly content: Container;
  readonly measured: { width: number; height: number };
}

async function ensureFont(style: string, weight: number, size: number, family: string): Promise<void> {
  const fonts: unknown = Reflect.get(document, 'fonts');
  if (typeof fonts !== 'object' || fonts === null || !('load' in fonts) || typeof fonts.load !== 'function') return;
  // Fehlt die Schrift, nutzt der Browser die Ersatzschrift; der Host lädt Schriften vorher.
  await Promise.resolve(Reflect.apply(fonts.load, fonts, [`${style} ${String(weight)} ${String(size)}px "${family}"`])).catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
  });
}

/** Rich-Text als PixiJS-Markup: je Span ein eigenes Tag mit Stil-Überschreibungen. */
interface RichMarkup {
  readonly text: string;
  readonly spans: readonly { readonly tag: string; readonly style: Readonly<Record<string, unknown>> }[];
}

/**
 * Baut aus den Spans einer `rich-text`-Node Markup für PixiJS-`tagStyles`. Der Tag-Präfix wird so
 * gewählt, dass er in keinem Span-Text vorkommt; Span-Text bleibt damit wörtlich.
 */
function richMarkup(node: EvaluatedNode): RichMarkup {
  const raw = node.props['spans'];
  const spans = Array.isArray(raw) ? raw.filter(isRecord) : [];
  const texts = spans.map((span) => (typeof span['text'] === 'string' ? span['text'] : ''));
  let prefix = 'ovs';
  while (texts.some((t) => t.includes(prefix))) prefix += 'x';
  const out = spans.map((style, i) => ({ tag: `${prefix}${String(i)}`, style }));
  return { text: out.map((s, i) => `<${s.tag}>${texts[i] ?? ''}</${s.tag}>`).join(''), spans: out };
}

async function buildText(node: EvaluatedNode, ctx: BuildContext): Promise<BuiltText> {
  const rich = node.type === 'rich-text' ? richMarkup(node) : undefined;
  const text = rich?.text ?? getString(node, 'text', '');
  const family = fontFamilyOf(node, ctx.input.defaultFont);
  const size = getNumber(node, 'fontSize', DEFAULT_FONT_SIZE);
  const weight = getNumber(node, 'fontWeight', 400);
  const fontStyle = node.props['fontStyle'] === 'italic' ? 'italic' : 'normal';
  // Zeilenhöhe als Vielfaches der größten Schrift im Absatz (bei Rich-Text die größte Span-Schrift).
  const spanSizes = rich?.spans.map((s) => (typeof s.style['fontSize'] === 'number' ? s.style['fontSize'] : size)) ?? [];
  const lineHeight = getNumber(node, 'lineHeight', DEFAULT_LINE_HEIGHT) * Math.max(size, ...spanSizes);
  const wrapWidth = node.props['width'];
  const alignRaw = getString(node, 'textAlign', 'left');
  const align: TextStyleAlign = alignRaw === 'center' || alignRaw === 'right' || alignRaw === 'justify' ? alignRaw : alignRaw === 'end' ? 'right' : 'left';
  await ensureFont(fontStyle, weight, size, family);
  for (const span of rich?.spans ?? []) {
    const st = span.style;
    await ensureFont(st['fontStyle'] === 'italic' ? 'italic' : fontStyle, typeof st['fontWeight'] === 'number' ? st['fontWeight'] : weight, typeof st['fontSize'] === 'number' ? st['fontSize'] : size, typeof st['fontFamily'] === 'string' ? st['fontFamily'] : family);
  }
  const baseStyle = {
    fontFamily: family,
    fontSize: size,
    fontStyle,
    lineHeight,
    letterSpacing: getNumber(node, 'letterSpacing', 0),
    align,
    wordWrap: typeof wrapWidth === 'number',
    wordWrapWidth: typeof wrapWidth === 'number' ? wrapWidth : 0,
  } as const;
  const styleWeight = String(Math.round(weight));
  // Für die Messung genügen Schrift-Eigenschaften der Spans; Farben folgen, sobald die Box feststeht.
  const measureTags = rich === undefined ? undefined : Object.fromEntries(rich.spans.map((s) => [s.tag, spanFont(s.style)]));
  const measureStyle = new TextStyle({ ...baseStyle, fontWeight: isFontWeight(styleWeight) ? styleWeight : 'normal', ...(measureTags !== undefined ? { tagStyles: measureTags } : {}) });
  const metrics = CanvasTextMetrics.measureText(text, measureStyle);
  const width = typeof wrapWidth === 'number' ? wrapWidth : metrics.width;
  const height = metrics.lines.length * lineHeight;
  const box: Box = { x: 0, y: 0, width, height };
  const fill = fillOf(ctx, node.props['fill'] ?? DEFAULT_FILL, box);
  const strokePaint = node.props['stroke'];
  const stroke = strokePaint === undefined ? undefined : strokeOf(ctx, strokePaint, box, node);
  measureStyle.destroy();
  const tagStyles = rich === undefined ? undefined : Object.fromEntries(rich.spans.map((s) => [s.tag, spanStyle(ctx, s.style, box, node)]));
  const style = new TextStyle({
    ...baseStyle,
    fontWeight: isFontWeight(styleWeight) ? styleWeight : 'normal',
    ...(fill !== undefined ? { fill } : {}),
    ...(stroke !== undefined ? { stroke } : {}),
    ...(tagStyles !== undefined ? { tagStyles } : {}),
  });
  const content = new Container();
  const k = align === 'center' ? 0.5 : align === 'right' ? 1 : 0;
  const background = node.props['background'];
  if (isRecord(background) && typeof background['color'] === 'string') {
    const px = typeof background['paddingX'] === 'number' ? background['paddingX'] : 0;
    const py = typeof background['paddingY'] === 'number' ? background['paddingY'] : 0;
    const radius = typeof background['radius'] === 'number' ? background['radius'] : 0;
    const bg = new Graphics();
    const rect = (x: number, y: number, w: number, h: number): void => {
      if (radius > 0) bg.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
      else bg.rect(x, y, w, h);
    };
    if (background['perLine'] === true) {
      metrics.lines.forEach((_, i) => {
        const lw = metrics.lineWidths[i] ?? 0;
        if (lw <= 0) return;
        rect((width - lw) * k - px, i * lineHeight - py, lw + 2 * px, lineHeight + 2 * py);
      });
    } else rect(-px, -py, width + 2 * px, height + 2 * py);
    bg.fill(colorAlpha(background['color']));
    content.addChild(bg);
  }
  const label = new Text({ text, style, resolution: ctx.input.scale });
  // PixiJS richtet Zeilen innerhalb der längsten Zeile aus; wir richten den Block innerhalb von `width` aus.
  label.x = (width - metrics.width) * k;
  content.addChild(label);
  return { content, measured: { width, height } };
}

/** Schrift-Eigenschaften eines Spans als PixiJS-Stil (ohne Farben). */
function spanFont(span: Readonly<Record<string, unknown>>): TextStyleOptions {
  const out: TextStyleOptions = {};
  if (typeof span['fontFamily'] === 'string') out.fontFamily = span['fontFamily'];
  if (typeof span['fontSize'] === 'number') out.fontSize = span['fontSize'];
  if (typeof span['fontWeight'] === 'number') {
    const w = String(Math.round(span['fontWeight']));
    out.fontWeight = isFontWeight(w) ? w : 'normal';
  }
  if (span['fontStyle'] === 'italic' || span['fontStyle'] === 'normal') out.fontStyle = span['fontStyle'];
  if (typeof span['letterSpacing'] === 'number') out.letterSpacing = span['letterSpacing'];
  return out;
}

/** Vollständiger Stil eines Spans: Schrift, Füllung und Kontur (Verläufe relativ zur Textbox). */
function spanStyle(ctx: BuildContext, span: Readonly<Record<string, unknown>>, box: Box, node: EvaluatedNode): TextStyleOptions {
  const out = spanFont(span);
  if (span['fill'] !== undefined) {
    const fill = fillOf(ctx, span['fill'], box);
    if (fill !== undefined) out.fill = fill;
  }
  if (span['stroke'] !== undefined) {
    const stroke = toStroke(span['stroke'], box, { ...node.props, ...(typeof span['strokeWidth'] === 'number' ? { strokeWidth: span['strokeWidth'] } : {}) });
    if (stroke?.fill instanceof FillGradient) track(ctx, stroke.fill);
    if (stroke !== undefined) out.stroke = stroke;
  }
  return out;
}

const FONT_WEIGHTS = new Set(['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold', 'bolder', 'lighter']);
function isFontWeight(v: string): v is TextStyle['fontWeight'] {
  return FONT_WEIGHTS.has(v);
}

// ---------------------------------------------------------------------------
// Medien
// ---------------------------------------------------------------------------

function fitSprite(texture: Texture, w: number, h: number, fit: string): Container {
  const sprite = new Sprite(texture);
  const nw = texture.width;
  const nh = texture.height;
  const holder = new Container();
  holder.addChild(sprite);
  if (fit === 'fill' || nw <= 0 || nh <= 0) {
    sprite.width = w;
    sprite.height = h;
    return holder;
  }
  const s = fit === 'contain' ? Math.min(w / nw, h / nh) : fit === 'cover' ? Math.max(w / nw, h / nh) : 1;
  sprite.scale.set(s);
  sprite.x = (w - nw * s) / 2;
  sprite.y = (h - nh * s) / 2;
  if (fit === 'cover' || fit === 'none') {
    const clip = new Graphics().rect(0, 0, w, h).fill(0xffffff);
    holder.addChild(clip);
    holder.mask = clip;
  }
  return holder;
}

async function buildImage(node: EvaluatedNode, ctx: BuildContext): Promise<{ content: Container; measured: { width: number; height: number } }> {
  const asset = getString(node, 'asset', '');
  const texture = await ctx.texture(ctx.input.assetUrl(asset), node.props['smoothing'] === 'nearest');
  const w = getNumber(node, 'width', texture.width);
  const h = getNumber(node, 'height', texture.height);
  return { content: fitSprite(texture, w, h, getString(node, 'fit', 'fill')), measured: { width: w, height: h } };
}

async function buildVideo(node: EvaluatedNode, ctx: BuildContext): Promise<{ content: Container; measured: { width: number; height: number } }> {
  const asset = getString(node, 'asset', '');
  const fps = ctx.input.fps;
  const startRaw = node.props['startFrom'];
  const start = typeof startRaw === 'number' || typeof startRaw === 'string' ? toSeconds(startRaw, { fps }) : 0;
  const seconds = Math.max(0, start + localSeconds(node, fps) * getNumber(node, 'playbackRate', 1));
  const frame = await ctx.input.videoFrame(asset, seconds);
  const texture = Texture.from(frame);
  ctx.disposables.push({
    destroy: () => {
      texture.source.unload();
      texture.destroy(false);
    },
  });
  const w = getNumber(node, 'width', texture.width);
  const h = getNumber(node, 'height', texture.height);
  return { content: fitSprite(texture, w, h, getString(node, 'fit', 'fill')), measured: { width: w, height: h } };
}

async function buildSprite(node: EvaluatedNode, ctx: BuildContext): Promise<{ content: Container; measured: { width: number; height: number } }> {
  const sheet = await ctx.texture(ctx.input.assetUrl(getString(node, 'asset', '')), false);
  const columns = Math.max(1, Math.floor(getNumber(node, 'columns', 1)));
  const rows = Math.max(1, Math.floor(getNumber(node, 'rows', 1)));
  const count = Math.max(1, Math.floor(getNumber(node, 'frameCount', columns * rows)));
  const explicit = node.props['frame'];
  const raw = typeof explicit === 'number' ? Math.floor(explicit) : Math.floor(localSeconds(node, ctx.input.fps) * getNumber(node, 'frameRate', ctx.input.fps));
  const index = node.props['loop'] === true ? ((raw % count) + count) % count : Math.min(Math.max(raw, 0), count - 1);
  const cw = sheet.width / columns;
  const ch = sheet.height / rows;
  const cell = track(ctx, new Texture({ source: sheet.source, frame: new Rectangle((index % columns) * cw, Math.floor(index / columns) * ch, cw, ch) }));
  const w = getNumber(node, 'width', cw);
  const h = getNumber(node, 'height', ch);
  const sprite = new Sprite(cell);
  sprite.width = w;
  sprite.height = h;
  return { content: sprite, measured: { width: w, height: h } };
}

// ---------------------------------------------------------------------------
// Partikel
// ---------------------------------------------------------------------------

function buildParticles(node: EvaluatedNode, ctx: BuildContext): Graphics {
  const fps = ctx.input.fps;
  const t = localSeconds(node, fps);
  const alive = particles2d(node, t, fps);
  const shape = node.props['shape'];
  // Richtung der Funken aus der Position einen Frame zuvor (wie im Skia-Renderer).
  const previous = shape === 'spark' ? new Map(particles2d(node, t - 1 / fps, fps).map((p) => [p.index, p])) : undefined;
  const g = new Graphics();
  for (const p of alive) {
    if (p.opacity <= 0 || p.size <= 0) continue;
    const { color, alpha } = colorAlpha(p.color);
    const style = { color, alpha: alpha * p.opacity };
    if (shape === 'square') {
      const r = (p.rotation * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      const hs = p.size / 2;
      const corners = [
        [-hs, -hs],
        [hs, -hs],
        [hs, hs],
        [-hs, hs],
      ].flatMap(([x = 0, y = 0]) => [p.x + x * c - y * s, p.y + x * s + y * c]);
      g.poly(corners, true).fill(style);
    } else if (shape === 'spark') {
      const prev = previous?.get(p.index);
      let angle = (p.rotation * Math.PI) / 180;
      if (prev !== undefined && (prev.x !== p.x || prev.y !== p.y)) angle = Math.atan2(p.y - prev.y, p.x - prev.x);
      const len = 3 * p.size;
      g.moveTo(p.x - Math.cos(angle) * len, p.y - Math.sin(angle) * len)
        .lineTo(p.x, p.y)
        .stroke({ ...style, width: Math.max(1, p.size / 3), cap: 'round' });
    } else {
      g.circle(p.x, p.y, p.size / 2).fill(style);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

function unsupported(node: EvaluatedNode, what: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_PIXI_UNSUPPORTED',
    errorClass: 'PixiRendererError',
    problem: `${what} is not supported by the PixiJS renderer.`,
    nodeId: node.id,
    pointer: node.pointer,
    suggestions: ["Set renderer: 'skia' on this node."],
  });
}

async function buildContent(node: EvaluatedNode, ctx: BuildContext): Promise<{ content: Container; measured?: { width: number; height: number } }> {
  switch (node.type) {
    case 'group': {
      const content = new Container();
      for (const child of node.children) content.addChild(await buildNode(child, ctx));
      if (node.props['clip'] === true) return { content: clipTo(content, (g) => g.rect(0, 0, getNumber(node, 'width', 0), getNumber(node, 'height', 0))) };
      return { content };
    }
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'polyline':
    case 'polygon':
    case 'path':
      return { content: buildShape(node, localBox(node), ctx) };
    case 'text':
    case 'rich-text':
      return buildText(node, ctx);
    case 'image':
      return buildImage(node, ctx);
    case 'video':
      return buildVideo(node, ctx);
    case 'sprite':
      return buildSprite(node, ctx);
    case 'shader': {
      const glsl = node.props['glsl'];
      if (typeof glsl !== 'string') throw unsupported(node, 'A shader without GLSL (glsl)');
      const w = getNumber(node, 'width', 0);
      const h = getNumber(node, 'height', 0);
      return { content: createShaderMesh(glsl, node.props['uniforms'], localSeconds(node, ctx.input.fps), node.time.localFrame, w, h, node.id) };
    }
    case 'particles':
      return { content: buildParticles(node, ctx) };
    default:
      throw unsupported(node, `Node type "${node.type}"`);
  }
}

/** Beschneidet einen Inhalt mit einer Form (Stencil-Maske im selben Koordinatensystem). */
function clipTo(content: Container, draw: (g: Graphics) => void): Container {
  const holder = new Container();
  const shape = new Graphics();
  draw(shape);
  shape.fill(0xffffff);
  holder.addChild(content, shape);
  holder.mask = shape;
  return holder;
}

/** Wendet eine Alpha- oder Luminanz-Maske an; die Masken-Node liegt im lokalen System der Node. */
async function applyMask(content: Container, mask: NonNullable<EvaluatedNode['mask']>, ctx: BuildContext): Promise<Container> {
  const source = new Container();
  const maskNode = await buildNode(mask.node, ctx);
  if (mask.mode === 'luminance') {
    // Luminanz = Helligkeit × Alpha: Maskeninhalt auf opakem Schwarz, dann Luma → Alpha.
    const bounds = maskNode.getLocalBounds();
    source.addChild(new Graphics().rect(bounds.x, bounds.y, bounds.width, bounds.height).fill(0x000000));
    source.addChild(maskNode);
    const cm = new ColorMatrixFilter();
    cm.matrix = toColorMatrix(LUMINANCE_TO_ALPHA);
    source.filters = [track(ctx, cm)];
  } else source.addChild(maskNode);
  const bounds = source.getLocalBounds();
  const holder = new Container();
  holder.addChild(content);
  if (bounds.width <= 0 || bounds.height <= 0) {
    // Leere Maske: nichts sichtbar (bzw. alles bei invert).
    if (!mask.invert) holder.visible = false;
    source.destroy({ children: true });
    return holder;
  }
  const texture = track(ctx, ctx.renderer.generateTexture({ target: source, resolution: ctx.input.scale, antialias: true }));
  source.destroy({ children: true });
  const sprite = new Sprite(texture);
  sprite.position.set(bounds.x, bounds.y);
  holder.addChild(sprite);
  holder.setMask({ mask: sprite, inverse: mask.invert });
  return holder;
}

function nodeFilters(node: EvaluatedNode, ctx: BuildContext): Filter[] {
  const out: Filter[] = [];
  const filters = node.props['filters'];
  if (!Array.isArray(filters)) return out;
  for (const f of filters) {
    if (!isRecord(f)) continue;
    if (f['type'] === 'blur') {
      const sigma = typeof f['radius'] === 'number' ? f['radius'] : 0;
      // PixiJS-Stärke ≈ 2 σ (angenähert); σ gilt in lokalen Pixeln, daher × Vorschau-Skalierung.
      if (sigma > 0) out.push(track(ctx, new BlurFilter({ strength: 2 * sigma * ctx.input.scale, quality: 4 })));
      continue;
    }
    const matrix = filterMatrix(f);
    if (matrix === undefined) continue;
    const cm = new ColorMatrixFilter();
    cm.matrix = toColorMatrix(matrix);
    out.push(track(ctx, cm));
  }
  return out;
}

function isBlendMode(v: string): v is BLEND_MODES {
  return PIXI_BLEND_MODES.includes(v);
}

/**
 * Baut eine Node samt Transform, Clip, Maske, Filtern, Opacity und Blend Mode.
 *
 * @example
 * ```ts
 * stage.addChild(await buildNode(node, ctx));
 * ```
 */
export async function buildNode(node: EvaluatedNode, ctx: BuildContext): Promise<Container> {
  const { content, measured } = await buildContent(node, ctx);
  const m = localMatrix(node, measured);
  const outer = new Container();
  outer.setFromMatrix(new Matrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  let inner: Container = content;
  if (node.mask !== undefined) inner = await applyMask(inner, node.mask, ctx);
  if (node.reveal !== undefined) {
    const shape = revealShape(node.reveal, localBox(node, measured));
    inner = clipTo(inner, (g) => (shape.shape === 'ellipse' ? g.ellipse(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2) : g.rect(shape.x, shape.y, shape.width, shape.height)));
  }
  outer.addChild(inner);
  const filters = nodeFilters(node, ctx);
  const opacity = Math.min(Math.max(getNumber(node, 'opacity', 1), 0), 1);
  if (opacity < 1) {
    // Opacity wirkt auf das Gruppenbild: bei Kindern oder Fläche plus Kontur als Filter, sonst direkt.
    const asGroup = node.children.length > 0 || (node.props['stroke'] !== undefined && node.props['fill'] !== undefined) || node.type === 'text' || node.type === 'rich-text';
    if (asGroup) filters.push(track(ctx, new AlphaFilter({ alpha: opacity })));
    else outer.alpha = opacity;
  }
  if (filters.length > 0) outer.filters = filters;
  const blend = node.props['blendMode'];
  if (typeof blend === 'string' && blend !== 'normal' && isBlendMode(blend)) outer.blendMode = blend;
  return outer;
}
