/**
 * Daten-Komponenten: Chart, BarChart, LineChart, PieChart, Table.
 *
 * Wachstum: `progress` (0..1) steuert direkt; ohne `progress` wachsen die Daten
 * über `duration` (Standard theme.motion.slow) ab `delay` in lokaler Zeit.
 */
import { easing, type IrNode } from '@agentic-video/core';
import Type from 'typebox';
import { ColorProp, clamp01, defineComponent, framesOf, mix, palette, withAlpha, type BuildInput, type Built, type Props } from '../define.js';
import type { ResolvedTheme } from '../theme.js';
import { contrastOn, formatNumber } from './text.js';

interface Datum {
  readonly label: string;
  readonly value: number;
}

function data(records: readonly Record<string, unknown>[]): Datum[] {
  return records.map((r) => ({ label: typeof r['label'] === 'string' ? r['label'] : typeof r['label'] === 'number' ? String(r['label']) : '', value: typeof r['value'] === 'number' && Number.isFinite(r['value']) ? r['value'] : 0 }));
}

/** Roher Fortschritt 0..1 aus `progress` oder aus der Zeit (ohne Easing). */
function rawProgress({ p, ctx, theme }: BuildInput): number {
  const direct = p.optNum('progress');
  if (direct !== undefined) return clamp01(direct);
  const dur = p.frames('duration', theme.motion.slow, ctx.fps);
  const delay = p.frames('delay', 0, ctx.fps);
  return dur > 0 ? clamp01((ctx.frame - delay) / dur) : 1;
}

/** Fortschritt eines Elements `i` von `n` mit leichter Staffelung, geglättet mit theme.easing.standard. */
function staggered(raw: number, i: number, n: number, theme: ResolvedTheme): number {
  const s = n > 1 ? Math.min(0.08, 0.5 / n) : 0;
  const span = 1 - (n - 1) * s;
  return easing(theme.easing.standard)(clamp01((raw - i * s) / span));
}

/**
 * Runde Achsenobergrenze und Schrittweite für 4–5 Teilstriche.
 *
 * @example
 * ```ts
 * niceScale(87); // { max: 100, step: 20 }
 * ```
 */
export function niceScale(max: number): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 0.25 };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

function shortNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${formatNumber(v / 1e9, a % 1e9 === 0 ? 0 : 1, ',', '.')}B`;
  if (a >= 1e6) return `${formatNumber(v / 1e6, a % 1e6 === 0 ? 0 : 1, ',', '.')}M`;
  if (a >= 1e4) return `${formatNumber(v / 1e3, a % 1e3 === 0 ? 0 : 1, ',', '.')}k`;
  return formatNumber(v, Number.isInteger(v) ? 0 : 1, ',', '.');
}

interface Plot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly max: number;
}

/** Titel, Gitterlinien, Achsen und y-Beschriftung; liefert die Zeichenfläche. */
function axes(p: Props, theme: ResolvedTheme, width: number, height: number, maxValue: number, nodes: IrNode[]): Plot {
  const fs = theme.fontSizes.xs;
  const title = p.optStr('title');
  let top = theme.spacing.md;
  if (title !== undefined) {
    nodes.push({ id: 'title', type: 'text', text: title, width, maxLines: 1, ellipsis: '…', fontFamily: theme.fonts.heading, fontSize: theme.fontSizes.md, fontWeight: 700, fill: theme.colors.text });
    top += theme.fontSizes.md * 1.3;
  }
  const scale = niceScale(maxValue);
  const labelW = Math.max(...[0, scale.max].map((v) => shortNumber(v).length)) * fs * 0.6 + theme.spacing.md;
  const plot: Plot = { x: labelW, y: top, w: width - labelW, h: height - top - fs * 2.2, max: scale.max };
  const showGrid = p.bool('grid', true);
  for (let v = 0, i = 0; v <= scale.max + 1e-9; v += scale.step, i++) {
    const y = plot.y + plot.h - (v / scale.max) * plot.h;
    if (showGrid && v > 0) nodes.push({ id: `grid-${String(i)}`, type: 'line', from: { x: plot.x, y }, to: { x: plot.x + plot.w, y }, stroke: withAlpha(theme.colors.muted, 0.25), strokeWidth: 1, strokeDash: [4, 6] });
    nodes.push({ id: `tick-${String(i)}`, type: 'text', text: shortNumber(v), x: 0, y: y - fs * 0.6, width: labelW - theme.spacing.sm, textAlign: 'right', fontFamily: theme.fonts.body, fontSize: fs, fill: theme.colors.muted });
  }
  nodes.push(
    { id: 'axis-y', type: 'line', from: { x: plot.x, y: plot.y }, to: { x: plot.x, y: plot.y + plot.h }, stroke: withAlpha(theme.colors.text, 0.5), strokeWidth: 1.5 },
    { id: 'axis-x', type: 'line', from: { x: plot.x, y: plot.y + plot.h }, to: { x: plot.x + plot.w, y: plot.y + plot.h }, stroke: withAlpha(theme.colors.text, 0.5), strokeWidth: 1.5 },
  );
  return plot;
}

function xLabel(id: string, text: string, cx: number, slot: number, plot: Plot, theme: ResolvedTheme): IrNode {
  return { id, type: 'text', text, x: cx - slot / 2, y: plot.y + plot.h + theme.spacing.sm, width: slot, textAlign: 'center', maxLines: 1, ellipsis: '…', fontFamily: theme.fonts.body, fontSize: theme.fontSizes.xs, fill: theme.colors.muted };
}

function buildBar(input: BuildInput): Built {
  const { p, theme } = input;
  const width = p.num('width', 720);
  const height = p.num('height', 420);
  const items = data(p.records('data'));
  const nodes: IrNode[] = [];
  const plot = axes(p, theme, width, height, Math.max(0, ...items.map((d) => d.value)), nodes);
  const raw = rawProgress(input);
  const colors = palette(theme);
  const single = p.has('color') ? p.color('color', theme.colors.primary) : undefined;
  const slot = plot.w / Math.max(1, items.length);
  const showValues = p.bool('showValues', true);
  items.forEach((d, i) => {
    const k = staggered(raw, i, items.length, theme);
    const full = (Math.max(0, d.value) / plot.max) * plot.h;
    const h = full * k;
    const bw = slot * 0.6;
    const x = plot.x + i * slot + (slot - bw) / 2;
    const color = single ?? colors[i % colors.length] ?? theme.colors.primary;
    nodes.push({
      id: `bar-${String(i)}`,
      type: 'rect',
      x,
      y: plot.y + plot.h - h,
      width: bw,
      height: h,
      cornerRadius: [Math.min(theme.radii.sm, bw / 2, h), Math.min(theme.radii.sm, bw / 2, h), 0, 0],
      fill: { type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, stops: [{ offset: 0, color }, { offset: 1, color: mix(color, theme.colors.background, 0.35) }] },
    });
    nodes.push(xLabel(`label-${String(i)}`, d.label, x + bw / 2, slot, plot, theme));
    if (showValues) {
      const fs = theme.fontSizes.xs;
      nodes.push({ id: `value-${String(i)}`, type: 'text', text: shortNumber(d.value * k), x: x + bw / 2 - slot / 2, y: plot.y + plot.h - h - fs * 1.5, width: slot, textAlign: 'center', fontFamily: theme.fonts.body, fontSize: fs, fontWeight: 700, fontFeatures: { tnum: 1 }, fill: theme.colors.text, opacity: k });
    }
  });
  return { width, height, nodes };
}

interface Series {
  readonly name: string;
  readonly color: string | undefined;
  readonly data: Datum[];
}

function seriesOf(p: Props): Series[] {
  const list = p.records('series').map((s) => ({
    name: typeof s['name'] === 'string' ? s['name'] : '',
    color: typeof s['color'] === 'string' && /^#/u.test(s['color']) ? s['color'] : undefined,
    data: data(Array.isArray(s['data']) ? s['data'].filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)) : []),
  }));
  if (list.length > 0) return list;
  const single = data(p.records('data'));
  return single.length > 0 ? [{ name: '', color: p.has('color') ? p.color('color', '#FFFFFF') : undefined, data: single }] : [];
}

/**
 * Anfang einer Polyline bis zum Anteil `t` (0..1) ihrer Länge – dieselbe Strecke, die `trimEnd: t`
 * von der Linie zeigt. Liefert mindestens den ersten Punkt.
 *
 * @example
 * ```ts
 * polylinePrefix([[0, 0], [10, 0], [10, 10]], 0.75); // [[0, 0], [10, 0], [10, 5]]
 * ```
 */
export function polylinePrefix(points: readonly (readonly [number, number])[], t: number): [number, number][] {
  const first = points[0];
  if (first === undefined) return [];
  const lengths = points.slice(1).map((p, i) => {
    const prev = points[i] ?? p;
    return Math.hypot(p[0] - prev[0], p[1] - prev[1]);
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  const k = clamp01(t);
  if (k >= 1 || total === 0) return k >= 1 ? points.map(([x, y]) => [x, y]) : [[first[0], first[1]]];
  let left = k * total;
  const out: [number, number][] = [[first[0], first[1]]];
  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i] ?? 0;
    const a = points[i] ?? first;
    const b = points[i + 1] ?? a;
    if (left >= len) {
      out.push([b[0], b[1]]);
      left -= len;
      continue;
    }
    if (left > 0) out.push([a[0] + ((b[0] - a[0]) * left) / len, a[1] + ((b[1] - a[1]) * left) / len]);
    break;
  }
  return out;
}

function buildLine(input: BuildInput): Built {
  const { p, theme } = input;
  const width = p.num('width', 720);
  const height = p.num('height', 420);
  const series = seriesOf(p);
  const nodes: IrNode[] = [];
  const plot = axes(p, theme, width, height, Math.max(0, ...series.flatMap((s) => s.data.map((d) => d.value))), nodes);
  const k = easing(theme.easing.standard)(rawProgress(input));
  const colors = palette(theme);
  const labels = series[0]?.data.map((d) => d.label) ?? [];
  const n = Math.max(1, ...series.map((s) => s.data.length));
  const stepX = n > 1 ? plot.w / (n - 1) : 0;
  const inset = n > 1 ? 0 : plot.w / 2;
  labels.forEach((l, i) => nodes.push(xLabel(`label-${String(i)}`, l, plot.x + inset + i * stepX, Math.max(stepX, 40), plot, theme)));
  const area = p.bool('area', series.length === 1);
  series.forEach((s, si) => {
    const color = s.color ?? colors[si % colors.length] ?? theme.colors.primary;
    const pts: [number, number][] = s.data.map((d, i) => [plot.x + inset + i * stepX, plot.y + plot.h - (Math.max(0, d.value) / plot.max) * plot.h]);
    if (pts.length === 0) return;
    const first = pts[0] ?? [plot.x, plot.y + plot.h];
    if (area && pts.length >= 2) {
      // Die Fläche liegt unter der schon gezeichneten Linie: Sie wächst mit demselben Anteil der
      // Linienlänge wie `trimEnd` und steht nie vor der Linie. Der Verlauf hängt an der Box der
      // vollen Fläche (Pixel), damit er beim Wachsen nicht mitwandert; am Ende gleicht er `relative`.
      const base = plot.y + plot.h;
      const drawn = polylinePrefix(pts, k);
      const end = drawn[drawn.length - 1] ?? first;
      const minX = Math.min(...pts.map(([x]) => x));
      const minY = Math.min(...pts.map(([, y]) => y), base);
      nodes.push({
        id: `area-${String(si)}`,
        type: 'polygon',
        points: [...drawn, [end[0], base], [first[0], base]],
        fill: { type: 'linear', units: 'pixels', start: { x: minX, y: minY }, end: { x: minX, y: minY + (base - minY) }, stops: [{ offset: 0, color: withAlpha(color, 0.35) }, { offset: 1, color: withAlpha(color, 0) }] },
      });
    }
    if (pts.length >= 2) nodes.push({ id: `line-${String(si)}`, type: 'polyline', points: pts, stroke: color, strokeWidth: 4, strokeJoin: 'round', strokeCap: 'round', trimEnd: k });
    pts.forEach(([x, y], i) => {
      const at = pts.length > 1 ? i / (pts.length - 1) : 0;
      const r = 6;
      nodes.push({ id: `point-${String(si)}-${String(i)}`, type: 'ellipse', x: x - r, y: y - r, width: r * 2, height: r * 2, fill: theme.colors.background, stroke: color, strokeWidth: 3, opacity: k >= at ? 1 : 0 });
    });
  });
  if (series.length > 1) {
    const fs = theme.fontSizes.xs;
    let x = plot.x + plot.w;
    // Von rechts nach links setzen, damit die Legende in Serien-Reihenfolge steht.
    [...series.entries()].reverse().forEach(([si, s]) => {
      const color = s.color ?? colors[si % colors.length] ?? theme.colors.primary;
      const w = s.name.length * fs * 0.55 + fs * 2;
      x -= w;
      nodes.push({ id: `legend-swatch-${String(si)}`, type: 'rect', x, y: plot.y - fs * 1.4 + fs * 0.2, width: fs * 0.8, height: fs * 0.8, cornerRadius: 2, fill: color });
      nodes.push({ id: `legend-${String(si)}`, type: 'text', text: s.name, x: x + fs, y: plot.y - fs * 1.4, fontFamily: theme.fonts.body, fontSize: fs, fill: theme.colors.muted });
    });
  }
  return { width, height, nodes };
}

/**
 * SVG-Pfad eines Kreis- oder Ringsegments (Winkel in Grad, 0 = rechts, im Uhrzeigersinn).
 *
 * @example
 * ```ts
 * arcPath(100, 100, 100, 0, -90, 0); // Viertelkreis oben rechts
 * ```
 */
export function arcPath(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  const sweep = end - start;
  if (sweep >= 359.999) {
    // Voller Kreis: zwei Hälften, sonst ist der Bogen entartet.
    const half = start + 180;
    return `${arcPath(cx, cy, r, inner, start, half)} ${arcPath(cx, cy, r, inner, half, start + 360)}`;
  }
  const rad = (a: number) => (a * Math.PI) / 180;
  const pt = (radius: number, a: number) => `${(cx + radius * Math.cos(rad(a))).toFixed(3)} ${(cy + radius * Math.sin(rad(a))).toFixed(3)}`;
  const large = sweep > 180 ? 1 : 0;
  const outer = `M ${pt(r, start)} A ${String(r)} ${String(r)} 0 ${String(large)} 1 ${pt(r, end)}`;
  if (inner <= 0) return `${outer} L ${pt(0, 0)} Z`;
  return `${outer} L ${pt(inner, end)} A ${String(inner)} ${String(inner)} 0 ${String(large)} 0 ${pt(inner, start)} Z`;
}

function buildPie(input: BuildInput): Built {
  const { p, theme } = input;
  const size = p.num('size', 360);
  const items = data(p.records('data')).filter((d) => d.value > 0);
  const total = items.reduce((s, d) => s + d.value, 0);
  const innerRatio = Math.min(0.9, Math.max(0, p.num('innerRadius', 0.55)));
  const r = size / 2;
  const k = easing(theme.easing.standard)(rawProgress(input));
  const colors = palette(theme);
  const nodes: IrNode[] = [];
  const fs = theme.fontSizes.xs;
  let angle = -90;
  items.forEach((d, i) => {
    const sweep = total > 0 ? (d.value / total) * 360 * k : 0;
    const color = colors[i % colors.length] ?? theme.colors.primary;
    if (sweep > 0.01) nodes.push({ id: `slice-${String(i)}`, type: 'path', d: arcPath(r, r, r, r * innerRatio, angle, angle + sweep), fill: color, stroke: theme.colors.background, strokeWidth: 2 });
    if (p.bool('showPercent', true) && total > 0 && sweep > 12) {
      const mid = ((angle + sweep / 2) * Math.PI) / 180;
      const lr = innerRatio > 0 ? r * (1 + innerRatio) / 2 : r * 0.62;
      nodes.push({ id: `percent-${String(i)}`, type: 'text', text: `${String(Math.round((d.value / total) * 100))}%`, x: r + lr * Math.cos(mid) - 40, y: r + lr * Math.sin(mid) - fs * 0.6, width: 80, textAlign: 'center', fontFamily: theme.fonts.body, fontSize: fs, fontWeight: 700, fill: contrastOn(color, theme), opacity: k });
    }
    angle += sweep;
  });
  const center = p.optStr('centerLabel');
  if (center !== undefined && innerRatio > 0) {
    nodes.push({ id: 'center', type: 'text', text: center, x: r - r * innerRatio, y: r - theme.fontSizes.md * 0.6, width: r * innerRatio * 2, textAlign: 'center', maxLines: 1, fontFamily: theme.fonts.heading, fontSize: theme.fontSizes.md, fontWeight: 700, fill: theme.colors.text });
  }
  let width = size;
  if (p.bool('legend', true)) {
    const lx = size + theme.spacing.xl;
    const rowH = fs * 1.8;
    const y0 = r - (items.length * rowH) / 2;
    items.forEach((d, i) => {
      const color = colors[i % colors.length] ?? theme.colors.primary;
      nodes.push({ id: `legend-swatch-${String(i)}`, type: 'rect', x: lx, y: y0 + i * rowH + fs * 0.15, width: fs, height: fs, cornerRadius: 3, fill: color });
      nodes.push({ id: `legend-${String(i)}`, type: 'text', text: `${d.label}  ${shortNumber(d.value)}`, x: lx + fs * 1.6, y: y0 + i * rowH, fontFamily: theme.fonts.body, fontSize: fs, fill: theme.colors.text });
    });
    width = lx + 240;
  }
  return { width, height: size, nodes };
}

const Datum = Type.Object({ label: Type.String(), value: Type.Number() }, { additionalProperties: false });
const GrowthProps = {
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: 'Growth 0..1. Overrides the time-based growth.' })),
  duration: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: 'Growth duration. Default theme.motion.slow.' })),
  delay: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  title: Type.Optional(Type.String()),
};
const XYProps = {
  width: Type.Optional(Type.Number({ minimum: 100 })),
  height: Type.Optional(Type.Number({ minimum: 80 })),
  grid: Type.Optional(Type.Boolean()),
  color: ColorProp('Single color for all bars/lines. Default: theme palette.'),
};
const PieProps = {
  size: Type.Optional(Type.Number({ minimum: 40 })),
  innerRadius: Type.Optional(Type.Number({ minimum: 0, maximum: 0.9, description: 'Donut hole as fraction of the radius. 0 = pie. Default 0.55.' })),
  centerLabel: Type.Optional(Type.String()),
  legend: Type.Optional(Type.Boolean()),
  showPercent: Type.Optional(Type.Boolean()),
};
const SeriesSchema = Type.Array(Type.Object({ name: Type.String(), color: ColorProp('Series color.'), data: Type.Array(Datum) }, { additionalProperties: false }));
const sampleData = [
  { label: 'Q1', value: 42 },
  { label: 'Q2', value: 68 },
  { label: 'Q3', value: 55 },
  { label: 'Q4', value: 91 },
];

export const BarChart = defineComponent({
  name: 'BarChart',
  description: 'Vertical bar chart with axes, grid, labels and value labels. Bars grow with stagger; colors cycle through the theme palette.',
  props: { data: Type.Array(Datum), showValues: Type.Optional(Type.Boolean()), ...XYProps, ...GrowthProps },
  example: { data: sampleData, title: 'Renders per quarter' },
  build: buildBar,
});

export const LineChart = defineComponent({
  name: 'LineChart',
  description: 'Line chart with one or more series (`series`, or `data` for one series). Lines draw on (trim), points pop in; one series gets a gradient area that grows with the line.',
  props: { series: Type.Optional(SeriesSchema), data: Type.Optional(Type.Array(Datum)), area: Type.Optional(Type.Boolean()), ...XYProps, ...GrowthProps },
  example: {
    series: [
      { name: 'Skia', data: sampleData },
      { name: 'Browser', data: sampleData.map((d) => ({ label: d.label, value: Math.round(d.value * 0.6) })) },
    ],
    title: 'Frames per second',
  },
  build: buildLine,
});

export const PieChart = defineComponent({
  name: 'PieChart',
  description: 'Pie or donut chart from path arcs with legend and percentages. Slices sweep in clockwise from 12 o\'clock.',
  props: { data: Type.Array(Datum), ...PieProps, ...GrowthProps },
  example: { data: sampleData, centerLabel: '256' },
  enter: 'scale',
  build: buildPie,
});

const CHART_TYPES = ['bar', 'line', 'pie'] as const;

export const Chart = defineComponent({
  name: 'Chart',
  description: 'Generic chart: `type` bar, line or pie with the props of BarChart, LineChart or PieChart.',
  props: {
    type: Type.Optional(Type.Enum(CHART_TYPES)),
    data: Type.Optional(Type.Array(Datum)),
    series: Type.Optional(SeriesSchema),
    showValues: Type.Optional(Type.Boolean()),
    area: Type.Optional(Type.Boolean()),
    ...XYProps,
    ...PieProps,
    ...GrowthProps,
  },
  example: { type: 'bar', data: sampleData },
  build(input) {
    const kind = input.p.oneOf('type', CHART_TYPES, 'bar');
    return kind === 'line' ? buildLine(input) : kind === 'pie' ? buildPie(input) : buildBar(input);
  },
});

export const Table = defineComponent({
  name: 'Table',
  description: 'Data table with a colored header, zebra rows and a staggered row reveal. Numeric cells are right-aligned.',
  props: {
    columns: Type.Array(Type.String()),
    rows: Type.Array(Type.Array(Type.Union([Type.String(), Type.Number()]))),
    width: Type.Optional(Type.Number({ minimum: 100 })),
    columnWidths: Type.Optional(Type.Array(Type.Number({ exclusiveMinimum: 0 }), { description: 'Relative column widths.' })),
    fontSize: Type.Optional(Type.Number({ minimum: 1 })),
    stagger: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: 'Delay between rows. Default 3 frames.' })),
    color: ColorProp('Header color. Default: theme.colors.primary.'),
  },
  example: {
    columns: ['Backend', 'Frames', 'Time'],
    rows: [
      ['Skia', 300, '4.2 s'],
      ['Browser', 300, '9.8 s'],
      ['Blender', 120, '61 s'],
    ],
  },
  enter: 'fade',
  build({ p, ctx, theme }) {
    const columns = p.strings('columns');
    const raw = p.raw['rows'];
    const rows: (string | number)[][] = Array.isArray(raw) ? raw.filter(Array.isArray).map((r: unknown[]) => r.map((c) => (typeof c === 'number' ? c : String(c)))) : [];
    const width = p.num('width', 800);
    const fs = p.num('fontSize', theme.fontSizes.sm);
    const rowH = fs * 2.2;
    const pad = theme.spacing.md;
    const weights = p.numbers('columnWidths');
    const sum = columns.reduce((s, _, i) => s + (weights[i] ?? 1), 0);
    const colW = columns.map((_, i) => ((weights[i] ?? 1) / Math.max(sum, 1e-9)) * width);
    const colX = colW.map((_, i) => colW.slice(0, i).reduce((s, w) => s + w, 0));
    const header = p.color('color', theme.colors.primary);
    const height = rowH * (rows.length + 1);
    const nodes: IrNode[] = [
      { id: 'bg', type: 'rect', width, height, cornerRadius: theme.radii.md, fill: theme.colors.surface, shadow: theme.shadows.md },
      { id: 'header', type: 'rect', width, height: rowH, cornerRadius: [theme.radii.md, theme.radii.md, 0, 0], fill: header },
    ];
    columns.forEach((c, i) => {
      const numeric = typeof rows[0]?.[i] === 'number';
      nodes.push({ id: `head-${String(i)}`, type: 'text', text: c, x: (colX[i] ?? 0) + pad, y: (rowH - fs * 1.2) / 2, width: Math.max(0, (colW[i] ?? 0) - pad * 2), textAlign: numeric ? 'right' : 'left', maxLines: 1, ellipsis: '…', fontFamily: theme.fonts.heading, fontSize: fs, fontWeight: 700, fill: contrastOn(header, theme) });
    });
    const stagger = p.frames('stagger', 3, ctx.fps);
    const dur = framesOf(theme.motion.normal, ctx.fps) ?? 15;
    rows.forEach((row, r) => {
      const t0 = r * stagger;
      const cells: IrNode[] = [];
      if (r % 2 === 1) cells.push({ id: `zebra-${String(r)}`, type: 'rect', width, height: rowH, fill: mix(theme.colors.surface, theme.colors.text, 0.05) });
      if (r < rows.length - 1) cells.push({ id: `rule-${String(r)}`, type: 'line', from: { x: 0, y: rowH }, to: { x: width, y: rowH }, stroke: withAlpha(theme.colors.muted, 0.2), strokeWidth: 1 });
      columns.forEach((_, ci) => {
        const v = row[ci];
        if (v === undefined) return;
        const numeric = typeof v === 'number';
        cells.push({
          id: `cell-${String(r)}-${String(ci)}`,
          type: 'text',
          text: numeric ? formatNumber(v, Number.isInteger(v) ? 0 : 2, ',', '.') : v,
          x: (colX[ci] ?? 0) + pad,
          y: (rowH - fs * 1.2) / 2,
          width: Math.max(0, (colW[ci] ?? 0) - pad * 2),
          textAlign: numeric ? 'right' : 'left',
          maxLines: 1,
          ellipsis: '…',
          fontFamily: theme.fonts.body,
          fontSize: fs,
          fontFeatures: numeric ? { tnum: 1 } : {},
          fill: ci === 0 ? theme.colors.text : mix(theme.colors.text, theme.colors.muted, 0.4),
        });
      });
      nodes.push({
        id: `row-${String(r)}`,
        type: 'group',
        y: rowH * (r + 1),
        width,
        height: rowH,
        opacity: { $keyframes: [{ t: t0, v: 0 }, { t: t0 + dur, v: 1, ease: theme.easing.enter }] },
        x: { $keyframes: [{ t: t0, v: -theme.spacing.md }, { t: t0 + dur, v: 0, ease: theme.easing.enter }] },
        children: cells,
      });
    });
    return { width, height, nodes };
  },
});
