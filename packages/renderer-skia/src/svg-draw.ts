/**
 * Zeichnet einen mit {@link parseSvg} erzeugten SVG-Baum mit CanvasKit.
 */
import type { Canvas, CanvasKit, Color, Paint, Path, Shader } from 'canvaskit-wasm';
import { toColor } from './paint.js';
import { nullable, type Scope } from './scope.js';
import { parseSvgTransform, svgColor, svgLength, svgNumbers, type SvgDocument, type SvgElement, type SvgMatrix } from './svg.js';
import type { TextEngine } from './text.js';

/** Kontext zum Zeichnen eines SVG-Dokuments. */
export interface SvgDrawContext {
  readonly ck: CanvasKit;
  readonly scope: Scope;
  readonly text: TextEngine;
}

/** Vererbte Darstellungswerte. */
interface SvgStyle {
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: string;
  readonly fillOpacity: number;
  readonly strokeOpacity: number;
  readonly fillRule: string;
  readonly linecap: string;
  readonly linejoin: string;
  readonly dasharray: string;
  readonly fontSize: string;
  readonly fontFamily: string;
  readonly fontWeight: string;
  readonly textAnchor: string;
  readonly color: string;
}

const ROOT_STYLE: SvgStyle = {
  fill: 'black',
  stroke: 'none',
  strokeWidth: '1',
  fillOpacity: 1,
  strokeOpacity: 1,
  fillRule: 'nonzero',
  linecap: 'butt',
  linejoin: 'miter',
  dasharray: 'none',
  fontSize: '16',
  fontFamily: '',
  fontWeight: '400',
  textAnchor: 'start',
  color: 'black',
};

function inherit(style: SvgStyle, a: Readonly<Record<string, string>>): SvgStyle {
  const num = (v: string | undefined, fallback: number): number => {
    const n = v === undefined ? Number.NaN : Number(v.trim().endsWith('%') ? Number(v.trim().slice(0, -1)) / 100 : v);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : fallback;
  };
  return {
    fill: a['fill'] ?? style.fill,
    stroke: a['stroke'] ?? style.stroke,
    strokeWidth: a['stroke-width'] ?? style.strokeWidth,
    fillOpacity: num(a['fill-opacity'], style.fillOpacity),
    strokeOpacity: num(a['stroke-opacity'], style.strokeOpacity),
    fillRule: a['fill-rule'] ?? style.fillRule,
    linecap: a['stroke-linecap'] ?? style.linecap,
    linejoin: a['stroke-linejoin'] ?? style.linejoin,
    dasharray: a['stroke-dasharray'] ?? style.dasharray,
    fontSize: a['font-size'] ?? style.fontSize,
    fontFamily: a['font-family'] ?? style.fontFamily,
    fontWeight: a['font-weight'] ?? style.fontWeight,
    textAnchor: a['text-anchor'] ?? style.textAnchor,
    color: a['color'] ?? style.color,
  };
}

function matrix3(m: SvgMatrix): number[] {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Sammelt Stopps eines Verlaufs, auch über `href` geerbte. */
function gradientStops(doc: SvgDocument, el: SvgElement, ck: CanvasKit, depth = 0): { colors: Color[]; positions: number[] } {
  const own = el.children.filter((c) => c.name === 'stop');
  if (own.length === 0 && depth < 8) {
    const ref = hrefOf(el);
    const parent = ref !== undefined ? doc.ids.get(ref) : undefined;
    if (parent !== undefined) return gradientStops(doc, parent, ck, depth + 1);
  }
  const colors: Color[] = [];
  const positions: number[] = [];
  let lastOffset = 0;
  for (const stop of own) {
    const raw = stop.attrs['offset'] ?? '0';
    const value = raw.trim().endsWith('%') ? Number(raw.trim().slice(0, -1)) / 100 : Number(raw);
    const offset = Math.max(lastOffset, Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1));
    lastOffset = offset;
    const color = svgColor(stop.attrs['stop-color'] ?? 'black') ?? '#000000FF';
    const opacityRaw = Number(stop.attrs['stop-opacity'] ?? '1');
    colors.push(toColor(ck, color, Number.isFinite(opacityRaw) ? opacityRaw : 1));
    positions.push(offset);
  }
  return { colors, positions };
}

function hrefOf(el: SvgElement): string | undefined {
  const href = el.attrs['href'] ?? el.attrs['xlink:href'];
  return href?.startsWith('#') === true ? href.slice(1) : undefined;
}

function gradientAttr(doc: SvgDocument, el: SvgElement, name: string, depth = 0): string | undefined {
  const own = el.attrs[name];
  if (own !== undefined || depth >= 8) return own;
  const ref = hrefOf(el);
  const parent = ref !== undefined ? doc.ids.get(ref) : undefined;
  return parent !== undefined ? gradientAttr(doc, parent, name, depth + 1) : undefined;
}

function gradientShader(doc: SvgDocument, el: SvgElement, bounds: Float32Array, viewport: Viewport, ctx: SvgDrawContext): Shader | undefined {
  const { ck, scope } = ctx;
  const { colors, positions } = gradientStops(doc, el, ck);
  if (colors.length === 0) return undefined;
  if (colors.length === 1) {
    const c = colors[0];
    if (c !== undefined) {
      colors.push(c);
      positions.push(1);
    }
  }
  const userSpace = gradientAttr(doc, el, 'gradientUnits') === 'userSpaceOnUse';
  const spread = gradientAttr(doc, el, 'spreadMethod');
  const tile = spread === 'reflect' ? ck.TileMode.Mirror : spread === 'repeat' ? ck.TileMode.Repeat : ck.TileMode.Clamp;
  const refW = userSpace ? viewport.width : 1;
  const refH = userSpace ? viewport.height : 1;
  const len = (name: string, fallback: string, ref: number): number => {
    const raw = gradientAttr(doc, el, name) ?? fallback;
    // Ohne Einheit sind Werte in objectBoundingBox Anteile, sonst Pixel.
    return svgLength(raw, 0, ref);
  };
  const bx = bounds[0] ?? 0;
  const by = bounds[1] ?? 0;
  const bw = (bounds[2] ?? 0) - bx;
  const bh = (bounds[3] ?? 0) - by;
  let local: SvgMatrix = userSpace ? [1, 0, 0, 1, 0, 0] : [bw, 0, 0, bh, bx, by];
  const gt = parseSvgTransform(gradientAttr(doc, el, 'gradientTransform'));
  local = [local[0] * gt[0] + local[2] * gt[1], local[1] * gt[0] + local[3] * gt[1], local[0] * gt[2] + local[2] * gt[3], local[1] * gt[2] + local[3] * gt[3], local[0] * gt[4] + local[2] * gt[5] + local[4], local[1] * gt[4] + local[3] * gt[5] + local[5]];
  if (el.name === 'linearGradient') {
    const start = [len('x1', '0%', refW), len('y1', '0%', refH)];
    const end = [len('x2', '100%', refW), len('y2', '0%', refH)];
    return scope.add(ck.Shader.MakeLinearGradient(start, end, colors, positions, tile, matrix3(local)));
  }
  const r = len('r', '50%', Math.hypot(refW, refH) / Math.SQRT2);
  const center = [len('cx', '50%', refW), len('cy', '50%', refH)];
  return scope.add(ck.Shader.MakeRadialGradient(center, Math.max(r, 1e-6), colors, positions, tile, matrix3(local)));
}

function makePaint(doc: SvgDocument, value: string, opacity: number, style: SvgStyle, path: Path | undefined, viewport: Viewport, ctx: SvgDrawContext): Paint | undefined {
  const { ck, scope } = ctx;
  const v = value.trim();
  if (v === 'none' || opacity <= 0) return undefined;
  const paint = scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/u.exec(v);
  if (url !== null) {
    const el = doc.ids.get(url[1] ?? '');
    if (el === undefined || (el.name !== 'linearGradient' && el.name !== 'radialGradient') || path === undefined) return undefined;
    const shader = gradientShader(doc, el, path.getBounds(), viewport, ctx);
    if (shader === undefined) return undefined;
    paint.setColor(ck.Color4f(0, 0, 0, opacity));
    paint.setShader(shader);
    return paint;
  }
  const color = svgColor(v === 'currentColor' ? style.color : v);
  if (color === undefined) return undefined;
  paint.setColor(toColor(ck, color, opacity));
  return paint;
}

function shapePath(el: SvgElement, viewport: Viewport, ctx: SvgDrawContext): Path | undefined {
  const { ck, scope } = ctx;
  const a = el.attrs;
  const L = (name: string, ref: number): number => svgLength(a[name], 0, ref);
  const b = new ck.PathBuilder();
  switch (el.name) {
    case 'rect': {
      const w = L('width', viewport.width);
      const h = L('height', viewport.height);
      if (w <= 0 || h <= 0) break;
      let rx = a['rx'] !== undefined ? L('rx', viewport.width) : undefined;
      let ry = a['ry'] !== undefined ? L('ry', viewport.height) : undefined;
      rx = Math.min(rx ?? ry ?? 0, w / 2);
      ry = Math.min(ry ?? rx, h / 2);
      const x = L('x', viewport.width);
      const y = L('y', viewport.height);
      b.addRRect(ck.RRectXY(ck.XYWHRect(x, y, w, h), rx, ry));
      break;
    }
    case 'circle': {
      const r = svgLength(a['r'], 0, Math.hypot(viewport.width, viewport.height) / Math.SQRT2);
      if (r <= 0) break;
      const cx = L('cx', viewport.width);
      const cy = L('cy', viewport.height);
      b.addOval(ck.LTRBRect(cx - r, cy - r, cx + r, cy + r));
      break;
    }
    case 'ellipse': {
      const rx = L('rx', viewport.width);
      const ry = L('ry', viewport.height);
      if (rx <= 0 || ry <= 0) break;
      const cx = L('cx', viewport.width);
      const cy = L('cy', viewport.height);
      b.addOval(ck.LTRBRect(cx - rx, cy - ry, cx + rx, cy + ry));
      break;
    }
    case 'line':
      b.moveTo(L('x1', viewport.width), L('y1', viewport.height));
      b.lineTo(L('x2', viewport.width), L('y2', viewport.height));
      break;
    case 'polyline':
    case 'polygon': {
      const n = svgNumbers(a['points']);
      if (n.length < 4) break;
      b.moveTo(n[0] ?? 0, n[1] ?? 0);
      for (let i = 2; i + 1 < n.length; i += 2) b.lineTo(n[i] ?? 0, n[i + 1] ?? 0);
      if (el.name === 'polygon') b.close();
      break;
    }
    case 'path': {
      b.delete();
      const d = a['d'];
      if (d === undefined) return undefined;
      const p = nullable(ck.Path.MakeFromSVGString(d));
      return p === null ? undefined : scope.add(p);
    }
    default:
      break;
  }
  const path = scope.add(b.detachAndDelete());
  return path.isEmpty() ? undefined : path;
}

function drawShape(canvas: Canvas, doc: SvgDocument, el: SvgElement, style: SvgStyle, viewport: Viewport, ctx: SvgDrawContext): void {
  const { ck, scope } = ctx;
  const path = shapePath(el, viewport, ctx);
  if (path === undefined) return;
  path.setFillType(style.fillRule === 'evenodd' ? ck.FillType.EvenOdd : ck.FillType.Winding);
  if (el.name !== 'line') {
    const fill = makePaint(doc, style.fill, style.fillOpacity, style, path, viewport, ctx);
    if (fill !== undefined) canvas.drawPath(path, fill);
  }
  const stroke = makePaint(doc, style.stroke, style.strokeOpacity, style, path, viewport, ctx);
  if (stroke !== undefined) {
    stroke.setStyle(ck.PaintStyle.Stroke);
    stroke.setStrokeWidth(svgLength(style.strokeWidth, 1, Math.hypot(viewport.width, viewport.height) / Math.SQRT2));
    stroke.setStrokeCap(style.linecap === 'round' ? ck.StrokeCap.Round : style.linecap === 'square' ? ck.StrokeCap.Square : ck.StrokeCap.Butt);
    stroke.setStrokeJoin(style.linejoin === 'round' ? ck.StrokeJoin.Round : style.linejoin === 'bevel' ? ck.StrokeJoin.Bevel : ck.StrokeJoin.Miter);
    const dash = svgNumbers(style.dasharray === 'none' ? undefined : style.dasharray);
    const even = dash.length % 2 === 1 ? [...dash, ...dash] : dash;
    if (even.length >= 2 && even.some((d) => d > 0)) stroke.setPathEffect(scope.add(ck.PathEffect.MakeDash(even, 0)));
    canvas.drawPath(path, stroke);
  }
}

function drawText(canvas: Canvas, el: SvgElement, style: SvgStyle, ctx: SvgDrawContext): void {
  const content = el.text.replace(/\s+/gu, ' ').trim();
  if (content.length === 0) return;
  const color = svgColor(style.fill === 'currentColor' ? style.color : style.fill);
  if (color === undefined) return;
  const size = svgLength(style.fontSize, 16);
  const family = style.fontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/gu, '');
  const weight = style.fontWeight === 'bold' ? 700 : Number(style.fontWeight) || 400;
  const alpha = Math.round(style.fillOpacity * Number.parseInt(color.slice(7, 9), 16));
  const paragraph = ctx.text.label(ctx.scope, content, { size, color: `${color.slice(0, 7)}${alpha.toString(16).padStart(2, '0')}`, weight, ...(family !== undefined && family.length > 0 ? { family } : {}) });
  const width = paragraph.getMaxIntrinsicWidth();
  const x = svgNumbers(el.attrs['x'])[0] ?? 0;
  const y = svgNumbers(el.attrs['y'])[0] ?? 0;
  const shift = style.textAnchor === 'middle' ? width / 2 : style.textAnchor === 'end' ? width : 0;
  canvas.drawParagraph(paragraph, x - shift, y - paragraph.getAlphabeticBaseline());
}

function drawElement(canvas: Canvas, doc: SvgDocument, el: SvgElement, parent: SvgStyle, viewport: Viewport, ctx: SvgDrawContext, depth: number): void {
  if (depth > 32) return;
  const { ck, scope } = ctx;
  const style = inherit(parent, el.attrs);
  const opacityRaw = el.attrs['opacity'];
  const opacity = opacityRaw === undefined ? 1 : Math.min(Math.max(Number(opacityRaw), 0), 1);
  if (opacity <= 0 || el.attrs['display'] === 'none' || el.attrs['visibility'] === 'hidden') return;
  canvas.save();
  if (el.attrs['transform'] !== undefined) canvas.concat(matrix3(parseSvgTransform(el.attrs['transform'])));
  if (opacity < 1) {
    const p = scope.add(new ck.Paint());
    p.setAlphaf(opacity);
    canvas.saveLayer(p);
  }
  switch (el.name) {
    case 'svg':
    case 'g':
      if (el.name === 'svg' && depth > 0) canvas.translate(svgLength(el.attrs['x'], 0), svgLength(el.attrs['y'], 0));
      for (const child of el.children) drawElement(canvas, doc, child, style, viewport, ctx, depth + 1);
      break;
    case 'use': {
      const ref = hrefOf(el);
      const target = ref !== undefined ? doc.ids.get(ref) : undefined;
      if (target !== undefined) {
        canvas.translate(svgLength(el.attrs['x'], 0), svgLength(el.attrs['y'], 0));
        drawElement(canvas, doc, target, style, viewport, ctx, depth + 1);
      }
      break;
    }
    case 'rect':
    case 'circle':
    case 'ellipse':
    case 'line':
    case 'polyline':
    case 'polygon':
    case 'path':
      drawShape(canvas, doc, el, style, viewport, ctx);
      break;
    case 'text':
      drawText(canvas, el, style, ctx);
      break;
    default:
      // defs, Verläufe, Stopps und nicht unterstützte Elemente zeichnen nichts.
      break;
  }
  if (opacity < 1) canvas.restore();
  canvas.restore();
}

/**
 * Zeichnet ein SVG-Dokument in seine Eigengröße (`doc.width × doc.height`) mit
 * `viewBox`-Abbildung nach `xMidYMid meet`.
 *
 * @example
 * ```ts
 * drawSvgDocument(canvas, parseSvg(markup), { ck, scope, text: engine });
 * ```
 */
export function drawSvgDocument(canvas: Canvas, doc: SvgDocument, ctx: SvgDrawContext): void {
  canvas.save();
  let viewport: Viewport = { width: doc.width, height: doc.height };
  if (doc.viewBox !== undefined) {
    const [vx, vy, vw, vh] = doc.viewBox;
    const s = Math.min(doc.width / vw, doc.height / vh);
    canvas.translate((doc.width - vw * s) / 2, (doc.height - vh * s) / 2);
    canvas.scale(s, s);
    canvas.translate(-vx, -vy);
    viewport = { width: vw, height: vh };
  }
  drawElement(canvas, doc, doc.root, ROOT_STYLE, viewport, ctx, 0);
  canvas.restore();
}
