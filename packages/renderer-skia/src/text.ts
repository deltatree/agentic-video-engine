/**
 * Typografie über CanvasKit Paragraph (FR-32..FR-35): Textsatz mit Kerning, Ligaturen,
 * OpenType-Features, variablen Achsen, Umbruch, Ellipse, Emoji-Ersatz, Verlaufsfüllung,
 * Kontur, Hintergrundbox, Text entlang eines Pfads und Animation pro Einheit.
 */
import type { Canvas, CanvasKit, ContourMeasure, FontStyle, FontWeight, FontWidth, Paragraph, ParagraphBuilder, TextAlign, TextStyle, TypefaceFontProvider } from 'canvaskit-wasm';
import {
  DEFAULT_FILL,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  isRecord,
  splitTextUnits,
  textUnitState,
  type EvaluatedNode,
  type FontResolver,
  type TextMeasurer,
} from '@agentic-video/core';
import { gradientShader, toColor, type Box } from './paint.js';
import { Scope, nullable } from './scope.js';

/** Ergebnis des Textsatzes einer Text-Node. */
export interface TextLayout {
  /** Absatz mit Füllung. */
  readonly fill: Paragraph;
  /** Absatz mit Kontur, falls `stroke` gesetzt ist. */
  readonly stroke: Paragraph | undefined;
  /** Gesamter Text (bei `rich-text` die verketteten Spans). */
  readonly text: string;
  /** Box inklusive Hintergrund-Innenabstand. */
  readonly width: number;
  readonly height: number;
  /** Innenabstand der Hintergrundbox; der Text beginnt bei (padX, padY). */
  readonly padX: number;
  readonly padY: number;
  readonly lines: number;
  readonly overflow: boolean;
  readonly missingGlyphs: number;
  /** Grundlinie der ersten Zeile, gemessen von der Oberkante der Box. */
  readonly baseline: number;
}

/** Aufgelöster Stil eines Textlaufs. */
interface RunStyle {
  readonly family: string;
  readonly size: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly stretch: number;
  readonly features: Readonly<Record<string, number>>;
  readonly variations: Readonly<Record<string, number>>;
  readonly letterSpacing: number;
  readonly lineHeight: number;
  readonly fill: unknown;
  readonly stroke: unknown;
  readonly strokeWidth: number;
  readonly decoration: string;
}

interface Run {
  readonly text: string;
  readonly style: RunStyle;
}

const HUGE_WIDTH = 1e6;

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

function styleFrom(src: Readonly<Record<string, unknown>>, base: RunStyle): RunStyle {
  const num = (key: string, fallback: number): number => {
    const v = src[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  const hasFill = src['fill'] !== undefined;
  const hasStroke = src['stroke'] !== undefined;
  return {
    family: typeof src['fontFamily'] === 'string' ? src['fontFamily'] : base.family,
    size: num('fontSize', base.size),
    weight: num('fontWeight', base.weight),
    italic: src['fontStyle'] === 'italic' ? true : src['fontStyle'] === 'normal' ? false : base.italic,
    stretch: num('fontStretch', base.stretch),
    features: { ...base.features, ...numberRecord(src['fontFeatures']) },
    variations: { ...base.variations, ...numberRecord(src['fontVariations']) },
    letterSpacing: num('letterSpacing', base.letterSpacing),
    lineHeight: num('lineHeight', base.lineHeight),
    fill: hasFill ? src['fill'] : base.fill,
    stroke: hasStroke ? src['stroke'] : base.stroke,
    strokeWidth: num('strokeWidth', base.strokeWidth),
    decoration: typeof src['decoration'] === 'string' ? src['decoration'] : base.decoration,
  };
}

/** Text einer `text`-Node oder die Spans einer `rich-text`-Node als Läufe. */
function runsOf(node: EvaluatedNode, base: RunStyle): Run[] {
  const nodeStyle = styleFrom(node.props, base);
  // Füllung nach effectiveFill: ohne fill und ohne stroke weiß.
  const style: RunStyle = nodeStyle.fill === undefined && nodeStyle.stroke === undefined ? { ...nodeStyle, fill: DEFAULT_FILL } : nodeStyle;
  if (node.type === 'rich-text') {
    const spans = node.props['spans'];
    if (!Array.isArray(spans)) return [];
    const runs: Run[] = [];
    for (const span of spans) {
      if (!isRecord(span)) continue;
      const text = span['text'];
      if (typeof text === 'string') runs.push({ text, style: styleFrom(span, style) });
    }
    return runs;
  }
  const text = node.props['text'];
  return [{ text: typeof text === 'string' ? text : typeof text === 'number' ? String(text) : '', style }];
}

/** Hebräisch, Arabisch, Syrisch, Thaana, NKo und ihre Präsentationsformen. */
function isRtlCodePoint(cp: number): boolean {
  return (cp >= 0x0590 && cp <= 0x08ff) || (cp >= 0xfb1d && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
}
const STRONG_CHAR = /\p{L}/u;

/**
 * Erkennt die Schreibrichtung am ersten starken Zeichen.
 *
 * @example
 * ```ts
 * detectDirection('שלום world'); // 'rtl'
 * ```
 */
export function detectDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (isRtlCodePoint(ch.codePointAt(0) ?? 0)) return 'rtl';
    if (STRONG_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

/**
 * Textsatz-Maschine für eine Menge von Schriften. Registriert alle Schriften einmal
 * in einem `TypefaceFontProvider`; es werden nie Systemschriften geladen.
 *
 * @example
 * ```ts
 * const engine = new TextEngine(ck, fonts, 'Inter');
 * const layout = engine.layout(node, scope);
 * ```
 */
export class TextEngine {
  readonly ck: CanvasKit;
  readonly fonts: FontResolver;
  readonly defaultFamily: string;
  #provider: TypefaceFontProvider | undefined;
  readonly #families = new Map<string, string>();
  readonly #variable = new Set<string>();

  constructor(ck: CanvasKit, fonts: FontResolver, defaultFont?: string) {
    this.ck = ck;
    this.fonts = fonts;
    for (const face of fonts.all()) {
      if (!this.#families.has(face.family.toLowerCase())) this.#families.set(face.family.toLowerCase(), face.family);
      if (face.variable) this.#variable.add(face.family);
    }
    const wanted = defaultFont ?? DEFAULT_FONT_FAMILY;
    this.defaultFamily = this.#families.get(wanted.toLowerCase()) ?? this.#families.get(DEFAULT_FONT_FAMILY.toLowerCase()) ?? fonts.all()[0]?.family ?? wanted;
  }

  /** Font-Provider mit allen Schriften (einmal erzeugt). */
  get provider(): TypefaceFontProvider {
    if (this.#provider === undefined) {
      const provider = this.ck.TypefaceFontProvider.Make();
      for (const face of this.fonts.all()) provider.registerFont(face.bytes, face.family);
      this.#provider = provider;
    }
    return this.#provider;
  }

  /** Geladener Familienname in der registrierten Schreibweise oder die Standardfamilie. */
  resolveFamily(name: string | undefined): string {
    if (name === undefined) return this.defaultFamily;
    return this.#families.get(name.toLowerCase()) ?? this.defaultFamily;
  }

  /** Familienkette: gewünschte Familie, dann Ersatzfamilien (Emoji zuerst). */
  familyChain(name: string | undefined): string[] {
    const first = this.resolveFamily(name);
    const chain = [first];
    for (const f of this.fonts.fallbacks()) {
      const canonical = this.#families.get(f.toLowerCase());
      if (canonical !== undefined && !chain.includes(canonical)) chain.push(canonical);
    }
    return chain;
  }

  #fontStyle(style: RunStyle): FontStyle {
    const ck = this.ck;
    const weights: [number, FontWeight][] = [
      [100, ck.FontWeight.Thin],
      [200, ck.FontWeight.ExtraLight],
      [300, ck.FontWeight.Light],
      [400, ck.FontWeight.Normal],
      [500, ck.FontWeight.Medium],
      [600, ck.FontWeight.SemiBold],
      [700, ck.FontWeight.Bold],
      [800, ck.FontWeight.ExtraBold],
      [900, ck.FontWeight.Black],
      [1000, ck.FontWeight.ExtraBlack],
    ];
    const widths: [number, FontWidth][] = [
      [50, ck.FontWidth.UltraCondensed],
      [62.5, ck.FontWidth.ExtraCondensed],
      [75, ck.FontWidth.Condensed],
      [87.5, ck.FontWidth.SemiCondensed],
      [100, ck.FontWidth.Normal],
      [112.5, ck.FontWidth.SemiExpanded],
      [125, ck.FontWidth.Expanded],
      [150, ck.FontWidth.ExtraExpanded],
      [200, ck.FontWidth.UltraExpanded],
    ];
    const nearest = <T>(list: [number, T][], v: number, fallback: T): T => {
      let best = fallback;
      let bestD = Number.POSITIVE_INFINITY;
      for (const [k, entry] of list) {
        const d = Math.abs(k - v);
        if (d < bestD) {
          bestD = d;
          best = entry;
        }
      }
      return best;
    };
    return {
      weight: nearest(weights, style.weight, ck.FontWeight.Normal),
      width: nearest(widths, style.stretch, ck.FontWidth.Normal),
      slant: style.italic ? ck.FontSlant.Italic : ck.FontSlant.Upright,
    };
  }

  #textStyle(style: RunStyle, color: Float32Array): TextStyle {
    const ck = this.ck;
    const family = this.resolveFamily(style.family);
    const variations = { ...style.variations };
    // Variable Schriften erhalten das Gewicht als Achse, falls nicht explizit gesetzt.
    if (this.#variable.has(family) && variations['wght'] === undefined) variations['wght'] = style.weight;
    const decoration = style.decoration === 'underline' ? ck.UnderlineDecoration : style.decoration === 'line-through' ? ck.LineThroughDecoration : style.decoration === 'overline' ? ck.OverlineDecoration : ck.NoDecoration;
    return new ck.TextStyle({
      color,
      fontFamilies: this.familyChain(style.family),
      fontSize: style.size,
      fontStyle: this.#fontStyle(style),
      fontFeatures: Object.entries(style.features).map(([name, value]) => ({ name, value })),
      fontVariations: Object.entries(variations).map(([axis, value]) => ({ axis, value })),
      letterSpacing: style.letterSpacing,
      heightMultiplier: style.lineHeight,
      halfLeading: true,
      decoration,
      decorationColor: color,
    });
  }

  #build(node: EvaluatedNode, runs: readonly Run[], mode: 'fill' | 'stroke', box: Box | undefined, scope: Scope): Paragraph {
    const ck = this.ck;
    const first = runs[0]?.style;
    const align = node.props['textAlign'];
    const text = runs.map((r) => r.text).join('');
    const dirProp = node.props['direction'];
    const direction = dirProp === 'rtl' || dirProp === 'ltr' ? dirProp : detectDirection(text);
    const maxLines = node.props['maxLines'];
    const ellipsis = node.props['ellipsis'];
    const alignMap = new Map<unknown, TextAlign>([
      ['left', ck.TextAlign.Left],
      ['right', ck.TextAlign.Right],
      ['center', ck.TextAlign.Center],
      ['justify', ck.TextAlign.Justify],
      ['start', ck.TextAlign.Start],
      ['end', ck.TextAlign.End],
    ]);
    const paragraphStyle = new ck.ParagraphStyle({
      textStyle: this.#textStyle(first ?? baseStyle(this.defaultFamily), ck.TRANSPARENT),
      textAlign: alignMap.get(align) ?? ck.TextAlign.Left,
      textDirection: direction === 'rtl' ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      ...(typeof maxLines === 'number' ? { maxLines } : {}),
      ...(typeof ellipsis === 'string' && ellipsis.length > 0 ? { ellipsis } : {}),
      applyRoundingHack: false,
      replaceTabCharacters: true,
    });
    const builder: ParagraphBuilder = ck.ParagraphBuilder.MakeFromFontProvider(paragraphStyle, this.provider);
    const transparent = scope.add(new ck.Paint());
    transparent.setColor(ck.TRANSPARENT);
    for (const run of runs) {
      const value = mode === 'fill' ? run.style.fill : run.style.stroke;
      if (typeof value === 'string' && mode === 'fill') {
        builder.pushStyle(this.#textStyle(run.style, toColor(ck, value)));
      } else if (value !== undefined && (typeof value === 'string' || isRecord(value))) {
        const paint = scope.add(new ck.Paint());
        paint.setAntiAlias(true);
        if (typeof value === 'string') paint.setColor(toColor(ck, value));
        else {
          paint.setColor(ck.BLACK);
          const shader = box !== undefined ? gradientShader(ck, scope, value, box) : undefined;
          if (shader !== undefined) paint.setShader(shader);
        }
        if (mode === 'stroke') {
          paint.setStyle(ck.PaintStyle.Stroke);
          paint.setStrokeWidth(run.style.strokeWidth);
          paint.setStrokeJoin(ck.StrokeJoin.Round);
        }
        builder.pushPaintStyle(this.#textStyle(run.style, ck.BLACK), paint, transparent);
      } else {
        builder.pushStyle(this.#textStyle(run.style, ck.TRANSPARENT));
      }
      builder.addText(run.text);
      builder.pop();
    }
    const paragraph = scope.add(builder.build());
    builder.delete();
    return paragraph;
  }

  /**
   * Setzt eine `text`- oder `rich-text`-Node. Ohne `width` bricht der Text nur an `\n` um.
   * Objekte gehören dem Scope.
   */
  layout(node: EvaluatedNode, scope: Scope): TextLayout {
    const runs = runsOf(node, baseStyle(this.defaultFamily));
    const text = runs.map((r) => r.text).join('');
    const widthProp = node.props['width'];
    const fixedWidth = typeof widthProp === 'number' && widthProp > 0 ? widthProp : undefined;
    const layoutParagraph = (p: Paragraph): number => {
      if (fixedWidth !== undefined) {
        p.layout(fixedWidth);
        return fixedWidth;
      }
      p.layout(HUGE_WIDTH);
      const w = Math.max(1, Math.ceil(p.getMaxIntrinsicWidth()));
      p.layout(w);
      return w;
    };
    const hasGradient = runs.some((r) => isRecord(r.style.fill) || isRecord(r.style.stroke));
    let fill = this.#build(node, runs, 'fill', undefined, scope);
    const contentWidth = layoutParagraph(fill);
    const contentHeight = fill.getHeight();
    const bg = node.props['background'];
    const padX = isRecord(bg) && typeof bg['paddingX'] === 'number' ? bg['paddingX'] : 0;
    const padY = isRecord(bg) && typeof bg['paddingY'] === 'number' ? bg['paddingY'] : 0;
    const box: Box = { x: padX, y: padY, width: contentWidth, height: contentHeight };
    if (hasGradient) {
      fill = this.#build(node, runs, 'fill', box, scope);
      layoutParagraph(fill);
    }
    let stroke: Paragraph | undefined;
    if (runs.some((r) => r.style.stroke !== undefined)) {
      stroke = this.#build(node, runs, 'stroke', box, scope);
      layoutParagraph(stroke);
    }
    const overflow = fill.didExceedMaxLines() || (fixedWidth !== undefined && fill.getLongestLine() > fixedWidth + 0.5);
    return {
      fill,
      stroke,
      text,
      width: contentWidth + 2 * padX,
      height: contentHeight + 2 * padY,
      padX,
      padY,
      lines: fill.getNumberOfLines(),
      overflow,
      missingGlyphs: fill.unresolvedCodepoints().length,
      baseline: padY + fill.getAlphabeticBaseline(),
    };
  }

  /**
   * Einfacher Absatz in einer Farbe (für Beschriftungen, Debug-Overlays und SVG-Text).
   */
  label(scope: Scope, text: string, options: { readonly size: number; readonly color: string; readonly family?: string; readonly weight?: number; readonly width?: number; readonly align?: 'left' | 'center' | 'right' }): Paragraph {
    const node: EvaluatedNode = {
      id: 'label',
      type: 'text',
      props: { text, fontSize: options.size, fill: options.color, fontWeight: options.weight ?? 400, textAlign: options.align ?? 'left', ...(options.family !== undefined ? { fontFamily: options.family } : {}), ...(options.width !== undefined ? { width: options.width } : {}) },
      children: [],
      time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 },
      pointer: '',
    };
    return this.layout(node, scope).fill;
  }

  /** Gibt den Font-Provider frei. */
  dispose(): void {
    this.#provider?.delete();
    this.#provider = undefined;
  }
}

function baseStyle(family: string): RunStyle {
  return {
    family,
    size: DEFAULT_FONT_SIZE,
    weight: 400,
    italic: false,
    stretch: 100,
    features: {},
    variations: {},
    letterSpacing: 0,
    lineHeight: DEFAULT_LINE_HEIGHT,
    fill: undefined,
    stroke: undefined,
    strokeWidth: 1,
    decoration: 'none',
  };
}

// ---------------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------------

/** Umschließendes Rechteck aller Rechtecke eines Textbereichs. */
function rangeRects(p: Paragraph, ck: CanvasKit, start: number, end: number): { l: number; t: number; r: number; b: number }[] {
  return p.getRectsForRange(start, end, ck.RectHeightStyle.Max, ck.RectWidthStyle.Tight).map((r) => ({ l: r.rect[0] ?? 0, t: r.rect[1] ?? 0, r: r.rect[2] ?? 0, b: r.rect[3] ?? 0 }));
}

/**
 * Zeichnet Kontur und Füllung. Die Kontur liegt unter der Füllung: Variable Schriften
 * haben überlappende Konturen, deren innere Linien die Füllung so verdeckt.
 */
function drawParagraphs(canvas: Canvas, layout: TextLayout, x: number, y: number): void {
  if (layout.stroke !== undefined) canvas.drawParagraph(layout.stroke, x, y);
  canvas.drawParagraph(layout.fill, x, y);
}

function drawBackground(ck: CanvasKit, canvas: Canvas, node: EvaluatedNode, layout: TextLayout, scope: Scope): void {
  const bg = node.props['background'];
  if (!isRecord(bg) || typeof bg['color'] !== 'string') return;
  const paint = scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  paint.setColor(toColor(ck, bg['color']));
  const radius = typeof bg['radius'] === 'number' ? bg['radius'] : 0;
  if (bg['perLine'] === true) {
    for (const lm of layout.fill.getLineMetrics()) {
      if (lm.width <= 0) continue;
      const top = lm.baseline - lm.ascent;
      const bottom = lm.baseline + lm.descent;
      canvas.drawRRect(ck.RRectXY(ck.LTRBRect(lm.left, top, lm.left + lm.width + 2 * layout.padX, bottom + 2 * layout.padY), radius, radius), paint);
    }
    return;
  }
  canvas.drawRRect(ck.RRectXY(ck.LTRBRect(0, 0, layout.width, layout.height), radius, radius), paint);
}

/** Kontext für das Zeichnen von Text. */
export interface TextDrawContext {
  readonly ck: CanvasKit;
  readonly scope: Scope;
  readonly fps: number;
}

function drawAnimated(canvas: Canvas, node: EvaluatedNode, layout: TextLayout, spec: Readonly<Record<string, unknown>>, ctx: TextDrawContext): void {
  const { ck, scope } = ctx;
  const unit = spec['unit'] === 'word' || spec['unit'] === 'line' ? spec['unit'] : 'char';
  const units = splitTextUnits(layout.text, unit);
  let cursor = 0;
  units.forEach((u, i) => {
    const found = layout.text.indexOf(u, cursor);
    const start = found < 0 ? cursor : found;
    const end = start + u.length;
    cursor = end;
    const state = textUnitState(node, i, units.length, node.time.localFrame, ctx.fps);
    if (state.opacity <= 0 || state.scale === 0) return;
    const rects = rangeRects(layout.fill, ck, start, end).filter((r) => r.r > r.l && r.b > r.t);
    if (rects.length === 0) return;
    const l = Math.min(...rects.map((r) => r.l));
    const t = Math.min(...rects.map((r) => r.t));
    const r = Math.max(...rects.map((q) => q.r));
    const b = Math.max(...rects.map((q) => q.b));
    // Verschiebung, Drehung und Skalierung wirken um die Mitte der Einheit.
    const cx = layout.padX + (l + r) / 2;
    const cy = layout.padY + (t + b) / 2;
    canvas.save();
    canvas.translate(cx + state.dx, cy + state.dy);
    if (state.rotation !== 0) canvas.rotate(state.rotation, 0, 0);
    if (state.scale !== 1) canvas.scale(state.scale, state.scale);
    canvas.translate(-cx, -cy);
    const clip = new ck.PathBuilder();
    for (const q of rects) clip.addRect(ck.LTRBRect(layout.padX + q.l, layout.padY + q.t, layout.padX + q.r, layout.padY + q.b));
    const clipPath = scope.add(clip.detachAndDelete());
    canvas.clipPath(clipPath, ck.ClipOp.Intersect, true);
    const needsLayer = state.opacity < 1 || state.blur > 0 || state.color !== undefined;
    if (needsLayer) {
      const paint = scope.add(new ck.Paint());
      paint.setAlphaf(Math.min(state.opacity, 1));
      if (state.blur > 0) paint.setImageFilter(scope.add(ck.ImageFilter.MakeBlur(state.blur, state.blur, ck.TileMode.Decal, null)));
      if (state.color !== undefined && state.color.mix > 0) {
        const identity = scope.add(ck.ColorFilter.MakeMatrix(ck.ColorMatrix.identity()));
        const tint = scope.add(ck.ColorFilter.MakeBlend(toColor(ck, state.color.from), ck.BlendMode.SrcIn));
        paint.setColorFilter(scope.add(ck.ColorFilter.MakeLerp(state.color.mix, identity, tint)));
      }
      canvas.saveLayer(paint);
    }
    drawParagraphs(canvas, layout, layout.padX, layout.padY);
    if (needsLayer) canvas.restore();
    canvas.restore();
  });
}

/** Ein Graphem auf dem Pfad: Position, Richtung und Rechteck im Absatz. */
interface PathGlyph {
  readonly start: number;
  readonly end: number;
  readonly rect: { readonly l: number; readonly t: number; readonly r: number; readonly b: number };
  /** Punkt auf dem Pfad (Mitte der Grundlinie) und Winkel in Grad. */
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** Legt die Grapheme entlang des Pfads (Mitte jedes Graphems auf `offset + Mitte`). */
function pathGlyphs(layout: TextLayout, textPath: Readonly<Record<string, unknown>>, ctx: TextDrawContext): { glyphs: PathGlyph[]; pointAt: (distance: number) => { x: number; y: number; angle: number } | undefined } {
  const { ck, scope } = ctx;
  const none = { glyphs: [], pointAt: () => undefined };
  if (typeof textPath['d'] !== 'string') return none;
  const path = nullable(ck.Path.MakeFromSVGString(textPath['d']));
  if (path === null) return none;
  scope.add(path);
  const iter = scope.add(new ck.ContourMeasureIter(path, false, 1));
  const contours: { measure: ContourMeasure; start: number; length: number }[] = [];
  let total = 0;
  for (let m = nullable(iter.next()); m !== null; m = nullable(iter.next())) {
    scope.add(m);
    contours.push({ measure: m, start: total, length: m.length() });
    total += m.length();
  }
  const pointAt = (distance: number): { x: number; y: number; angle: number } | undefined => {
    const contour = contours.find((c) => distance >= c.start && distance <= c.start + c.length);
    if (contour === undefined) return undefined;
    const [px = 0, py = 0, tx = 1, ty = 0] = contour.measure.getPosTan(distance - contour.start);
    return { x: px, y: py, angle: (Math.atan2(ty, tx) * 180) / Math.PI };
  };
  const offset = typeof textPath['offset'] === 'number' ? textPath['offset'] : 0;
  const glyphs: PathGlyph[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const seg of segmenter.segment(layout.text)) {
    const rect = rangeRects(layout.fill, ck, seg.index, seg.index + seg.segment.length).filter((r) => r.r > r.l)[0];
    if (rect === undefined) continue;
    const at = pointAt(offset + (rect.l + rect.r) / 2);
    if (at === undefined) continue;
    glyphs.push({ start: seg.index, end: seg.index + seg.segment.length, rect, ...at });
  }
  return { glyphs, pointAt };
}

/** Setzt die Zeichenfläche in den Rahmen eines Graphems (Grundlinie auf dem Pfad). */
function enterGlyph(canvas: Canvas, g: PathGlyph, baseline: number): void {
  canvas.translate(g.x, g.y);
  canvas.rotate(g.angle, 0, 0);
  canvas.translate(-(g.rect.l + g.rect.r) / 2, -baseline);
}

/**
 * Hintergrund entlang des Pfads: ein Band in Zeilenhöhe plus `paddingY`, das dem Pfad folgt
 * (parallel zur Grundlinie, von `paddingX` vor dem ersten bis `paddingX` nach dem letzten Graphem).
 * `radius > 0` rundet die Enden (Halbkreis). Das Band ist ein einziger Strich, daher ohne Fugen
 * in Kurven.
 */
function drawPathBackground(canvas: Canvas, node: EvaluatedNode, layout: TextLayout, glyphs: readonly PathGlyph[], baseline: number, offset: number, pointAt: (distance: number) => { x: number; y: number; angle: number } | undefined, ctx: TextDrawContext): void {
  const bg = node.props['background'];
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];
  if (!isRecord(bg) || typeof bg['color'] !== 'string' || first === undefined || last === undefined) return;
  const { ck, scope } = ctx;
  const radius = typeof bg['radius'] === 'number' ? bg['radius'] : 0;
  const top = Math.min(...glyphs.map((g) => g.rect.t)) - layout.padY;
  const bottom = Math.max(...glyphs.map((g) => g.rect.b)) + layout.padY;
  const height = bottom - top;
  // Mittellinie des Bands, versetzt zur Grundlinie (lokales y nach unten).
  const mid = (top + bottom) / 2 - baseline;
  const cap = radius > 0 ? height / 2 : 0;
  const from = offset + first.rect.l - layout.padX + cap;
  const to = offset + last.rect.r + layout.padX - cap;
  const b = new ck.PathBuilder();
  let started = false;
  const steps = Math.max(2, Math.ceil((to - from) / 2));
  for (let i = 0; i <= steps; i++) {
    const at = pointAt(from + ((to - from) * i) / steps);
    if (at === undefined) continue;
    const a = (at.angle * Math.PI) / 180;
    const x = at.x - Math.sin(a) * mid;
    const y = at.y + Math.cos(a) * mid;
    if (started) b.lineTo(x, y);
    else b.moveTo(x, y);
    started = true;
  }
  const band = scope.add(b.detachAndDelete());
  if (!started) return;
  const paint = scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  paint.setColor(toColor(ck, bg['color']));
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeWidth(height);
  paint.setStrokeJoin(ck.StrokeJoin.Round);
  paint.setStrokeCap(radius > 0 ? ck.StrokeCap.Round : ck.StrokeCap.Butt);
  canvas.drawPath(band, paint);
}

function drawOnPath(canvas: Canvas, node: EvaluatedNode, layout: TextLayout, textPath: Readonly<Record<string, unknown>>, ctx: TextDrawContext): void {
  const { ck, scope } = ctx;
  const { glyphs, pointAt } = pathGlyphs(layout, textPath, ctx);
  const baseline = layout.fill.getAlphabeticBaseline();
  const offset = typeof textPath['offset'] === 'number' ? textPath['offset'] : 0;
  drawPathBackground(canvas, node, layout, glyphs, baseline, offset, pointAt, ctx);
  const anim = node.props['textAnimation'];
  // Einheiten der Animation: Zeichenbereiche im Text und ihr Mittelpunkt auf dem Pfad.
  let units: { start: number; end: number }[] = [];
  if (isRecord(anim)) {
    const unit = anim['unit'] === 'word' || anim['unit'] === 'line' ? anim['unit'] : 'char';
    let cursor = 0;
    units = splitTextUnits(layout.text, unit).map((u) => {
      const found = layout.text.indexOf(u, cursor);
      const start = found < 0 ? cursor : found;
      cursor = start + u.length;
      return { start, end: start + u.length };
    });
  }
  const drawGlyph = (g: PathGlyph): void => {
    canvas.save();
    enterGlyph(canvas, g, baseline);
    canvas.clipRect(ck.LTRBRect(g.rect.l, g.rect.t, g.rect.r, g.rect.b), ck.ClipOp.Intersect, true);
    drawParagraphs(canvas, layout, 0, 0);
    canvas.restore();
  };
  if (units.length === 0) {
    for (const g of glyphs) drawGlyph(g);
    return;
  }
  units.forEach((u, i) => {
    const members = glyphs.filter((g) => g.start >= u.start && g.end <= u.end);
    if (members.length === 0) return;
    const state = textUnitState(node, i, units.length, node.time.localFrame, ctx.fps);
    if (state.opacity <= 0 || state.scale === 0) return;
    // Verschiebung, Drehung und Skalierung wirken um die Mitte der Einheit auf dem Pfad.
    const l = Math.min(...members.map((g) => g.rect.l));
    const r = Math.max(...members.map((g) => g.rect.r));
    const center = pointAt(offset + (l + r) / 2) ?? { x: members[0]?.x ?? 0, y: members[0]?.y ?? 0, angle: 0 };
    canvas.save();
    canvas.translate(center.x + state.dx, center.y + state.dy);
    if (state.rotation !== 0) canvas.rotate(state.rotation, 0, 0);
    if (state.scale !== 1) canvas.scale(state.scale, state.scale);
    canvas.translate(-center.x, -center.y);
    const needsLayer = state.opacity < 1 || state.blur > 0 || state.color !== undefined;
    if (needsLayer) {
      const paint = scope.add(new ck.Paint());
      paint.setAlphaf(Math.min(state.opacity, 1));
      if (state.blur > 0) paint.setImageFilter(scope.add(ck.ImageFilter.MakeBlur(state.blur, state.blur, ck.TileMode.Decal, null)));
      if (state.color !== undefined && state.color.mix > 0) {
        const identity = scope.add(ck.ColorFilter.MakeMatrix(ck.ColorMatrix.identity()));
        const tint = scope.add(ck.ColorFilter.MakeBlend(toColor(ck, state.color.from), ck.BlendMode.SrcIn));
        paint.setColorFilter(scope.add(ck.ColorFilter.MakeLerp(state.color.mix, identity, tint)));
      }
      canvas.saveLayer(paint);
    }
    for (const g of members) drawGlyph(g);
    if (needsLayer) canvas.restore();
    canvas.restore();
  });
}

/**
 * Zeichnet eine gesetzte Text-Node im lokalen Koordinatensystem der Node.
 *
 * @example
 * ```ts
 * drawTextLayout(canvas, node, engine.layout(node, scope), { ck, scope, fps: 30 });
 * ```
 */
export function drawTextLayout(canvas: Canvas, node: EvaluatedNode, layout: TextLayout, ctx: TextDrawContext): void {
  const textPath = node.props['textPath'];
  if (isRecord(textPath)) {
    // Auf dem Pfad wirken Hintergrund und textAnimation ebenfalls (Story 17.6).
    drawOnPath(canvas, node, layout, textPath, ctx);
    return;
  }
  drawBackground(ctx.ck, canvas, node, layout, ctx.scope);
  const anim = node.props['textAnimation'];
  if (isRecord(anim)) {
    drawAnimated(canvas, node, layout, anim, ctx);
    return;
  }
  drawParagraphs(canvas, layout, layout.padX, layout.padY);
}

/**
 * Textmesser auf Basis von CanvasKit Paragraph (Breite, Höhe, Zeilen, Überlauf, fehlende Glyphen, Grundlinie).
 * Die Maße enthalten den Innenabstand einer Hintergrundbox.
 *
 * @example
 * ```ts
 * const measurer = createSkiaTextMeasurer(ck, fonts);
 * const bounds = computeBounds(scene, measurer);
 * ```
 */
export function createSkiaTextMeasurer(canvasKit: CanvasKit, fonts: FontResolver, defaultFont?: string): TextMeasurer & { dispose(): void } {
  const engine = new TextEngine(canvasKit, fonts, defaultFont);
  return {
    measure(node: EvaluatedNode) {
      const scope = new Scope();
      try {
        const l = engine.layout(node, scope);
        return { width: l.width, height: l.height, lines: l.lines, overflow: l.overflow, missingGlyphs: l.missingGlyphs, baseline: l.baseline };
      } finally {
        scope.dispose();
      }
    },
    dispose() {
      engine.dispose();
    },
  };
}
