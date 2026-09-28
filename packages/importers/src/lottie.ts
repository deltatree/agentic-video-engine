/**
 * Lottie-Import (FR-85): als eingebettete `lottie`-Node (verlustfrei) oder nativ als IR-Formen.
 *
 * Nativer Modus: Shape-Layer, Solids, Bilder, Precomps und Null-Layer werden zu Gruppen
 * und Formen. Keyframes werden `$keyframes` mit `cubic-bezier`-Easing aus den Lottie-Tangenten.
 * Nicht abbildbare Merkmale erzeugen `OV_IMPORT_LOSSY`.
 */
import { BLEND_MODES, isRecord, type Diagnostic, type Gradient } from '@agentic-video/core';
import { IdAllocator, importError, lossy, makeAsset, mimeInfo, parseDataUri, plain, round, seconds, type ImportedAsset, type JsonNode, type NodeImportResult } from './common.js';
import { irColor } from './css.js';

/** Optionen für {@link importLottie}. */
export interface LottieImportOptions {
  /** `embed`: eine `lottie`-Node plus Asset (verlustfrei). `native`: Umwandlung in IR-Formen. */
  readonly mode: 'native' | 'embed';
  /** Präfix aller IDs (Standard `lottie`). Die Wurzel-Node erhält genau diese ID. */
  readonly idPrefix?: string;
  /** Asset-ID im Modus `embed` (Standard `<idPrefix>-asset`). */
  readonly assetId?: string;
}

type Rec = Record<string, unknown>;

function num(o: Rec, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function rec(o: Rec, key: string): Rec | undefined {
  const v = o[key];
  return isRecord(v) ? v : undefined;
}

function list(o: Rec, key: string): unknown[] {
  const v = o[key];
  return Array.isArray(v) ? v : [];
}

function records(o: Rec, key: string): Rec[] {
  return list(o, key).filter(isRecord);
}

function numbers(v: unknown): number[] | undefined {
  if (typeof v === 'number') return [v];
  if (!Array.isArray(v) || !v.every((x): x is number => typeof x === 'number')) return undefined;
  return v;
}

function str(o: Rec, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Animierte Properties
// ---------------------------------------------------------------------------

/** Abbildung von Lottie-Layerzeit (Frames) auf die lokale Zeit der Ziel-Node (Frames). */
interface TimeMap {
  readonly scale: number;
  readonly offset: number;
}

interface Key<T> {
  /** Lottie-Frame. */
  readonly t: number;
  readonly v: T;
  /** Easing des Segments, das auf diesen Keyframe zuläuft. */
  readonly ease?: string;
}

type Anim<T> = { readonly kind: 'static'; readonly v: T } | { readonly kind: 'keys'; readonly keys: readonly Key<T>[] };

interface LCtx {
  readonly fr: number;
  readonly ids: IdAllocator;
  readonly diagnostics: Diagnostic[];
  readonly assets: ImportedAsset[];
  readonly lottieAssets: ReadonlyMap<string, Rec>;
  readonly fonts: ReadonlyMap<string, string>;
  readonly precompStack: Set<string>;
}

function warn(ctx: LCtx, path: string, problem: string, suggestion: string): void {
  ctx.diagnostics.push(lossy(path, problem, suggestion));
}

function firstComponent(v: unknown): { value: number; uniform: boolean } | undefined {
  const n = numbers(v);
  const [first] = n ?? [];
  if (n === undefined || first === undefined) return undefined;
  return { value: first, uniform: n.every((x) => Math.abs(x - first) < 1e-9) };
}

function easeOf(k: Rec, ctx: LCtx, path: string): string {
  if (num(k, 'h') === 1) return 'hold';
  const o = rec(k, 'o');
  const i = rec(k, 'i');
  if (o === undefined || i === undefined) return 'linear';
  const ox = firstComponent(o['x']);
  const oy = firstComponent(o['y']);
  const ix = firstComponent(i['x']);
  const iy = firstComponent(i['y']);
  if (ox === undefined || oy === undefined || ix === undefined || iy === undefined) return 'linear';
  if (!ox.uniform || !oy.uniform || !ix.uniform || !iy.uniform) {
    warn(ctx, path, 'Separate easing per dimension is not supported; the first dimension’s easing is used for all.', 'Use the same easing for all dimensions or split the property.');
  }
  const clamp = (x: number) => Math.min(Math.max(x, 0), 1);
  return `cubic-bezier(${plain(clamp(ox.value), 4)},${plain(oy.value, 4)},${plain(clamp(ix.value), 4)},${plain(iy.value, 4)})`;
}

/**
 * Liest eine Lottie-Property (`{ a, k }`). `map` wandelt Rohwerte um; `undefined` = ungültig.
 */
function readProp<T>(prop: unknown, map: (raw: unknown) => T | undefined, ctx: LCtx, path: string): Anim<T> | undefined {
  if (!isRecord(prop)) return undefined;
  if (typeof prop['x'] === 'string' && prop['x'].length > 0) {
    warn(ctx, path, 'Lottie expressions are not supported; the keyframed or static value is used.', 'Bake the expression into keyframes before exporting.');
  }
  const k = prop['k'];
  const isKeyframed = Array.isArray(k) && k.length > 0 && k.every((x) => isRecord(x) && typeof x['t'] === 'number');
  if (!isKeyframed) {
    const v = map(k);
    return v === undefined ? undefined : { kind: 'static', v };
  }
  const raw = k.filter(isRecord);
  const keys: Key<T>[] = [];
  let spatialWarned = false;
  for (let n = 0; n < raw.length; n++) {
    const cur = raw[n];
    const prev = raw[n - 1];
    if (cur === undefined) continue;
    const t = num(cur, 't') ?? 0;
    const source = cur['s'] !== undefined ? cur['s'] : prev?.['e'];
    const v = map(source);
    if (v === undefined) continue;
    const toTangent = numbers(prev?.['to']);
    const tiTangent = numbers(prev?.['ti']);
    if (!spatialWarned && ((toTangent?.some((x) => x !== 0) ?? false) || (tiTangent?.some((x) => x !== 0) ?? false))) {
      spatialWarned = true;
      warn(ctx, path, 'Spatial bezier tangents (curved motion paths) are not supported; position moves in straight lines.', 'Add more keyframes along the curve or use motionPath.');
    }
    keys.push({ t, v, ...(prev !== undefined && keys.length > 0 ? { ease: easeOf(prev, ctx, path) } : {}) });
  }
  const [only] = keys;
  if (only === undefined) return undefined;
  return keys.length === 1 ? { kind: 'static', v: only.v } : { kind: 'keys', keys };
}

function mapAnim<T, U>(a: Anim<T>, fn: (v: T) => U): Anim<U> {
  return a.kind === 'static' ? { kind: 'static', v: fn(a.v) } : { kind: 'keys', keys: a.keys.map((k) => ({ ...k, v: fn(k.v) })) };
}

function isZero(a: Anim<number> | undefined): boolean {
  return a === undefined || (a.kind === 'static' && Math.abs(a.v) < 1e-9);
}

function staticValue<T>(a: Anim<T>): T | undefined {
  return a.kind === 'static' ? a.v : undefined;
}

function firstValue<T>(a: Anim<T>): T | undefined {
  return a.kind === 'static' ? a.v : a.keys[0]?.v;
}

/** IR-Wert: Literal oder `$keyframes` mit Zeiten in Sekunden. */
function toIr(a: Anim<unknown>, tm: TimeMap, ctx: LCtx): unknown {
  if (a.kind === 'static') return a.v;
  // Konstante Keyframes (z. B. die y-Komponente einer waagrechten Bewegung) werden zum Literal.
  const [first] = a.keys;
  if (first !== undefined && a.keys.every((k) => JSON.stringify(k.v) === JSON.stringify(first.v))) return first.v;
  return {
    $keyframes: a.keys.map((k) => ({ t: seconds((k.t * tm.scale + tm.offset) / ctx.fr), v: k.v, ...(k.ease !== undefined ? { ease: k.ease } : {}) })),
  };
}

const scalar = (raw: unknown): number | undefined => numbers(raw)?.[0];
const vector = (raw: unknown): number[] | undefined => {
  const n = numbers(raw);
  return n !== undefined && n.length >= 2 ? n : undefined;
};
const color = (raw: unknown): string | undefined => {
  const n = numbers(raw);
  if (n === undefined || n.length < 3) return undefined;
  // Ältere Exporte nutzen 0..255 statt 0..1.
  const scale = n.slice(0, 3).some((x) => x > 1) ? 255 : 1;
  return irColor({ r: (n[0] ?? 0) / scale, g: (n[1] ?? 0) / scale, b: (n[2] ?? 0) / scale, a: 1 });
};

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

interface TransformGroups {
  /** Äußere Gruppe: Position, Rotation, Skalierung (und Deckkraft, falls gewünscht). */
  readonly outer: JsonNode;
  /** Innere Gruppe für den Ankerpunkt, falls nötig. */
  readonly anchor?: JsonNode;
}

function setAnim(node: JsonNode, key: string, a: Anim<unknown> | undefined, tm: TimeMap, ctx: LCtx, isDefault: (v: unknown) => boolean): void {
  if (a === undefined) return;
  const value = toIr(a, tm, ctx);
  if (!isDefault(value)) node[key] = value;
}

/** Baut Gruppen für eine Lottie-Transformation (`ks` eines Layers oder `tr` einer Gruppe). */
function transformGroups(ks: Rec | undefined, tm: TimeMap, ctx: LCtx, path: string, id: string, withOpacity: boolean): TransformGroups {
  const outer: JsonNode = { id, type: 'group', origin: { x: 0, y: 0 } };
  if (ks === undefined) return { outer };
  const p = rec(ks, 'p');
  if (p !== undefined && p['s'] === true) {
    setAnim(outer, 'x', readProp(p['x'], scalar, ctx, `${path}.p.x`), tm, ctx, (v) => v === 0);
    setAnim(outer, 'y', readProp(p['y'], scalar, ctx, `${path}.p.y`), tm, ctx, (v) => v === 0);
    if (p['z'] !== undefined) warn(ctx, `${path}.p.z`, 'The z position is ignored (2D import).', 'Keep the animation in 2D.');
  } else {
    const pos = readProp(p, vector, ctx, `${path}.p`);
    if (pos !== undefined) {
      setAnim(outer, 'x', mapAnim(pos, (v) => round(v[0] ?? 0)), tm, ctx, (v) => v === 0);
      setAnim(outer, 'y', mapAnim(pos, (v) => round(v[1] ?? 0)), tm, ctx, (v) => v === 0);
    }
  }
  const s = readProp(ks['s'], vector, ctx, `${path}.s`);
  if (s !== undefined) setAnim(outer, 'scale', mapAnim(s, (v) => ({ x: round((v[0] ?? 100) / 100), y: round((v[1] ?? 100) / 100) })), tm, ctx, (v) => isRecord(v) && v['x'] === 1 && v['y'] === 1);
  const r = readProp(ks['r'] ?? ks['rz'], scalar, ctx, `${path}.r`);
  if (r !== undefined) setAnim(outer, 'rotation', r, tm, ctx, (v) => v === 0);
  for (const axis of ['rx', 'ry']) {
    if (!isZero(readProp(ks[axis], scalar, ctx, `${path}.${axis}`))) warn(ctx, `${path}.${axis}`, `3D rotation "${axis}" is ignored (2D import).`, 'Use a scene3d node for 3D motion.');
  }
  if (!isZero(readProp(ks['sk'], scalar, ctx, `${path}.sk`))) warn(ctx, `${path}.sk`, 'Transform skew is not supported; the layer is drawn without skew.', 'Remove the skew or bake it into the shapes.');
  if (withOpacity) {
    const o = readProp(ks['o'], scalar, ctx, `${path}.o`);
    if (o !== undefined) setAnim(outer, 'opacity', mapAnim(o, (v) => round(Math.min(Math.max(v / 100, 0), 1))), tm, ctx, (v) => v === 1);
  }
  const a = readProp(ks['a'], vector, ctx, `${path}.a`);
  if (a === undefined) return { outer };
  const ax = mapAnim(a, (v) => round(-(v[0] ?? 0)));
  const ay = mapAnim(a, (v) => round(-(v[1] ?? 0)));
  if (isZero(ax) && isZero(ay)) return { outer };
  const anchor: JsonNode = { id: `${id}-anchor`, type: 'group' };
  setAnim(anchor, 'x', ax, tm, ctx, (v) => v === 0);
  setAnim(anchor, 'y', ay, tm, ctx, (v) => v === 0);
  return { outer, anchor };
}

function wrap(groups: TransformGroups, children: JsonNode[]): JsonNode {
  if (groups.anchor === undefined) return { ...groups.outer, children };
  return { ...groups.outer, children: [{ ...groups.anchor, children }] };
}

// ---------------------------------------------------------------------------
// Formen
// ---------------------------------------------------------------------------

interface ShapeCtx {
  readonly ctx: LCtx;
  readonly tm: TimeMap;
}

function shapeToD(raw: unknown): string | undefined {
  const shape: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (!isRecord(shape)) return undefined;
  const pts = (key: string): number[][] => list(shape, key).map((p) => numbers(p) ?? [0, 0]);
  const v = pts('v');
  const inT = pts('i');
  const outT = pts('o');
  const [start] = v;
  if (start === undefined) return undefined;
  const f = (n: number | undefined) => plain(n ?? 0, 4);
  const parts = [`M${f(start[0])} ${f(start[1])}`];
  const count = shape['c'] === true ? v.length : v.length - 1;
  for (let n = 0; n < count; n++) {
    const a = v[n] ?? [0, 0];
    const b = v[(n + 1) % v.length] ?? [0, 0];
    const o = outT[n] ?? [0, 0];
    const i = inT[(n + 1) % v.length] ?? [0, 0];
    parts.push(`C${f((a[0] ?? 0) + (o[0] ?? 0))} ${f((a[1] ?? 0) + (o[1] ?? 0))} ${f((b[0] ?? 0) + (i[0] ?? 0))} ${f((b[1] ?? 0) + (i[1] ?? 0))} ${f(b[0])} ${f(b[1])}`);
  }
  if (shape['c'] === true) parts.push('Z');
  return parts.join(' ');
}

interface Geometry {
  /** Form-Node ohne Farbe. */
  readonly node: JsonNode;
  /** Optionale Hülle für animierte Mittelpunkte. */
  readonly wrapper?: JsonNode;
  /** Verschiebung der lokalen Box gegenüber den Lottie-Koordinaten; `undefined`, wenn animiert. */
  readonly offset?: { readonly x: number; readonly y: number };
}

function geometry(item: Rec, sc: ShapeCtx, path: string, id: string): Geometry | undefined {
  const { ctx, tm } = sc;
  const ty = str(item, 'ty');
  if (ty === 'sh') {
    const ks = readProp(item['ks'], shapeToD, ctx, `${path}.ks`);
    if (ks === undefined) return undefined;
    return { node: { id, type: 'path', d: toIr(ks, tm, ctx) }, offset: { x: 0, y: 0 } };
  }
  if (ty !== 'rc' && ty !== 'el') return undefined;
  const size = readProp(item['s'], vector, ctx, `${path}.s`);
  const pos = readProp(item['p'], vector, ctx, `${path}.p`);
  if (size === undefined) return undefined;
  const node: JsonNode = { id, type: ty === 'rc' ? 'rect' : 'ellipse' };
  node['width'] = toIr(mapAnim(size, (v) => round(Math.abs(v[0] ?? 0))), tm, ctx);
  node['height'] = toIr(mapAnim(size, (v) => round(Math.abs(v[1] ?? 0))), tm, ctx);
  if (ty === 'rc') {
    const r = readProp(item['r'], scalar, ctx, `${path}.r`);
    if (r !== undefined && !isZero(r)) node['cornerRadius'] = toIr(mapAnim(r, (v) => round(Math.max(0, v))), tm, ctx);
  }
  const p = pos !== undefined ? staticValue(pos) : [0, 0];
  if (p !== undefined) {
    const px = p[0] ?? 0;
    const py = p[1] ?? 0;
    setAnim(node, 'x', mapAnim(size, (v) => round(px - Math.abs(v[0] ?? 0) / 2)), tm, ctx, (v) => v === 0);
    setAnim(node, 'y', mapAnim(size, (v) => round(py - Math.abs(v[1] ?? 0) / 2)), tm, ctx, (v) => v === 0);
    const sv = staticValue(size);
    return { node, ...(sv !== undefined ? { offset: { x: px - Math.abs(sv[0] ?? 0) / 2, y: py - Math.abs(sv[1] ?? 0) / 2 } } : {}) };
  }
  // Animierter Mittelpunkt: Hülle trägt die Position, die Form liegt zentriert darin.
  const wrapper: JsonNode = { id: `${id}-center`, type: 'group', origin: { x: 0, y: 0 } };
  if (pos !== undefined) {
    setAnim(wrapper, 'x', mapAnim(pos, (v) => round(v[0] ?? 0)), tm, ctx, (v) => v === 0);
    setAnim(wrapper, 'y', mapAnim(pos, (v) => round(v[1] ?? 0)), tm, ctx, (v) => v === 0);
  }
  setAnim(node, 'x', mapAnim(size, (v) => round(-Math.abs(v[0] ?? 0) / 2)), tm, ctx, (v) => v === 0);
  setAnim(node, 'y', mapAnim(size, (v) => round(-Math.abs(v[1] ?? 0) / 2)), tm, ctx, (v) => v === 0);
  return { node, wrapper };
}

function gradientPaint(item: Rec, offset: { x: number; y: number } | undefined, sc: ShapeCtx, path: string): Gradient | undefined {
  const { ctx } = sc;
  const g = rec(item, 'g');
  const count = g !== undefined ? num(g, 'p') : undefined;
  const values = g !== undefined ? readProp(g['k'], numbers, ctx, `${path}.g`) : undefined;
  const start = readProp(item['s'], vector, ctx, `${path}.s`);
  const end = readProp(item['e'], vector, ctx, `${path}.e`);
  if (count === undefined || values === undefined || start === undefined || end === undefined) return undefined;
  if (values.kind === 'keys' || start.kind === 'keys' || end.kind === 'keys') {
    warn(ctx, path, 'Animated gradients are not supported; the first keyframe is used.', 'Animate the node opacity or use two gradient layers instead.');
  }
  if (offset === undefined) warn(ctx, path, 'A gradient on a shape with animated position or size stays at its first position.', 'Keep the shape static or animate a parent group.');
  const flat = firstValue(values) ?? [];
  const s = firstValue(start) ?? [0, 0];
  const e = firstValue(end) ?? [0, 0];
  const alphas: { o: number; a: number }[] = [];
  for (let n = count * 4; n + 1 < flat.length; n += 2) alphas.push({ o: flat[n] ?? 0, a: flat[n + 1] ?? 1 });
  const alphaAt = (o: number): number => {
    const [first] = alphas;
    if (first === undefined) return 1;
    if (o <= first.o) return first.a;
    for (let n = 1; n < alphas.length; n++) {
      const a = alphas[n - 1];
      const b = alphas[n];
      if (a !== undefined && b !== undefined && o <= b.o) return b.o === a.o ? b.a : a.a + ((b.a - a.a) * (o - a.o)) / (b.o - a.o);
    }
    return alphas[alphas.length - 1]?.a ?? 1;
  };
  if (alphas.length > 0 && alphas.some((a) => !Array.from({ length: count }, (_, n) => flat[n * 4] ?? 0).includes(a.o))) {
    warn(ctx, path, 'Gradient opacity stops at other offsets than the color stops are approximated at the color stops.', 'Place opacity stops at the same offsets as color stops.');
  }
  let last = 0;
  const stops = Array.from({ length: count }, (_, n) => {
    const o = Math.max(last, Math.min(Math.max(flat[n * 4] ?? 0, 0), 1));
    last = o;
    return { offset: round(o), color: irColor({ r: flat[n * 4 + 1] ?? 0, g: flat[n * 4 + 2] ?? 0, b: flat[n * 4 + 3] ?? 0, a: alphaAt(o) }) };
  });
  if (stops.length < 2) return undefined;
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const point = (v: number[]) => ({ x: round((v[0] ?? 0) - ox), y: round((v[1] ?? 0) - oy) });
  if (num(item, 't') === 2) {
    if (!isZero(readProp(item['h'], scalar, ctx, `${path}.h`))) warn(ctx, path, 'Radial gradient highlight (focal offset) is not supported.', 'Set the highlight length to 0.');
    return { type: 'radial', stops, center: point(s), radius: round(Math.hypot((e[0] ?? 0) - (s[0] ?? 0), (e[1] ?? 0) - (s[1] ?? 0))), units: 'pixels' };
  }
  return { type: 'linear', stops, start: point(s), end: point(e), units: 'pixels' };
}

/** Setzt Farbe und Deckkraft eines Stils; liefert `false`, wenn der Stil nicht lesbar ist. */
function applyStyle(node: JsonNode, style: Rec, geo: Geometry, trims: readonly Rec[], sc: ShapeCtx, path: string): boolean {
  const { ctx, tm } = sc;
  const ty = str(style, 'ty');
  const opacity = readProp(style['o'], scalar, ctx, `${path}.o`);
  if (opacity !== undefined) setAnim(node, 'opacity', mapAnim(opacity, (v) => round(Math.min(Math.max(v / 100, 0), 1))), tm, ctx, (v) => v === 1);
  const isStroke = ty === 'st' || ty === 'gs';
  if (ty === 'fl' || ty === 'st') {
    const c = readProp(style['c'], color, ctx, `${path}.c`);
    if (c === undefined) return false;
    node[isStroke ? 'stroke' : 'fill'] = toIr(c, tm, ctx);
  } else {
    const gradient = gradientPaint(style, geo.offset, sc, path);
    if (gradient === undefined) return false;
    node[isStroke ? 'stroke' : 'fill'] = gradient;
  }
  if (!isStroke) {
    if (num(style, 'r') === 2 && node['type'] === 'path') node['fillRule'] = 'evenodd';
    if (trims.length > 0) warn(ctx, path, 'Trim paths on fills are not supported; the fill is drawn untrimmed.', 'Apply the trim to a stroke or mask the fill.');
    return true;
  }
  const w = readProp(style['w'], scalar, ctx, `${path}.w`);
  if (w !== undefined) setAnim(node, 'strokeWidth', mapAnim(w, (v) => round(Math.max(0, v))), tm, ctx, (v) => v === 1);
  const cap = num(style, 'lc');
  if (cap === 2) node['strokeCap'] = 'round';
  else if (cap === 3) node['strokeCap'] = 'square';
  const join = num(style, 'lj');
  if (join === 2) node['strokeJoin'] = 'round';
  else if (join === 3) node['strokeJoin'] = 'bevel';
  const dashes = records(style, 'd');
  if (dashes.length > 0) {
    const values: number[] = [];
    for (const d of dashes) {
      const v = readProp(d['v'], scalar, ctx, `${path}.d`);
      if (v?.kind === 'keys') warn(ctx, path, 'Animated dashes are not supported; the first value is used.', 'Keep dash lengths static.');
      const first = v !== undefined ? firstValue(v) : undefined;
      if (str(d, 'n') === 'o') {
        if (first !== undefined && first !== 0) warn(ctx, path, 'Dash offset is not supported; dashes start at 0.', 'Animate trimOffset instead.');
      } else if (first !== undefined) values.push(Math.max(0, round(first)));
    }
    if (values.length > 0) node['strokeDash'] = values.length % 2 === 1 ? [...values, ...values] : values;
  }
  const [trim] = trims;
  if (trim !== undefined) {
    if (trims.length > 1) warn(ctx, path, 'Several trim paths on one shape are not supported; the innermost one is used.', 'Combine the trims into one.');
    const ts = readProp(trim['s'], scalar, ctx, `${path}.tm.s`);
    const te = readProp(trim['e'], scalar, ctx, `${path}.tm.e`);
    const to = readProp(trim['o'], scalar, ctx, `${path}.tm.o`);
    if (ts !== undefined) setAnim(node, 'trimStart', mapAnim(ts, (v) => round(Math.min(Math.max(v / 100, 0), 1))), tm, ctx, (v) => v === 0);
    if (te !== undefined) setAnim(node, 'trimEnd', mapAnim(te, (v) => round(Math.min(Math.max(v / 100, 0), 1))), tm, ctx, (v) => v === 1);
    if (to !== undefined) setAnim(node, 'trimOffset', mapAnim(to, (v) => round(v / 360)), tm, ctx, (v) => v === 0);
  }
  return true;
}

const STYLE_TYPES = new Set(['fl', 'st', 'gf', 'gs']);
const GEOMETRY_TYPES = new Set(['rc', 'el', 'sh']);
const UNSUPPORTED_ITEMS: Readonly<Record<string, string>> = {
  sr: 'Polystar shapes',
  mm: 'Merge paths',
  rd: 'Round corners',
  rp: 'Repeaters',
  pb: 'Pucker/bloat',
  tw: 'Twist',
  zz: 'Zig zag',
  op: 'Offset paths',
};

/** Wandelt die Elemente einer Gruppe (`shapes` oder `it`) um. Reihenfolge: unten zuerst. */
function convertItems(items: readonly Rec[], inheritedStyles: readonly Rec[], inheritedTrims: readonly Rec[], sc: ShapeCtx, path: string): JsonNode[] {
  const { ctx } = sc;
  const visible = items.map((item, index) => ({ item, index })).filter(({ item }) => item['hd'] !== true);
  const out: JsonNode[] = [];
  for (let n = visible.length - 1; n >= 0; n--) {
    const entry = visible[n];
    if (entry === undefined) continue;
    const { item, index } = entry;
    const ty = str(item, 'ty') ?? '';
    const itemPath = `${path}[${String(index)}:${ty}${typeof item['nm'] === 'string' ? ` "${item['nm']}"` : ''}]`;
    const later = visible.slice(n + 1).map((e) => e.item);
    const styles = [...later.filter((i) => STYLE_TYPES.has(str(i, 'ty') ?? '')), ...inheritedStyles];
    const trims = [...later.filter((i) => str(i, 'ty') === 'tm'), ...inheritedTrims];
    const unsupported = UNSUPPORTED_ITEMS[ty];
    if (unsupported !== undefined) {
      warn(ctx, itemPath, `${unsupported} are not supported and were skipped.`, 'Convert the effect to plain paths in the animation tool before exporting.');
      continue;
    }
    if (ty === 'gr') {
      const inner = records(item, 'it');
      const tr = inner.find((i) => str(i, 'ty') === 'tr');
      const content = convertItems(
        inner.filter((i) => str(i, 'ty') !== 'tr'),
        styles,
        trims,
        sc,
        itemPath,
      );
      if (content.length === 0) continue;
      const groups = transformGroups(tr, sc.tm, ctx, `${itemPath}.tr`, ctx.ids.claim(str(item, 'nm'), 'group'), true);
      out.push(wrap(groups, content));
      continue;
    }
    if (!GEOMETRY_TYPES.has(ty)) {
      if (!STYLE_TYPES.has(ty) && ty !== 'tm' && ty !== 'tr') warn(ctx, itemPath, `Shape item "${ty}" is not supported and was skipped.`, 'Use rectangles, ellipses and paths.');
      continue;
    }
    if (styles.length === 0) continue;
    // Stile weiter unten in der Liste liegen unten: zuerst zeichnen.
    for (let s = styles.length - 1; s >= 0; s--) {
      const style = styles[s];
      if (style === undefined || style['hd'] === true) continue;
      const id = ctx.ids.claim(str(item, 'nm'), ty === 'sh' ? 'path' : ty === 'rc' ? 'rect' : 'ellipse');
      const geo = geometry(item, sc, itemPath, id);
      if (geo === undefined) {
        warn(ctx, itemPath, 'The shape has no readable geometry and was skipped.', 'Check the exported shape data.');
        break;
      }
      const node = { ...geo.node };
      if (!applyStyle(node, style, geo, trims, sc, `${itemPath}.${str(style, 'ty') ?? ''}`)) {
        warn(ctx, itemPath, `Style "${str(style, 'ty') ?? ''}" has no readable color and was skipped.`, 'Check the exported fill or stroke data.');
        continue;
      }
      out.push(geo.wrapper !== undefined ? { ...geo.wrapper, id: `${id}-center`, children: [node] } : node);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

function layerPath(layer: Rec, parent: string): string {
  return `${parent}.layers[${String(num(layer, 'ind') ?? '?')}${typeof layer['nm'] === 'string' ? ` "${layer['nm']}"` : ''}]`;
}

/** Inhalt eines Layers in dessen lokaler Zeit. */
function layerContent(layer: Rec, ctx: LCtx, tm: TimeMap, path: string, childOffset: number): JsonNode[] | undefined {
  const ty = num(layer, 'ty');
  const sc: ShapeCtx = { ctx, tm };
  switch (ty) {
    case 4:
      return convertItems(records(layer, 'shapes'), [], [], sc, `${path}.shapes`);
    case 1: {
      const w = num(layer, 'sw') ?? 0;
      const h = num(layer, 'sh') ?? 0;
      const fill = parseSolid(str(layer, 'sc'));
      return [{ id: ctx.ids.next('solid'), type: 'rect', width: w, height: h, fill }];
    }
    case 0: {
      const refId = str(layer, 'refId') ?? '';
      const asset = ctx.lottieAssets.get(refId);
      if (asset === undefined || ctx.precompStack.has(refId)) {
        warn(ctx, path, `Precomp "${refId}" is missing or circular and was skipped.`, 'Export the animation with all precomps.');
        return [];
      }
      ctx.precompStack.add(refId);
      const children = convertLayers(records(asset, 'layers'), ctx, childOffset, `${path}.precomp`);
      ctx.precompStack.delete(refId);
      const w = num(layer, 'w');
      const h = num(layer, 'h');
      if (children.length === 0) return [];
      return w !== undefined && h !== undefined ? [{ id: ctx.ids.next('precomp'), type: 'group', width: w, height: h, clip: true, children }] : children;
    }
    case 3:
      return [];
    case 2: {
      const asset = ctx.lottieAssets.get(str(layer, 'refId') ?? '');
      const p = asset !== undefined ? str(asset, 'p') : undefined;
      const data = p?.startsWith('data:') === true ? parseDataUri(p) : undefined;
      const info = data !== undefined ? mimeInfo(data.mime) : undefined;
      if (asset === undefined || data === undefined || info?.type !== 'image') {
        warn(ctx, path, 'Only embedded (data URI) images can be imported; the image layer was skipped.', 'Export the Lottie file with embedded images or import the image as an asset.');
        return [];
      }
      const id = ctx.ids.next('image');
      ctx.assets.push(makeAsset(`${id}-asset`, 'image', info.ext, data.bytes));
      return [{ id, type: 'image', asset: `${id}-asset`, width: num(asset, 'w') ?? 0, height: num(asset, 'h') ?? 0, fit: 'fill' }];
    }
    case 5:
      return textLayer(layer, ctx, path);
    default:
      warn(ctx, path, `Layer type ${String(ty)} is not supported and was skipped.`, 'Use shape, solid, image, text, null or precomp layers.');
      return undefined;
  }
}

function parseSolid(sc: string | undefined): string {
  const hex = /^#([0-9a-fA-F]{6})$/u.exec(sc ?? '')?.[1];
  return hex !== undefined ? `#${hex.toUpperCase()}` : '#000000';
}

function textLayer(layer: Rec, ctx: LCtx, path: string): JsonNode[] {
  const t = rec(layer, 't');
  const d = t !== undefined ? rec(t, 'd') : undefined;
  const keys = d !== undefined ? records(d, 'k') : [];
  const doc = keys[0] !== undefined ? rec(keys[0], 's') : undefined;
  if (t === undefined || doc === undefined) {
    warn(ctx, path, 'The text layer has no readable document and was skipped.', 'Check the exported text data.');
    return [];
  }
  if (keys.length > 1) warn(ctx, path, 'Animated text documents are not supported; the first document is used.', 'Split the text changes into separate layers.');
  if (list(t, 'a').length > 0) warn(ctx, path, 'Text animators are not supported and were ignored.', 'Use the IR textAnimation property after import.');
  if (t['p'] !== undefined && isRecord(t['p']) && Object.keys(t['p']).length > 0) warn(ctx, path, 'Text on a path is not supported.', 'Use the IR textPath property after import.');
  warn(ctx, path, 'Lottie positions text at the baseline; the IR positions the top of the line. The baseline was approximated at 0.9 × font size.', 'Check the vertical text position after import.');
  const size = num(doc, 's') ?? 48;
  const text = (str(doc, 't') ?? '').replace(/\r/gu, '\n');
  const node: JsonNode = { id: ctx.ids.next('text'), type: 'text', text, fontSize: size, lineHeight: 1.2, y: round(-0.9 * size) };
  const font = str(doc, 'f');
  if (font !== undefined) node['fontFamily'] = ctx.fonts.get(font) ?? font;
  const fc = color(doc['fc']);
  if (fc !== undefined) node['fill'] = fc;
  const lh = num(doc, 'lh');
  if (lh !== undefined && size > 0) node['lineHeight'] = round(lh / size, 4);
  const tracking = num(doc, 'tr');
  if (tracking !== undefined && tracking !== 0) node['letterSpacing'] = round((tracking / 1000) * size);
  const justify = num(doc, 'j');
  if (justify === 1 || justify === 2) {
    const wide = 4000;
    node['width'] = wide;
    node['textAlign'] = justify === 2 ? 'center' : 'right';
    node['x'] = justify === 2 ? -wide / 2 : -wide;
  }
  return [node];
}

/**
 * Wandelt eine Layer-Liste um. `offset` (Frames): Lottie-Zeit des Containers = lokale IR-Zeit + offset.
 * Lottie zeichnet den ersten Layer oben; die IR zeichnet später oben. Daher wird umgekehrt.
 */
function convertLayers(layers: readonly Rec[], ctx: LCtx, offset: number, path: string): JsonNode[] {
  const byInd = new Map<number, Rec>();
  for (const l of layers) {
    const ind = num(l, 'ind');
    if (ind !== undefined) byInd.set(ind, l);
  }
  const out: JsonNode[] = [];
  for (let n = layers.length - 1; n >= 0; n--) {
    const layer = layers[n];
    if (layer === undefined) continue;
    const node = convertLayer(layer, byInd, ctx, offset, path);
    if (node !== undefined) out.push(node);
  }
  return out;
}

function convertLayer(layer: Rec, byInd: ReadonlyMap<number, Rec>, ctx: LCtx, offset: number, parentPath: string): JsonNode | undefined {
  const path = layerPath(layer, parentPath);
  if (layer['hd'] === true) return undefined;
  if (num(layer, 'td') === 1) {
    warn(ctx, path, 'Track matte source layers are not supported; the matte layer was skipped.', 'Use a clip or mask on the imported node instead.');
    return undefined;
  }
  if (num(layer, 'tt') !== undefined) warn(ctx, path, 'Track mattes are not supported; the layer is drawn without its matte.', 'Set `mask` on the imported node manually.');
  if (layer['hasMask'] === true || list(layer, 'masksProperties').length > 0) warn(ctx, path, 'Layer masks are not supported; the layer is drawn unmasked.', 'Set `mask` on the imported node manually.');
  if (list(layer, 'ef').length > 0) warn(ctx, path, 'Layer effects are not supported and were ignored.', 'Rebuild the effect with IR filters or layer effects.');
  if (num(layer, 'ddd') === 1) warn(ctx, path, '3D layers are imported as 2D layers.', 'Use a scene3d node for 3D content.');
  if (num(layer, 'ao') === 1) warn(ctx, path, 'Auto-orient is not supported; the layer keeps its rotation.', 'Animate the rotation explicitly.');
  if (layer['tm'] !== undefined) warn(ctx, path, 'Time remapping is not supported; the layer plays at normal speed.', 'Use the IR timing.remap property after import.');
  const ip = num(layer, 'ip') ?? 0;
  const op = num(layer, 'op') ?? ip;
  const st = num(layer, 'st') ?? 0;
  const sr = num(layer, 'sr') ?? 1;
  const own: TimeMap = { scale: 1, offset: -(ip - st) / sr };
  const content = layerContent(layer, ctx, own, path, (ip - st) / sr);
  if (content === undefined) return undefined;
  // Null-Layer ohne Inhalt zeichnen nichts; sie wirken nur als Eltern (siehe unten).
  if (content.length === 0) return undefined;
  const id = ctx.ids.claim(str(layer, 'nm'), 'layer');
  const groups = transformGroups(rec(layer, 'ks'), own, ctx, `${path}.ks`, id, true);
  const node = wrap(groups, content);
  node['timing'] = { from: seconds((ip - offset) / ctx.fr), duration: seconds((op - ip) / ctx.fr), ...(sr !== 1 && sr > 0 ? { speed: round(1 / sr) } : {}) };
  const bm = num(layer, 'bm');
  if (bm !== undefined && bm > 0) {
    const mode = [...BLEND_MODES][bm];
    if (mode !== undefined) node['blendMode'] = mode;
    else warn(ctx, path, `Blend mode ${String(bm)} is not supported; "normal" is used.`, 'Use a standard blend mode.');
  }
  // Parenting: Eltern-Transformationen (ohne Deckkraft) als äußere Hüllen, außen beginnend.
  let result = node;
  const seen = new Set<Rec>([layer]);
  let parentInd = num(layer, 'parent');
  while (parentInd !== undefined) {
    const parent = byInd.get(parentInd);
    if (parent === undefined || seen.has(parent)) {
      warn(ctx, path, `Parent layer ${String(parentInd)} is missing or circular; parenting was ignored from here on.`, 'Export the animation with all parent layers.');
      break;
    }
    seen.add(parent);
    const pst = num(parent, 'st') ?? 0;
    const psr = num(parent, 'sr') ?? 1;
    const parentMap: TimeMap = { scale: psr, offset: pst - offset };
    const groups2 = transformGroups(rec(parent, 'ks'), parentMap, ctx, `${layerPath(parent, parentPath)}.ks`, ctx.ids.next('parent'), false);
    result = wrap(groups2, [result]);
    parentInd = num(parent, 'parent');
  }
  return result;
}

function parseJson(input: string | object): Rec {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      throw importError('OV_IMPORT_PARSE', `The Lottie file is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`, 'Pass the exported .json file content.');
    }
  }
  if (!isRecord(data) || typeof data['w'] !== 'number' || typeof data['h'] !== 'number' || typeof data['fr'] !== 'number' || data['fr'] <= 0) {
    throw importError('OV_IMPORT_PARSE', 'The Lottie file needs numeric "w", "h" and "fr".', 'Pass a Lottie (Bodymovin) JSON export.');
  }
  return data;
}

/**
 * Importiert eine Lottie-Animation.
 *
 * - `embed`: eine `lottie`-Node mit Asset (verlustfrei, Wiedergabe durch den Lottie-Renderer).
 * - `native`: IR-Gruppen und -Formen mit `$keyframes`; Verluste erzeugen `OV_IMPORT_LOSSY`.
 *
 * Zeiten in `$keyframes` und `timing` sind Sekunden; Lottie-Frame `ip` entspricht IR-Zeit 0.
 *
 * @example
 * ```ts
 * const { nodes, assets, diagnostics } = importLottie(json, { mode: 'native', idPrefix: 'intro' });
 * ```
 */
export function importLottie(input: string | object, options: LottieImportOptions): NodeImportResult {
  const data = parseJson(input);
  const prefix = options.idPrefix ?? 'lottie';
  const w = num(data, 'w') ?? 0;
  const h = num(data, 'h') ?? 0;
  const fr = num(data, 'fr') ?? 30;
  const ip = num(data, 'ip') ?? 0;
  const op = num(data, 'op') ?? ip;
  if (options.mode === 'embed') {
    const assetId = options.assetId ?? `${prefix}-asset`;
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const asset = makeAsset(assetId, 'lottie', 'json', new TextEncoder().encode(text), { width: w, height: h, fps: fr, frames: op - ip });
    return { nodes: [{ id: prefix, type: 'lottie', asset: assetId, width: w, height: h }], assets: [asset], diagnostics: [] };
  }
  const ids = new IdAllocator(prefix);
  const rootId = ids.exact(prefix, 'root');
  const lottieAssets = new Map<string, Rec>();
  for (const a of records(data, 'assets')) {
    const id = str(a, 'id');
    if (id !== undefined) lottieAssets.set(id, a);
  }
  const fonts = new Map<string, string>();
  const fontList = rec(data, 'fonts');
  for (const f of fontList !== undefined ? records(fontList, 'list') : []) {
    const name = str(f, 'fName');
    const family = str(f, 'fFamily');
    if (name !== undefined && family !== undefined) fonts.set(name, family);
  }
  const ctx: LCtx = { fr, ids, diagnostics: [], assets: [], lottieAssets, fonts, precompStack: new Set() };
  if (list(data, 'markers').length > 0) warn(ctx, 'lottie.markers', 'Lottie markers are not imported.', 'Add composition markers with the same times manually.');
  const children = convertLayers(records(data, 'layers'), ctx, ip, 'lottie');
  const root: JsonNode = { id: rootId, type: 'group', width: w, height: h, clip: true, timing: { duration: seconds((op - ip) / fr) }, children };
  return { nodes: [root], assets: ctx.assets, diagnostics: ctx.diagnostics };
}
