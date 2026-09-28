/**
 * SVG-Import (FR-85): wandelt SVG-Markup in IR-Nodes um.
 *
 * Jede Eigenschaft, die die IR nicht abbilden kann, erzeugt eine Diagnose
 * `OV_IMPORT_LOSSY`. Nichts wird still verworfen.
 */
import { BLEND_MODES, IDENTITY, multiply, pathBounds, type Diagnostic, type Gradient, type Matrix2D } from '@agentic-video/core';
import { IdAllocator, importError, isExternalUrl, lossy, makeAsset, mimeInfo, parseDataUri, round, type ImportedAsset, type JsonNode, type NodeImportResult } from './common.js';
import { irColor, matchRules, parseCssColor, parseDeclarations, parseStylesheet, type CssRule } from './css.js';
import { absolutePath, decompose, ellipsePath, formatPath, parseTransform, pointsPath, rectPath, transformPath, type AbsCommand } from './geometry.js';
import { childElements, parseXml, textContent, type XmlElement } from './xml.js';

/** Optionen für {@link importSvg}. */
export interface SvgImportOptions {
  /** Präfix aller erzeugten IDs (Standard `svg`). Die Wurzel-Node erhält genau diese ID. */
  readonly idPrefix?: string;
}

type Style = Readonly<Record<string, string>>;

const INHERITED = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'visibility',
  'color',
  'clip-rule',
  'letter-spacing',
  'text-decoration',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

const PRESENTATION = new Set([
  ...INHERITED,
  'opacity',
  'clip-path',
  'mask',
  'filter',
  'display',
  'stop-color',
  'stop-opacity',
  'mix-blend-mode',
  'vector-effect',
  'paint-order',
  'overflow',
]);

/** Elemente, die nie direkt gezeichnet werden und keine Information tragen, die verloren gehen könnte. */
const SILENT = new Set(['title', 'desc', 'metadata', 'style', 'defs', 'linearGradient', 'radialGradient', 'clipPath', 'symbol', 'stop']);
/** Elemente, die nur als Verweisziel dienen; ihre Nutzung meldet eine Diagnose. */
const REFERENCED_ONLY = new Set(['filter', 'pattern', 'marker', 'mask']);

interface Ctx {
  readonly ids: IdAllocator;
  readonly diagnostics: Diagnostic[];
  readonly assets: ImportedAsset[];
  readonly byId: ReadonlyMap<string, XmlElement>;
  readonly rules: readonly CssRule[];
  readonly viewport: { readonly w: number; readonly h: number };
  readonly useStack: Set<XmlElement>;
  /** Innerhalb von `clipPath`: nur Geometrie zählt, Farbe wird deckend schwarz. */
  readonly clip: boolean;
}

function warn(ctx: Ctx, path: string, problem: string, suggestion: string): void {
  ctx.diagnostics.push(lossy(path, problem, suggestion));
}

// ---------------------------------------------------------------------------
// Längen, Zahlen, Stil
// ---------------------------------------------------------------------------

const UNIT: Readonly<Record<string, number>> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };

/** Parst eine SVG-Länge in Pixel. `%` bezieht sich auf die Viewport-Achse. */
function length(value: string | undefined, axis: 'x' | 'y' | 'xy', ctx: Ctx, fontSize = 16): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*([+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/u.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? '';
  if (unit === '%') {
    const base = axis === 'x' ? ctx.viewport.w : axis === 'y' ? ctx.viewport.h : Math.sqrt((ctx.viewport.w ** 2 + ctx.viewport.h ** 2) / 2);
    return (n / 100) * base;
  }
  if (unit === 'em') return n * fontSize;
  if (unit === 'ex') return n * fontSize * 0.5;
  return n * (UNIT[unit] ?? 1);
}

/** Zahl oder Prozent als Anteil (für `objectBoundingBox`). */
function fraction(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const t = value.trim();
  const n = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
  return Number.isFinite(n) ? n : fallback;
}

function numberList(value: string | undefined): number[] {
  if (value === undefined) return [];
  return value
    .trim()
    .split(/[\s,]+/u)
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function attr(el: XmlElement, name: string): string | undefined {
  return el.attrs[name];
}

function href(el: XmlElement): string | undefined {
  return el.attrs['href'] ?? el.attrs['xlink:href'];
}

/** Berechnet den Stil eines Elements: geerbt < Präsentationsattribut < CSS-Regel < `style`. */
function computeStyle(el: XmlElement, parent: Style, ctx: Ctx): Style {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (INHERITED.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(el.attrs)) if (PRESENTATION.has(k)) out[k] = v.trim();
  const classes = (attr(el, 'class') ?? '').split(/\s+/u).filter((c) => c.length > 0);
  Object.assign(out, matchRules(ctx.rules, el.name, attr(el, 'id'), classes));
  Object.assign(out, parseDeclarations(attr(el, 'style') ?? ''));
  for (const [k, v] of Object.entries(out)) if (v === 'inherit') {
    const inherited = parent[k];
    if (inherited !== undefined) out[k] = inherited;
    else Reflect.deleteProperty(out, k);
  }
  return out;
}

function opacityOf(value: string | undefined): number {
  if (value === undefined) return 1;
  const n = value.trim().endsWith('%') ? Number(value.trim().slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 1;
}

function elementPath(parent: string, el: XmlElement): string {
  const id = attr(el, 'id');
  return `${parent.length > 0 ? `${parent} > ` : ''}${el.name}${id !== undefined ? `#${id}` : ''}`;
}

// ---------------------------------------------------------------------------
// Farben und Verläufe
// ---------------------------------------------------------------------------

interface PaintBox {
  /** Verschiebung der lokalen Node-Koordinaten gegenüber dem Nutzerraum des Elements. */
  readonly offset: { readonly x: number; readonly y: number };
  /** Größe der Box, falls bekannt (für Hinweise zu radialen Verläufen). */
  readonly size?: { readonly w: number; readonly h: number };
}

/** Farbe (`none` = keine Farbe) oder Verlauf. */
type Paint = string | Gradient;

function gradientAttr(el: XmlElement, name: string, ctx: Ctx, seen: Set<XmlElement> = new Set()): string | undefined {
  const own = attr(el, name);
  if (own !== undefined || seen.has(el)) return own;
  seen.add(el);
  const ref = href(el);
  const target = ref?.startsWith('#') === true ? ctx.byId.get(ref.slice(1)) : undefined;
  return target !== undefined ? gradientAttr(target, name, ctx, seen) : undefined;
}

function gradientStops(el: XmlElement, ctx: Ctx, seen: Set<XmlElement> = new Set()): XmlElement[] {
  const own = childElements(el).filter((c) => c.name === 'stop');
  if (own.length > 0 || seen.has(el)) return own;
  seen.add(el);
  const ref = href(el);
  const target = ref?.startsWith('#') === true ? ctx.byId.get(ref.slice(1)) : undefined;
  return target !== undefined ? gradientStops(target, ctx, seen) : [];
}

function buildGradient(el: XmlElement, opacity: number, box: PaintBox, ctx: Ctx, path: string): Paint {
  const gPath = elementPath(path, el);
  let last = 0;
  const stops = gradientStops(el, ctx).map((stop) => {
    const style = computeStyle(stop, {}, ctx);
    const offset = Math.max(last, Math.min(Math.max(fraction(attr(stop, 'offset'), 0), 0), 1));
    last = offset;
    const color = parseCssColor(style['stop-color'] ?? 'black');
    if (color === undefined) warn(ctx, gPath, `Unknown stop color "${style['stop-color'] ?? ''}"; black is used.`, 'Use a hex, rgb() or named color.');
    return { offset: round(offset), color: irColor(color ?? { r: 0, g: 0, b: 0, a: 1 }, opacityOf(style['stop-opacity']) * opacity) };
  });
  const [first] = stops;
  if (first === undefined) return 'none';
  if (stops.length === 1) return first.color;
  if (gradientAttr(el, 'gradientTransform', ctx) !== undefined) {
    warn(ctx, gPath, 'gradientTransform is not supported; the gradient is drawn without it.', 'Bake the transform into the gradient coordinates.');
  }
  const spread = gradientAttr(el, 'spreadMethod', ctx);
  if (spread !== undefined && spread !== 'pad') warn(ctx, gPath, `spreadMethod "${spread}" is not supported; "pad" is used.`, 'Add explicit repeated stops instead.');
  const userSpace = gradientAttr(el, 'gradientUnits', ctx) === 'userSpaceOnUse';
  const coord = (name: string, fallback: string, axis: 'x' | 'y' | 'xy'): number => {
    const raw = gradientAttr(el, name, ctx) ?? fallback;
    if (!userSpace) return fraction(raw, fraction(fallback, 0));
    const px = length(raw, axis, ctx) ?? 0;
    return axis === 'x' ? px - box.offset.x : axis === 'y' ? px - box.offset.y : px;
  };
  const units = userSpace ? ('pixels' as const) : ('relative' as const);
  if (el.name === 'linearGradient') {
    return {
      type: 'linear',
      stops,
      start: { x: round(coord('x1', '0%', 'x')), y: round(coord('y1', '0%', 'y')) },
      end: { x: round(coord('x2', '100%', 'x')), y: round(coord('y2', '0%', 'y')) },
      units,
    };
  }
  const cx = coord('cx', '50%', 'x');
  const cy = coord('cy', '50%', 'y');
  const fx = gradientAttr(el, 'fx', ctx);
  const fy = gradientAttr(el, 'fy', ctx);
  if ((fx !== undefined && round(coord('fx', '50%', 'x')) !== round(cx)) || (fy !== undefined && round(coord('fy', '50%', 'y')) !== round(cy))) {
    warn(ctx, gPath, 'Radial gradient focal point (fx, fy) is not supported; the center is used.', 'Move the focal point to the center or bake the gradient into an image.');
  }
  if (!userSpace && box.size !== undefined && Math.abs(box.size.w - box.size.h) > 1e-6) {
    warn(ctx, gPath, 'A bounding-box radial gradient on a non-square shape is elliptical in SVG; the IR draws a circle relative to the larger side.', 'Use gradientUnits="userSpaceOnUse" or a square shape.');
  }
  return { type: 'radial', stops, center: { x: round(cx), y: round(cy) }, radius: round(Math.max(0, coord('r', '50%', 'xy'))), units };
}

function resolvePaint(value: string | undefined, opacity: number, style: Style, box: PaintBox, ctx: Ctx, path: string): Paint {
  if (value === undefined || value === 'none') return 'none';
  const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)\s*(.*)$/u.exec(value);
  if (url !== null) {
    const target = ctx.byId.get(url[1] ?? '');
    const fallback = (url[2] ?? '').trim();
    if (target !== undefined && (target.name === 'linearGradient' || target.name === 'radialGradient')) return buildGradient(target, opacity, box, ctx, path);
    warn(
      ctx,
      path,
      target === undefined ? `Paint server "#${url[1] ?? ''}" does not exist.` : `Paint server <${target.name}> is not supported.`,
      target?.name === 'pattern' ? 'Replace the pattern with an image asset or a gradient.' : 'Use a solid color or a linear/radial gradient.',
    );
    return fallback.length > 0 ? resolvePaint(fallback, opacity, style, box, ctx, path) : 'none';
  }
  const color = parseCssColor(value === 'currentColor' ? (style['color'] ?? 'black') : value);
  if (color === undefined) {
    warn(ctx, path, `Unknown color "${value}"; black is used.`, 'Use a hex, rgb(), hsl() or named color.');
    return irColor({ r: 0, g: 0, b: 0, a: 1 }, opacity);
  }
  return irColor(color, opacity);
}

/** Setzt `fill`, `stroke` und Kontur-Felder einer Form-Node. */
function applyPaint(node: JsonNode, style: Style, box: PaintBox, ctx: Ctx, path: string, kind: 'area' | 'line' | 'text'): void {
  if (ctx.clip) {
    if (kind === 'line') node['stroke'] = '#000000';
    else node['fill'] = '#000000';
    if (style['clip-rule'] === 'evenodd' && node['type'] === 'path') node['fillRule'] = 'evenodd';
    return;
  }
  const fill = kind === 'line' ? 'none' : resolvePaint(style['fill'] ?? 'black', opacityOf(style['fill-opacity']), style, box, ctx, path);
  const stroke = resolvePaint(style['stroke'], opacityOf(style['stroke-opacity']), style, box, ctx, path);
  if (kind !== 'line') node['fill'] = fill === 'none' ? 'transparent' : fill;
  if (stroke !== 'none') {
    node['stroke'] = stroke;
    const width = length(style['stroke-width'] ?? '1', 'xy', ctx);
    if (width === undefined) warn(ctx, path, `Invalid stroke-width "${style['stroke-width'] ?? ''}"; 1 is used.`, 'Use a number of pixels.');
    else if (width !== 1) node['strokeWidth'] = round(width);
    if (kind === 'text') {
      if (['stroke-linecap', 'stroke-linejoin', 'stroke-dasharray'].some((k) => style[k] !== undefined && style[k] !== 'none' && style[k] !== 'butt' && style[k] !== 'miter')) {
        warn(ctx, path, 'Stroke caps, joins and dashes on text are not supported.', 'Convert the text to paths if the stroke style matters.');
      }
      return;
    }
    const cap = style['stroke-linecap'];
    if (cap === 'round' || cap === 'square') node['strokeCap'] = cap;
    const join = style['stroke-linejoin'];
    if (join === 'round' || join === 'bevel') node['strokeJoin'] = join;
    else if (join !== undefined && join !== 'miter') warn(ctx, path, `stroke-linejoin "${join}" is not supported; "miter" is used.`, 'Use miter, round or bevel.');
    const dash = style['stroke-dasharray'];
    if (dash !== undefined && dash !== 'none') {
      const list = numberList(dash).map(Math.abs);
      if (list.length > 0 && list.some((n) => n > 0)) node['strokeDash'] = list.length % 2 === 1 ? [...list, ...list] : list;
    }
    const dashOffset = length(style['stroke-dashoffset'], 'xy', ctx);
    if (dashOffset !== undefined && dashOffset !== 0) warn(ctx, path, 'stroke-dashoffset is not supported; the dash pattern starts at 0.', 'Shift the dash pattern manually or animate trimOffset.');
    const miter = style['stroke-miterlimit'];
    if (miter !== undefined && Number(miter) !== 4) warn(ctx, path, `stroke-miterlimit ${miter} is not supported; renderers use 4.`, 'Use strokeJoin "bevel" or "round" if the miter matters.');
  } else if (kind === 'line') {
    node['stroke'] = 'transparent';
  }
  if (kind === 'area' && style['fill-rule'] === 'evenodd' && node['type'] === 'path') node['fillRule'] = 'evenodd';
  if (kind === 'area' && style['fill-rule'] === 'evenodd' && node['type'] !== 'path') {
    warn(ctx, path, 'fill-rule "evenodd" only applies to paths in the IR.', 'Convert the shape to a <path>.');
  }
}

// ---------------------------------------------------------------------------
// Gemeinsame Node-Felder: Transform, Deckkraft, Maske, nicht unterstützte Stile
// ---------------------------------------------------------------------------

function reportUnsupportedStyle(style: Style, ctx: Ctx, path: string): void {
  const filter = style['filter'];
  if (filter !== undefined && filter !== 'none') warn(ctx, path, 'SVG filters are not supported; the element is drawn without the filter.', 'Rebuild the effect with the node `filters` or `shadow` property.');
  const mask = style['mask'];
  if (mask !== undefined && mask !== 'none') warn(ctx, path, 'SVG <mask> (luminance mask) is not supported; the element is drawn unmasked.', 'Use a clipPath or set `mask` on the imported node manually.');
  for (const key of ['marker-start', 'marker-mid', 'marker-end']) {
    const v = style[key];
    if (v !== undefined && v !== 'none') warn(ctx, path, `${key} is not supported; markers are not drawn.`, 'Draw the markers as separate shapes.');
  }
  const effect = style['vector-effect'];
  if (effect !== undefined && effect !== 'none') warn(ctx, path, `vector-effect "${effect}" is not supported.`, 'Scale the stroke width manually.');
  const order = style['paint-order'];
  if (order !== undefined && order !== 'normal' && !order.startsWith('fill')) warn(ctx, path, `paint-order "${order}" is not supported; fill is drawn below stroke.`, 'Split fill and stroke into two nodes.');
}

interface Placement {
  /** Transform des Elements (inklusive Vorfahren-Anteil, der nicht als Gruppe abgebildet wird). */
  readonly matrix: Matrix2D;
  /** Punkt der lokalen Box, um den die IR dreht (`origin: {0, 0}`). */
  readonly pivot: { readonly x: number; readonly y: number };
}

/** Schreibt x, y, rotation, scale, skew und origin. Liefert `false`, wenn die Matrix nicht zerlegbar ist. */
function applyPlacement(node: JsonNode, placement: Placement): boolean {
  const d = decompose(placement.matrix, placement.pivot);
  if (d === undefined) return false;
  if (round(d.x) !== 0) node['x'] = round(d.x);
  if (round(d.y) !== 0) node['y'] = round(d.y);
  const rotation = round(d.rotation);
  const scale = { x: round(d.scale.x), y: round(d.scale.y) };
  const skew = round(d.skew.x);
  if (rotation !== 0) node['rotation'] = rotation;
  if (scale.x !== 1 || scale.y !== 1) node['scale'] = scale;
  if (skew !== 0) node['skew'] = { x: skew, y: 0 };
  if (rotation !== 0 || scale.x !== 1 || scale.y !== 1 || skew !== 0) node['origin'] = { x: 0, y: 0 };
  return true;
}

function elementMatrix(el: XmlElement, ctx: Ctx, path: string): Matrix2D {
  const raw = attr(el, 'transform');
  if (raw === undefined) return IDENTITY;
  const m = parseTransform(raw);
  if (m === undefined) {
    warn(ctx, path, `Invalid transform "${raw}"; the element is drawn untransformed.`, 'Use matrix(), translate(), scale(), rotate(), skewX() or skewY().');
    return IDENTITY;
  }
  return m;
}

/** Deckkraft, Blend Mode, Sichtbarkeit und Clip-Maske. */
function applyCommon(node: JsonNode, style: Style, ctx: Ctx, path: string, offset: { x: number; y: number }, leaf: boolean): void {
  if (ctx.clip) return;
  const opacity = opacityOf(style['opacity']);
  if (opacity < 1) node['opacity'] = round(opacity);
  const blend = style['mix-blend-mode'];
  if (blend !== undefined && blend !== 'normal') {
    const mode = BLEND_MODES.find((b) => b === blend);
    if (mode !== undefined) node['blendMode'] = mode;
    else warn(ctx, path, `mix-blend-mode "${blend}" is not supported; "normal" is used.`, `Use one of: ${BLEND_MODES.join(', ')}.`);
  }
  if (leaf && style['visibility'] === 'hidden') node['visible'] = false;
  reportUnsupportedStyle(style, ctx, path);
  const clip = style['clip-path'];
  if (clip === undefined || clip === 'none') return;
  const ref = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/u.exec(clip);
  const target = ref !== null ? ctx.byId.get(ref[1] ?? '') : undefined;
  if (target?.name !== 'clipPath') {
    warn(ctx, path, `clip-path "${clip}" is not supported; the element is drawn unclipped.`, 'Reference a <clipPath> element with url(#id).');
    return;
  }
  if (attr(target, 'clipPathUnits') === 'objectBoundingBox') {
    warn(ctx, path, 'clipPathUnits="objectBoundingBox" is not supported; the element is drawn unclipped.', 'Use clipPathUnits="userSpaceOnUse".');
    return;
  }
  const maskNode = convertClipPath(target, ctx, path, offset);
  if (maskNode !== undefined) node['mask'] = { node: maskNode, mode: 'alpha' };
}

function convertClipPath(clipEl: XmlElement, parentCtx: Ctx, path: string, offset: { x: number; y: number }): JsonNode | undefined {
  const ctx: Ctx = { ...parentCtx, clip: true };
  const clipPath = elementPath(path, clipEl);
  if (attr(clipEl, 'clip-path') !== undefined) warn(ctx, clipPath, 'Nested clip-path on a <clipPath> is not supported.', 'Intersect the clip shapes manually.');
  const style = computeStyle(clipEl, {}, ctx);
  const children = childElements(clipEl).flatMap((c) => convertElement(c, style, ctx, clipPath, IDENTITY));
  if (children.length === 0) return undefined;
  const group: JsonNode = { id: ctx.ids.next('clip'), type: 'group', children };
  const matrix = multiply([1, 0, 0, 1, -offset.x, -offset.y], elementMatrix(clipEl, ctx, clipPath));
  applyPlacement(group, { matrix, pivot: { x: 0, y: 0 } });
  const [only] = children;
  return children.length === 1 && only !== undefined && Object.keys(group).length === 3 ? only : group;
}

// ---------------------------------------------------------------------------
// Elemente
// ---------------------------------------------------------------------------

interface ShapeSpec {
  readonly node: JsonNode;
  /** Geometrie in Nutzerraum-Koordinaten (für die Pfad-Transformation). */
  readonly outline: AbsCommand[];
  /** Verschiebung der lokalen Box im Nutzerraum. */
  readonly offset: { readonly x: number; readonly y: number };
  readonly pivot: { readonly x: number; readonly y: number };
  readonly kind: 'area' | 'line';
  readonly size?: { readonly w: number; readonly h: number };
}

function shapeSpec(el: XmlElement, ctx: Ctx, path: string): ShapeSpec | undefined {
  const num = (name: string, axis: 'x' | 'y' | 'xy', fallback = 0) => length(attr(el, name), axis, ctx) ?? fallback;
  switch (el.name) {
    case 'rect': {
      const x = num('x', 'x');
      const y = num('y', 'y');
      const w = num('width', 'x');
      const h = num('height', 'y');
      if (w <= 0 || h <= 0) return undefined;
      const rxRaw = length(attr(el, 'rx'), 'x', ctx);
      const ryRaw = length(attr(el, 'ry'), 'y', ctx);
      const rx = Math.min(rxRaw ?? ryRaw ?? 0, w / 2);
      const ry = Math.min(ryRaw ?? rxRaw ?? 0, h / 2);
      const node: JsonNode = { type: 'rect', width: round(w), height: round(h) };
      if (rx > 0 || ry > 0) {
        node['cornerRadius'] = round(Math.min(rx, ry));
        if (round(rx) !== round(ry)) warn(ctx, path, `Elliptical corners (rx=${String(round(rx))}, ry=${String(round(ry))}) are not supported; the smaller radius is used.`, 'Convert the rectangle to a <path> with arcs.');
      }
      return { node, outline: rectPath(x, y, w, h), offset: { x, y }, pivot: { x: 0, y: 0 }, kind: 'area', size: { w, h } };
    }
    case 'circle':
    case 'ellipse': {
      const cx = num('cx', 'x');
      const cy = num('cy', 'y');
      const rx = el.name === 'circle' ? num('r', 'xy') : num('rx', 'x', length(attr(el, 'ry'), 'y', ctx) ?? 0);
      const ry = el.name === 'circle' ? rx : num('ry', 'y', length(attr(el, 'rx'), 'x', ctx) ?? 0);
      if (rx <= 0 || ry <= 0) return undefined;
      return {
        node: { type: 'ellipse', width: round(2 * rx), height: round(2 * ry) },
        outline: ellipsePath(cx, cy, rx, ry),
        offset: { x: cx - rx, y: cy - ry },
        pivot: { x: 0, y: 0 },
        kind: 'area',
        size: { w: 2 * rx, h: 2 * ry },
      };
    }
    case 'line': {
      const x1 = num('x1', 'x');
      const y1 = num('y1', 'y');
      const x2 = num('x2', 'x');
      const y2 = num('y2', 'y');
      return {
        node: { type: 'line', from: { x: round(x1), y: round(y1) }, to: { x: round(x2), y: round(y2) } },
        outline: pointsPath([[x1, y1], [x2, y2]], false),
        offset: { x: 0, y: 0 },
        pivot: { x: Math.min(x1, x2), y: Math.min(y1, y2) },
        kind: 'line',
        size: { w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
      };
    }
    case 'polyline':
    case 'polygon': {
      const flat = numberList(attr(el, 'points'));
      const points: [number, number][] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) points.push([round(flat[i] ?? 0), round(flat[i + 1] ?? 0)]);
      if (flat.length % 2 === 1) warn(ctx, path, 'The points list has an odd number of coordinates; the last one is ignored.', 'Give x and y for every point.');
      if (points.length < (el.name === 'polygon' ? 3 : 2)) return undefined;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      return {
        node: { type: el.name, points },
        outline: pointsPath(points, el.name === 'polygon'),
        offset: { x: 0, y: 0 },
        pivot: { x: Math.min(...xs), y: Math.min(...ys) },
        kind: 'area',
        size: { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
      };
    }
    case 'path': {
      const d = (attr(el, 'd') ?? '').trim();
      if (d.length === 0 || d.toLowerCase() === 'none') return undefined;
      const b = pathBounds(d);
      return { node: { type: 'path', d }, outline: absolutePath(d), offset: { x: 0, y: 0 }, pivot: { x: b.x, y: b.y }, kind: 'area', size: { w: b.width, h: b.height } };
    }
    default:
      return undefined;
  }
}

function convertShape(el: XmlElement, style: Style, ctx: Ctx, path: string, inherited: Matrix2D): JsonNode[] {
  const spec = shapeSpec(el, ctx, path);
  if (spec === undefined) return [];
  const node: JsonNode = { id: ctx.ids.claim(attr(el, 'id'), el.name), ...spec.node };
  const matrix = multiply(multiply(inherited, elementMatrix(el, ctx, path)), [1, 0, 0, 1, spec.offset.x, spec.offset.y]);
  if (applyPlacement(node, { matrix, pivot: spec.pivot })) {
    applyPaint(node, style, { offset: spec.offset, ...(spec.size !== undefined ? { size: spec.size } : {}) }, ctx, path, spec.kind);
    applyCommon(node, style, ctx, path, spec.offset, true);
    return [node];
  }
  // Nicht zerlegbare Matrix: Geometrie direkt in einen Pfad umrechnen.
  warn(ctx, path, 'The transform matrix cannot be decomposed into translate, rotate, scale and skew; the geometry was baked into a path and the stroke width is not transformed.', 'Use an invertible transform or simplify it.');
  const d = formatPath(transformPath(spec.outline, multiply(inherited, elementMatrix(el, ctx, path))));
  const baked: JsonNode = { id: node['id'], type: 'path', d };
  applyPaint(baked, style, { offset: { x: 0, y: 0 } }, ctx, path, spec.kind);
  applyCommon(baked, style, ctx, path, { x: 0, y: 0 }, true);
  return [baked];
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace']);

function convertText(el: XmlElement, style: Style, ctx: Ctx, path: string, inherited: Matrix2D): JsonNode[] {
  const text = textContent(el).replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return [];
  for (const span of childElements(el)) {
    if (span.name !== 'tspan') {
      if (span.name !== 'title' && span.name !== 'desc') warn(ctx, elementPath(path, span), `<${span.name}> inside <text> is not supported; only its text is kept.`, 'Use plain text or <tspan>.');
      continue;
    }
    const spanStyle = computeStyle(span, style, ctx);
    const differs = ['fill', 'stroke', 'font-size', 'font-family', 'font-weight', 'font-style'].some((k) => spanStyle[k] !== style[k]);
    const positioned = ['x', 'y', 'dx', 'dy', 'rotate'].some((k) => attr(span, k) !== undefined);
    if (differs || positioned) {
      warn(ctx, elementPath(path, span), '<tspan> with its own position or style was merged into the parent text.', 'Split the text into several <text> elements or build a rich-text node.');
    }
  }
  const fontSize = length(style['font-size'] ?? '16', 'xy', ctx) ?? 16;
  const x = numberList(attr(el, 'x'))[0] ?? 0;
  const y = numberList(attr(el, 'y'))[0] ?? 0;
  if (numberList(attr(el, 'x')).length > 1 || numberList(attr(el, 'y')).length > 1 || attr(el, 'dx') !== undefined || attr(el, 'dy') !== undefined || attr(el, 'rotate') !== undefined) {
    warn(ctx, path, 'Per-glyph positions (x/y lists, dx, dy, rotate) are not supported; only the first x and y are used.', 'Split the text into several <text> elements.');
  }
  // Die IR positioniert die Oberkante der Zeile, SVG die Grundlinie.
  // Mit lineHeight 1.2 liegt die Grundlinie bei ca. 0.1 + 0.8 = 0.9 Schriftgrößen unter der Oberkante.
  warn(ctx, path, 'SVG positions text at the baseline; the IR positions the top of the line. The baseline was approximated at 0.9 × font-size.', 'Check the vertical text position after import.');
  const anchor = style['text-anchor'];
  const wide = 4 * Math.max(ctx.viewport.w, ctx.viewport.h, fontSize * text.length);
  const node: JsonNode = { id: ctx.ids.claim(attr(el, 'id'), 'text'), type: 'text', text, fontSize: round(fontSize), lineHeight: 1.2 };
  let left = x;
  if (anchor === 'middle' || anchor === 'end') {
    // Breite Box mit Ausrichtung ersetzt den Anker, ohne umzubrechen.
    node['width'] = round(wide);
    node['textAlign'] = anchor === 'middle' ? 'center' : 'right';
    left = anchor === 'middle' ? x - wide / 2 : x - wide;
  }
  const families = (style['font-family'] ?? '').split(',').map((f) => f.trim().replace(/^['"]|['"]$/gu, '')).filter((f) => f.length > 0);
  const family = families.find((f) => !GENERIC_FONTS.has(f.toLowerCase()));
  if (family !== undefined) node['fontFamily'] = family;
  else if (families.length > 0) warn(ctx, path, `Generic font family "${families.join(', ')}" was replaced by the project default font.`, 'Register a concrete font family and set fontFamily.');
  const weight = style['font-weight'];
  if (weight !== undefined) {
    const w = weight === 'bold' ? 700 : weight === 'normal' ? 400 : Number(weight);
    if (Number.isFinite(w) && w >= 1 && w <= 1000) {
      if (w !== 400) node['fontWeight'] = w;
    } else warn(ctx, path, `font-weight "${weight}" is not supported; 400 is used.`, 'Use a number from 100 to 900, "normal" or "bold".');
  }
  if (style['font-style'] === 'italic' || style['font-style'] === 'oblique') node['fontStyle'] = 'italic';
  const spacing = length(style['letter-spacing'], 'xy', ctx, fontSize);
  if (spacing !== undefined && spacing !== 0) node['letterSpacing'] = round(spacing);
  const decoration = style['text-decoration'];
  if (decoration === 'underline' || decoration === 'line-through' || decoration === 'overline') node['decoration'] = decoration;
  const offset = { x: left, y: y - 0.9 * fontSize };
  const matrix = multiply(multiply(inherited, elementMatrix(el, ctx, path)), [1, 0, 0, 1, offset.x, offset.y]);
  if (!applyPlacement(node, { matrix, pivot: { x: 0, y: 0 } })) {
    warn(ctx, path, 'The text transform cannot be decomposed; the text is not imported.', 'Use an invertible transform.');
    return [];
  }
  applyPaint(node, style, { offset }, ctx, path, 'text');
  applyCommon(node, style, ctx, path, offset, true);
  return [node];
}

function fitOf(value: string | undefined, ctx: Ctx, path: string): 'fill' | 'contain' | 'cover' {
  const [align = 'xMidYMid', mode = 'meet'] = (value ?? 'xMidYMid meet').trim().split(/\s+/u);
  if (align === 'none') return 'fill';
  if (align !== 'xMidYMid') warn(ctx, path, `preserveAspectRatio alignment "${align}" is not supported; the image is centered.`, 'Use xMidYMid or crop the image beforehand.');
  return mode === 'slice' ? 'cover' : 'contain';
}

function convertImage(el: XmlElement, style: Style, ctx: Ctx, path: string, inherited: Matrix2D): JsonNode[] {
  const source = href(el);
  if (source === undefined) return [];
  const data = source.startsWith('data:') ? parseDataUri(source) : undefined;
  const info = data !== undefined ? mimeInfo(data.mime) : undefined;
  if (data === undefined || info === undefined || (info.type !== 'image' && info.type !== 'svg')) {
    warn(
      ctx,
      path,
      data !== undefined ? `Embedded image type "${data.mime}" is not supported; the image is not imported.` : `Image "${source}" is not embedded; external files are not imported.`,
      isExternalUrl(source) || data === undefined ? `Import the file as an asset (openvideo assets import ${source}) and add an image node.` : 'Convert the image to PNG, JPEG or WebP.',
    );
    return [];
  }
  const id = ctx.ids.claim(attr(el, 'id'), 'image');
  const assetId = `${id}-asset`;
  ctx.assets.push(makeAsset(assetId, info.type, info.ext, data.bytes));
  const node: JsonNode = { id, type: info.type === 'svg' ? 'svg' : 'image', asset: assetId };
  const w = length(attr(el, 'width'), 'x', ctx);
  const h = length(attr(el, 'height'), 'y', ctx);
  if (w !== undefined) node['width'] = round(w);
  if (h !== undefined) node['height'] = round(h);
  node['fit'] = fitOf(attr(el, 'preserveAspectRatio'), ctx, path);
  const offset = { x: length(attr(el, 'x'), 'x', ctx) ?? 0, y: length(attr(el, 'y'), 'y', ctx) ?? 0 };
  const matrix = multiply(multiply(inherited, elementMatrix(el, ctx, path)), [1, 0, 0, 1, offset.x, offset.y]);
  if (!applyPlacement(node, { matrix, pivot: { x: 0, y: 0 } })) {
    warn(ctx, path, 'The image transform cannot be decomposed; the image is not imported.', 'Use an invertible transform.');
    ctx.assets.pop();
    return [];
  }
  applyCommon(node, style, ctx, path, offset, true);
  return [node];
}

/** Gruppe für `g`, `svg`, `symbol` und `use`. Liefert keine Node für leere Gruppen. */
function makeGroup(el: XmlElement, style: Style, ctx: Ctx, path: string, matrix: Matrix2D, children: JsonNode[], kind: string): JsonNode[] {
  if (children.length === 0) return [];
  const node: JsonNode = { id: ctx.ids.claim(attr(el, 'id'), kind), type: 'group', children };
  if (!applyPlacement(node, { matrix, pivot: { x: 0, y: 0 } })) {
    warn(ctx, path, 'The group transform cannot be decomposed; SVG renderers draw nothing, so the group is not imported.', 'Use an invertible transform.');
    return [];
  }
  applyCommon(node, style, ctx, path, { x: 0, y: 0 }, false);
  return [node];
}

/** Viewport mit `viewBox`: äußere Gruppe beschneidet, innere skaliert. */
function viewportGroup(el: XmlElement, style: Style, ctx: Ctx, path: string, matrix: Matrix2D, width: number, height: number, clip: boolean, kind: string): JsonNode[] {
  const vb = numberList(attr(el, 'viewBox'));
  const inner: Ctx = vb.length === 4 && (vb[2] ?? 0) > 0 && (vb[3] ?? 0) > 0 ? { ...ctx, viewport: { w: vb[2] ?? width, h: vb[3] ?? height } } : { ...ctx, viewport: { w: width, h: height } };
  const children = childElements(el).flatMap((c) => convertElement(c, style, inner, path, IDENTITY));
  if (children.length === 0) return [];
  const outer: JsonNode = { id: ctx.ids.claim(attr(el, 'id'), kind), type: 'group', width: round(width), height: round(height), ...(clip ? { clip: true } : {}) };
  if (!applyPlacement(outer, { matrix, pivot: { x: 0, y: 0 } })) {
    warn(ctx, path, 'The viewport transform cannot be decomposed; nothing is imported.', 'Use an invertible transform.');
    return [];
  }
  applyCommon(outer, style, ctx, path, { x: 0, y: 0 }, false);
  if (vb.length !== 4) {
    outer['children'] = children;
    return [outer];
  }
  const [vx = 0, vy = 0, vw = width, vh = height] = vb;
  const [align = 'xMidYMid', mode = 'meet'] = (attr(el, 'preserveAspectRatio') ?? 'xMidYMid meet').trim().split(/\s+/u);
  let sx = width / vw;
  let sy = height / vh;
  let tx = 0;
  let ty = 0;
  if (align !== 'none') {
    const s = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s;
    sy = s;
    const ax = align.includes('xMid') ? 0.5 : align.includes('xMax') ? 1 : 0;
    const ay = align.includes('YMid') ? 0.5 : align.includes('YMax') ? 1 : 0;
    tx = (width - vw * s) * ax;
    ty = (height - vh * s) * ay;
  }
  const scaler: JsonNode = { id: ctx.ids.next('viewbox'), type: 'group', children };
  applyPlacement(scaler, { matrix: [sx, 0, 0, sy, tx - vx * sx, ty - vy * sy], pivot: { x: 0, y: 0 } });
  outer['children'] = [scaler];
  return [outer];
}

function convertUse(el: XmlElement, style: Style, ctx: Ctx, path: string, inherited: Matrix2D): JsonNode[] {
  const ref = href(el);
  const target = ref?.startsWith('#') === true ? ctx.byId.get(ref.slice(1)) : undefined;
  if (target === undefined) {
    warn(ctx, path, `<use> reference "${ref ?? ''}" cannot be resolved; external references are not supported.`, 'Reference an element in the same document with href="#id".');
    return [];
  }
  if (ctx.useStack.has(target)) {
    warn(ctx, path, `<use> reference "${ref ?? ''}" is circular and was skipped.`, 'Remove the circular reference.');
    return [];
  }
  ctx.useStack.add(target);
  try {
    const x = length(attr(el, 'x'), 'x', ctx) ?? 0;
    const y = length(attr(el, 'y'), 'y', ctx) ?? 0;
    const matrix = multiply(multiply(inherited, elementMatrix(el, ctx, path)), [1, 0, 0, 1, x, y]);
    const targetPath = `${path} -> ${elementPath('', target)}`;
    if (target.name === 'symbol' || target.name === 'svg') {
      const w = length(attr(el, 'width') ?? attr(target, 'width') ?? '100%', 'x', ctx) ?? ctx.viewport.w;
      const h = length(attr(el, 'height') ?? attr(target, 'height') ?? '100%', 'y', ctx) ?? ctx.viewport.h;
      const symbolStyle = computeStyle(target, style, ctx);
      return viewportGroup(target, symbolStyle, ctx, targetPath, matrix, w, h, true, 'use');
    }
    const children = convertElement(target, style, ctx, targetPath, IDENTITY);
    return makeGroup(el, style, ctx, path, matrix, children, 'use');
  } finally {
    ctx.useStack.delete(target);
  }
}

function convertElement(el: XmlElement, parentStyle: Style, ctx: Ctx, parentPath: string, inherited: Matrix2D): JsonNode[] {
  const path = elementPath(parentPath, el);
  if (SILENT.has(el.name)) return [];
  if (REFERENCED_ONLY.has(el.name)) {
    return [];
  }
  const style = computeStyle(el, parentStyle, ctx);
  if (style['display'] === 'none') return [];
  if (ctx.clip && !['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'use'].includes(el.name)) {
    warn(ctx, path, `<${el.name}> is not allowed inside <clipPath> and was ignored.`, 'Use basic shapes, paths or text inside <clipPath>.');
    return [];
  }
  switch (el.name) {
    case 'g':
    case 'a': {
      const children = childElements(el).flatMap((c) => convertElement(c, style, ctx, path, IDENTITY));
      return makeGroup(el, style, ctx, path, multiply(inherited, elementMatrix(el, ctx, path)), children, 'group');
    }
    case 'switch': {
      warn(ctx, path, '<switch> is evaluated statically: only the first child is imported.', 'Replace <switch> with the wanted child.');
      const first = childElements(el).find((c) => !SILENT.has(c.name));
      const children = first !== undefined ? convertElement(first, style, ctx, path, IDENTITY) : [];
      return makeGroup(el, style, ctx, path, multiply(inherited, elementMatrix(el, ctx, path)), children, 'group');
    }
    case 'svg': {
      const x = length(attr(el, 'x'), 'x', ctx) ?? 0;
      const y = length(attr(el, 'y'), 'y', ctx) ?? 0;
      const w = length(attr(el, 'width') ?? '100%', 'x', ctx) ?? ctx.viewport.w;
      const h = length(attr(el, 'height') ?? '100%', 'y', ctx) ?? ctx.viewport.h;
      return viewportGroup(el, style, ctx, path, multiply(inherited, [1, 0, 0, 1, x, y]), w, h, style['overflow'] !== 'visible', 'svg');
    }
    case 'rect':
    case 'circle':
    case 'ellipse':
    case 'line':
    case 'polyline':
    case 'polygon':
    case 'path':
      return convertShape(el, style, ctx, path, inherited);
    case 'text':
      return convertText(el, style, ctx, path, inherited);
    case 'image':
      return convertImage(el, style, ctx, path, inherited);
    case 'use':
      return convertUse(el, style, ctx, path, inherited);
    default:
      warn(ctx, path, `SVG element <${el.name}> is not supported and was skipped.`, 'Convert it to basic shapes or paths before importing.');
      return [];
  }
}

function collect(el: XmlElement, byId: Map<string, XmlElement>, css: string[]): void {
  const id = attr(el, 'id');
  if (id !== undefined && !byId.has(id)) byId.set(id, el);
  if (el.name === 'style') css.push(textContent(el));
  for (const c of childElements(el)) collect(c, byId, css);
}

/**
 * Importiert SVG-Markup als IR-Nodes. Das Ergebnis ist eine Gruppe mit der ID `idPrefix`
 * (Standard `svg`), Breite und Höhe aus dem SVG und `clip: true`.
 *
 * @example
 * ```ts
 * const { nodes, assets, diagnostics } = importSvg('<svg width="100" height="100"><rect width="50" height="50" fill="red"/></svg>', { idPrefix: 'logo' });
 * // nodes[0] = { id: 'logo', type: 'group', width: 100, height: 100, clip: true, children: [{ id: 'logo-rect-1', type: 'rect', ... }] }
 * ```
 */
export function importSvg(markup: string, options: SvgImportOptions = {}): NodeImportResult {
  const root = parseXml(markup);
  if (root.name !== 'svg') throw importError('OV_IMPORT_PARSE', `The root element is <${root.name}>, not <svg>.`, 'Pass a complete SVG document.');
  const byId = new Map<string, XmlElement>();
  const css: string[] = [];
  collect(root, byId, css);
  const diagnostics: Diagnostic[] = [];
  const sheet = parseStylesheet(css.join('\n'));
  for (const selector of sheet.unsupported) {
    diagnostics.push(lossy(`svg > style`, `CSS selector or at-rule "${selector}" is not supported and was ignored.`, 'Use simple selectors: tag, .class, #id or combinations like rect.class.'));
  }
  const prefix = options.idPrefix ?? 'svg';
  const ids = new IdAllocator(prefix);
  const vb = numberList(attr(root, 'viewBox'));
  const probe: Ctx = { ids, diagnostics, assets: [], byId, rules: sheet.rules, viewport: { w: vb[2] ?? 300, h: vb[3] ?? 150 }, useStack: new Set(), clip: false };
  const width = length(attr(root, 'width'), 'x', probe) ?? vb[2] ?? 300;
  const height = length(attr(root, 'height'), 'y', probe) ?? vb[3] ?? 150;
  const ctx: Ctx = { ...probe, viewport: { w: width, h: height } };
  const rootId = ids.exact(prefix, 'svg');
  const style = computeStyle(root, {}, ctx);
  const rootCopy: XmlElement = { ...root, attrs: { ...root.attrs, id: '' } };
  const nodes = viewportGroup(rootCopy, style, ctx, 'svg', IDENTITY, width, height, true, 'svg');
  const [top] = nodes;
  if (top !== undefined) top['id'] = rootId;
  else nodes.push({ id: rootId, type: 'group', width: round(width), height: round(height), clip: true });
  return { nodes, assets: ctx.assets, diagnostics };
}
