/**
 * Zeichnet einen mit {@link parseSvg} erzeugten SVG-Baum mit CanvasKit.
 * Dazu gehören `clipPath`, `mask`, `pattern`, `image` und `tspan` (Story 17.6).
 */
import type { Canvas, CanvasKit, Color, Paint, Path, Shader } from 'canvaskit-wasm';
import { maskColorFilter, toColor } from './paint.js';
import { nullable, type Scope } from './scope.js';
import { svgImagesOf } from './svg-image.js';
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
    if (el === undefined || path === undefined) return undefined;
    if (el.name === 'pattern') {
      const shader = patternShader(doc, el, path.getBounds(), style, viewport, ctx);
      if (shader === undefined) return undefined;
      paint.setColor(ck.Color4f(0, 0, 0, opacity));
      paint.setShader(shader);
      return paint;
    }
    if (el.name !== 'linearGradient' && el.name !== 'radialGradient') return undefined;
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

/** Ein Textlauf mit eigenem Stil und Position (aus `text` und `tspan`). */
interface TextRun {
  readonly text: string;
  readonly style: SvgStyle;
  /** Beginn eines neuen Textblocks mit absoluter Position (x und/oder y gesetzt). */
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly dx: number;
  readonly dy: number;
}

/** Sammelt die Läufe eines `text`-Elements in Dokumentreihenfolge; `tspan` erbt den Stil. */
function textRuns(el: SvgElement, style: SvgStyle): TextRun[] {
  const runs: TextRun[] = [];
  const visit = (node: SvgElement, s: SvgStyle, first: boolean): void => {
    const own = (name: string): number | undefined => svgNumbers(node.attrs[name])[0];
    let pending = { x: first ? own('x') : node.name === 'tspan' ? own('x') : undefined, y: first ? own('y') : node.name === 'tspan' ? own('y') : undefined, dx: own('dx') ?? 0, dy: own('dy') ?? 0 };
    const content = node.content ?? (node.text.length > 0 ? [node.text] : []);
    for (const item of content) {
      if (typeof item === 'string') {
        const text = item.replace(/\s+/gu, ' ');
        if (text.length === 0) continue;
        runs.push({ text, style: s, ...pending });
        pending = { x: undefined, y: undefined, dx: 0, dy: 0 };
      } else if (item.name === 'tspan') {
        const childStyle = inherit(s, item.attrs);
        const before = runs.length;
        visit(item, childStyle, false);
        // Positionsangaben des tspan gelten für seinen ersten Lauf; übrig gebliebene des Elternteils davor.
        const firstRun = runs[before];
        if (firstRun !== undefined && (pending.x !== undefined || pending.y !== undefined || pending.dx !== 0 || pending.dy !== 0)) {
          runs[before] = { ...firstRun, x: firstRun.x ?? pending.x, y: firstRun.y ?? pending.y, dx: firstRun.dx + pending.dx, dy: firstRun.dy + pending.dy };
        }
        if (runs.length > before) pending = { x: undefined, y: undefined, dx: 0, dy: 0 };
      }
    }
  };
  visit(el, style, true);
  // Führender und abschließender Leerraum des ganzen Textes entfällt (xml:space="default").
  const first = runs[0];
  if (first !== undefined) runs[0] = { ...first, text: first.text.replace(/^ /u, '') };
  const lastIndex = runs.length - 1;
  const last = runs[lastIndex];
  if (last !== undefined) runs[lastIndex] = { ...last, text: last.text.replace(/ $/u, '') };
  return runs.filter((r) => r.text.length > 0);
}

function drawText(canvas: Canvas, el: SvgElement, style: SvgStyle, ctx: SvgDrawContext): void {
  const runs = textRuns(el, style);
  if (runs.length === 0) return;
  // Läufe zu Blöcken mit gemeinsamem Anker gruppieren (neuer Block bei absoluter Position).
  const placed: { run: TextRun; paragraph: ReturnType<TextEngine['label']>; width: number }[][] = [];
  for (const run of runs) {
    const color = svgColor(run.style.fill === 'currentColor' ? run.style.color : run.style.fill);
    if (color === undefined) continue;
    const size = svgLength(run.style.fontSize, 16);
    const family = run.style.fontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/gu, '');
    const weight = run.style.fontWeight === 'bold' ? 700 : Number(run.style.fontWeight) || 400;
    const alpha = Math.round(run.style.fillOpacity * Number.parseInt(color.slice(7, 9), 16));
    const paragraph = ctx.text.label(ctx.scope, run.text, { size, color: `${color.slice(0, 7)}${alpha.toString(16).padStart(2, '0')}`, weight, ...(family !== undefined && family.length > 0 ? { family } : {}) });
    const entry = { run, paragraph, width: paragraph.getMaxIntrinsicWidth() };
    const current = placed[placed.length - 1];
    if (current === undefined || run.x !== undefined || run.y !== undefined) placed.push([entry]);
    else current.push(entry);
  }
  let x = 0;
  let y = 0;
  for (const block of placed) {
    const head = block[0];
    if (head === undefined) continue;
    x = head.run.x ?? x;
    y = head.run.y ?? y;
    const total = block.reduce((sum, e, i) => sum + e.width + (i > 0 ? e.run.dx : 0), 0);
    const anchor = head.run.style.textAnchor;
    x -= anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0;
    for (const e of block) {
      x += e.run.dx;
      y += e.run.dy;
      canvas.drawParagraph(e.paragraph, x, y - e.paragraph.getAlphabeticBaseline());
      x += e.width;
    }
  }
}

/** Box eines Elements in seinem eigenen Koordinatensystem (für `objectBoundingBox`). */
function elementBounds(doc: SvgDocument, el: SvgElement, viewport: Viewport, ctx: SvgDrawContext, depth = 0): [number, number, number, number] | undefined {
  if (depth > 16) return undefined;
  switch (el.name) {
    case 'rect':
    case 'circle':
    case 'ellipse':
    case 'line':
    case 'polyline':
    case 'polygon':
    case 'path': {
      const path = shapePath(el, viewport, ctx);
      if (path === undefined) return undefined;
      const b = path.getBounds();
      return [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
    }
    case 'image':
      return [svgLength(el.attrs['x'], 0), svgLength(el.attrs['y'], 0), svgLength(el.attrs['x'], 0) + svgLength(el.attrs['width'], 0), svgLength(el.attrs['y'], 0) + svgLength(el.attrs['height'], 0)];
    case 'use': {
      const ref = hrefOf(el);
      const target = ref !== undefined ? doc.ids.get(ref) : undefined;
      const inner = target !== undefined ? elementBounds(doc, target, viewport, ctx, depth + 1) : undefined;
      if (inner === undefined || target === undefined) return undefined;
      const t = mulM([1, 0, 0, 1, svgLength(el.attrs['x'], 0), svgLength(el.attrs['y'], 0)], parseSvgTransform(target.attrs['transform']));
      return transformBounds(t, inner);
    }
    case 'g':
    case 'svg':
    case 'a': {
      let out: [number, number, number, number] | undefined;
      for (const c of el.children) {
        const b = elementBounds(doc, c, viewport, ctx, depth + 1);
        if (b === undefined) continue;
        const t = transformBounds(parseSvgTransform(c.attrs['transform']), b);
        out = out === undefined ? t : [Math.min(out[0], t[0]), Math.min(out[1], t[1]), Math.max(out[2], t[2]), Math.max(out[3], t[3])];
      }
      return out;
    }
    default:
      return undefined;
  }
}

function mulM(m: SvgMatrix, n: SvgMatrix): SvgMatrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function transformBounds(m: SvgMatrix, b: readonly [number, number, number, number]): [number, number, number, number] {
  const pts = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[0], b[3]],
    [b[2], b[3]],
  ].map(([x = 0, y = 0]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as const);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Matrix für `objectBoundingBox`-Einheiten: (0..1) → Box. */
function bboxMatrix(b: readonly [number, number, number, number]): SvgMatrix {
  return [b[2] - b[0], 0, 0, b[3] - b[1], b[0], b[1]];
}

function urlRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/u.exec(value.trim())?.[1];
}

/**
 * Pfad eines `clipPath` im Koordinatensystem des beschnittenen Elements: Vereinigung aller
 * Kind-Formen (mit ihren Transformationen und `clip-rule`), dazu `transform` des clipPath und bei
 * `clipPathUnits="objectBoundingBox"` die Box des Elements.
 */
function clipPathOf(doc: SvgDocument, clip: SvgElement, target: SvgElement, viewport: Viewport, ctx: SvgDrawContext, depth: number): Path | undefined {
  const { ck, scope } = ctx;
  let units: SvgMatrix = [1, 0, 0, 1, 0, 0];
  if (clip.attrs['clipPathUnits'] === 'objectBoundingBox') {
    const b = elementBounds(doc, target, viewport, ctx);
    if (b === undefined) return undefined;
    units = bboxMatrix(b);
  }
  const base = mulM(units, parseSvgTransform(clip.attrs['transform']));
  let result: Path | undefined;
  const collect = (el: SvgElement, m: SvgMatrix, rule: string, level: number): void => {
    if (level > 16) return;
    const local = mulM(m, parseSvgTransform(el.attrs['transform']));
    const clipRule = el.attrs['clip-rule'] ?? rule;
    if (el.name === 'use') {
      const ref = hrefOf(el);
      const t = ref !== undefined ? doc.ids.get(ref) : undefined;
      if (t !== undefined) collect(t, mulM(local, [1, 0, 0, 1, svgLength(el.attrs['x'], 0), svgLength(el.attrs['y'], 0)]), clipRule, level + 1);
      return;
    }
    if (el.name === 'g') {
      for (const c of el.children) collect(c, local, clipRule, level + 1);
      return;
    }
    const p = shapePath(el, viewport, ctx);
    if (p === undefined) return;
    const builder = new ck.PathBuilder(p);
    builder.transform(matrix3(local));
    builder.setFillType(clipRule === 'evenodd' ? ck.FillType.EvenOdd : ck.FillType.Winding);
    const copy = scope.add(builder.detachAndDelete());
    if (result === undefined) {
      result = copy;
      return;
    }
    const joined = nullable(ck.Path.MakeFromOp(result, copy, ck.PathOp.Union));
    if (joined !== null) result = scope.add(joined);
  };
  for (const c of clip.children) collect(c, base, 'nonzero', depth);
  return result ?? scope.add(new ck.Path());
}

/**
 * Zeichnet ein `<image>`: Box `x, y, width, height`, `preserveAspectRatio` (Standard `xMidYMid meet`),
 * `image-rendering: pixelated` (auch `optimizeSpeed`, `crisp-edges`) tastet ohne Glättung ab.
 */
function drawImage(canvas: Canvas, doc: SvgDocument, el: SvgElement, ctx: SvgDrawContext): void {
  const { ck, scope } = ctx;
  const href = el.attrs['href'] ?? el.attrs['xlink:href'];
  const image = href !== undefined ? svgImagesOf(doc).get(href) : undefined;
  if (image === undefined) return;
  const iw = image.width();
  const ih = image.height();
  const x = svgLength(el.attrs['x'], 0);
  const y = svgLength(el.attrs['y'], 0);
  const w = el.attrs['width'] !== undefined ? svgLength(el.attrs['width'], iw) : iw;
  const h = el.attrs['height'] !== undefined ? svgLength(el.attrs['height'], ih) : ih;
  if (!(w > 0 && h > 0 && iw > 0 && ih > 0)) return;
  const par = (el.attrs['preserveAspectRatio'] ?? 'xMidYMid meet').trim().split(/\s+/u);
  const align = par[0] ?? 'xMidYMid';
  let dw = w;
  let dh = h;
  if (align !== 'none') {
    const s = par[1] === 'slice' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    dw = iw * s;
    dh = ih * s;
  }
  const ax = align.includes('xMin') ? 0 : align.includes('xMax') ? 1 : 0.5;
  const ay = align.includes('YMin') ? 0 : align.includes('YMax') ? 1 : 0.5;
  const dx = x + (w - dw) * (align === 'none' ? 0 : ax);
  const dy = y + (h - dh) * (align === 'none' ? 0 : ay);
  canvas.save();
  canvas.clipRect(ck.XYWHRect(x, y, w, h), ck.ClipOp.Intersect, true);
  const paint = scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  const rendering = el.attrs['image-rendering'];
  const nearest = rendering === 'pixelated' || rendering === 'optimizeSpeed' || rendering === 'crisp-edges';
  canvas.drawImageRectOptions(image, ck.XYWHRect(0, 0, iw, ih), ck.XYWHRect(dx, dy, dw, dh), nearest ? ck.FilterMode.Nearest : ck.FilterMode.Linear, ck.MipmapMode.None, paint);
  canvas.restore();
}

/**
 * Shader eines `<pattern>`: Die Kachel (`x, y, width, height`, Standard in `objectBoundingBox`)
 * wird als Bild aufgezeichnet und wiederholt; `viewBox`, `patternContentUnits` und
 * `patternTransform` wirken wie in SVG.
 */
function patternShader(doc: SvgDocument, el: SvgElement, bounds: Float32Array, style: SvgStyle, viewport: Viewport, ctx: SvgDrawContext): Shader | undefined {
  const { ck, scope } = ctx;
  const bx = bounds[0] ?? 0;
  const by = bounds[1] ?? 0;
  const bw = (bounds[2] ?? 0) - bx;
  const bh = (bounds[3] ?? 0) - by;
  const userUnits = el.attrs['patternUnits'] === 'userSpaceOnUse';
  const len = (name: string, ref: number, bboxRef: number, bboxOrigin: number): number => {
    const raw = el.attrs[name];
    if (userUnits) return svgLength(raw, 0, ref);
    // objectBoundingBox: Zahlen sind Anteile der Box.
    const n = raw === undefined ? 0 : raw.trim().endsWith('%') ? Number(raw.trim().slice(0, -1)) / 100 : Number(raw);
    return bboxOrigin + (Number.isFinite(n) ? n : 0) * bboxRef;
  };
  const tx = len('x', viewport.width, bw, userUnits ? 0 : bx);
  const ty = len('y', viewport.height, bh, userUnits ? 0 : by);
  const tw = len('width', viewport.width, bw, 0);
  const th = len('height', viewport.height, bh, 0);
  if (!(tw > 0 && th > 0)) return undefined;
  const recorder = scope.add(new ck.PictureRecorder());
  const tile = recorder.beginRecording(ck.XYWHRect(0, 0, tw, th));
  const vb = svgNumbers(el.attrs['viewBox']);
  if (vb.length === 4 && (vb[2] ?? 0) > 0 && (vb[3] ?? 0) > 0) {
    const s = Math.min(tw / (vb[2] ?? 1), th / (vb[3] ?? 1));
    tile.translate((tw - (vb[2] ?? 0) * s) / 2, (th - (vb[3] ?? 0) * s) / 2);
    tile.scale(s, s);
    tile.translate(-(vb[0] ?? 0), -(vb[1] ?? 0));
  } else if (el.attrs['patternContentUnits'] === 'objectBoundingBox') {
    tile.scale(bw, bh);
  }
  for (const child of el.children) drawElement(tile, doc, child, inherit(ROOT_STYLE, { color: style.color }), viewport, ctx, 1);
  const picture = scope.add(recorder.finishRecordingAsPicture());
  const local = mulM(parseSvgTransform(el.attrs['patternTransform']), [1, 0, 0, 1, tx, ty]);
  return scope.add(picture.makeShader(ck.TileMode.Repeat, ck.TileMode.Repeat, ck.FilterMode.Linear, matrix3(local), ck.XYWHRect(0, 0, tw, th)));
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
  const clipRef = urlRef(el.attrs['clip-path']);
  const clipEl = clipRef !== undefined ? doc.ids.get(clipRef) : undefined;
  if (clipEl?.name === 'clipPath') {
    const clip = clipPathOf(doc, clipEl, el, viewport, ctx, depth);
    if (clip !== undefined) canvas.clipPath(clip, ck.ClipOp.Intersect, true);
  }
  if (opacity < 1) {
    const p = scope.add(new ck.Paint());
    p.setAlphaf(opacity);
    canvas.saveLayer(p);
  }
  const maskRef = urlRef(el.attrs['mask']);
  const maskCandidate = maskRef !== undefined ? doc.ids.get(maskRef) : undefined;
  const maskEl = maskCandidate?.name === 'mask' ? maskCandidate : undefined;
  if (maskEl !== undefined) canvas.saveLayer(scope.add(new ck.Paint()));
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
    case 'image':
      drawImage(canvas, doc, el, ctx);
      break;
    default:
      // defs, Verläufe, Muster, Clip-Pfade, Masken, Stopps und nicht unterstützte Elemente zeichnen hier nichts.
      break;
  }
  if (maskEl !== undefined) {
    drawMask(canvas, doc, maskEl, el, style, viewport, ctx, depth);
    canvas.restore();
  }
  if (opacity < 1) canvas.restore();
  canvas.restore();
}

/**
 * Wendet eine `<mask>` auf den gerade gezeichneten Inhalt an (Luminanz × Alpha, wie SVG
 * `mask-type: luminance`; `mask-type: alpha` nutzt nur Alpha). Der Maskenbereich
 * (`x, y, width, height`, Standard −10 % … 120 % der Box) begrenzt die Maske.
 */
function drawMask(canvas: Canvas, doc: SvgDocument, mask: SvgElement, target: SvgElement, style: SvgStyle, viewport: Viewport, ctx: SvgDrawContext, depth: number): void {
  const { ck, scope } = ctx;
  const bounds = elementBounds(doc, target, viewport, ctx);
  const alphaOnly = mask.attrs['mask-type'] === 'alpha' || mask.attrs['style']?.includes('mask-type:alpha') === true;
  const paint = scope.add(new ck.Paint());
  paint.setBlendMode(ck.BlendMode.DstIn);
  paint.setColorFilter(maskColorFilter(ck, scope, alphaOnly ? 'alpha' : 'luminance', false));
  canvas.saveLayer(paint);
  const userUnits = mask.attrs['maskUnits'] === 'userSpaceOnUse';
  if (userUnits || bounds !== undefined) {
    const b = bounds ?? [0, 0, viewport.width, viewport.height];
    const frac = (name: string, fallback: number, origin: number, size: number, ref: number): number => {
      const raw = mask.attrs[name];
      if (userUnits) return svgLength(raw, origin + fallback * size, ref);
      const n = raw === undefined ? fallback : raw.trim().endsWith('%') ? Number(raw.trim().slice(0, -1)) / 100 : Number(raw);
      return origin + (Number.isFinite(n) ? n : fallback) * size;
    };
    const bw = b[2] - b[0];
    const bh = b[3] - b[1];
    const x = frac('x', -0.1, b[0], bw, viewport.width);
    const y = frac('y', -0.1, b[1], bh, viewport.height);
    const w = userUnits ? svgLength(mask.attrs['width'], 1.2 * bw, viewport.width) : frac('width', 1.2, 0, bw, 0);
    const h = userUnits ? svgLength(mask.attrs['height'], 1.2 * bh, viewport.height) : frac('height', 1.2, 0, bh, 0);
    canvas.clipRect(ck.XYWHRect(x, y, w, h), ck.ClipOp.Intersect, true);
  }
  // Luminanz: Maskeninhalt auf deckendem Schwarz ergibt Helligkeit × Alpha.
  if (!alphaOnly) canvas.drawColor(ck.BLACK, ck.BlendMode.Src);
  if (mask.attrs['maskContentUnits'] === 'objectBoundingBox' && bounds !== undefined) canvas.concat(matrix3(bboxMatrix(bounds)));
  for (const child of mask.children) drawElement(canvas, doc, child, inherit(ROOT_STYLE, { color: style.color }), viewport, ctx, depth + 1);
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
