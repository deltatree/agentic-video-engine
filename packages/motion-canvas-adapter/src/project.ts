/**
 * Szenen und Umwandlung in ein IR-Project.
 *
 * Koordinaten: Motion Canvas hat den Ursprung in der Bildmitte (y nach unten) und verankert
 * Knoten in ihrer Mitte. Jede Szene wird eine Gruppe in der Bildmitte; jeder Knoten wird eine
 * Gruppe an seiner Position (Rotation und Skalierung um diesen Punkt), die Form liegt zentriert darin.
 */
import { OpenVideoError, SCHEMA_VERSION, type Diagnostic } from '@agentic-video/core';
import { Circle, Img, Line, Node, Rect, Txt, View2D } from './nodes.js';
import { execute, Runtime, type Segment, type ThreadGenerator } from './runtime.js';

/** Eine Szene: Name und Generator-Funktion. */
export interface Scene {
  readonly name: string;
  readonly generator: (view: View2D) => ThreadGenerator;
}

/**
 * Definiert eine Szene wie `makeScene2D` in Motion Canvas.
 *
 * @example
 * ```ts
 * const intro = makeScene('intro', function* (view) {
 *   const rect = new Rect({ width: 200, height: 100, fill: '#e13238' });
 *   view.add(rect);
 *   yield* all(rect.x(300, 1), rect.opacity(0, 1));
 * });
 * ```
 */
export function makeScene(name: string, generator: (view: View2D) => ThreadGenerator): Scene {
  return { name, generator };
}

/** Optionen für {@link toProject}. */
export interface ToProjectOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** Composition-ID (Standard `main`). */
  readonly id?: string;
  readonly background?: string;
  /** Wartezeit je `waitUntil`-Event in Sekunden (Standard 0). */
  readonly events?: Readonly<Record<string, number>>;
}

/** Ergebnis von {@link toProject}. */
export interface ToProjectResult {
  readonly project: Record<string, unknown>;
  readonly diagnostics: Diagnostic[];
}

type JsonNode = Record<string, unknown>;

interface Key {
  readonly t: number;
  readonly v: unknown;
  readonly ease?: string;
}

function fmt(n: number, digits = 6): number {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function seconds(s: number): string {
  return `${String(fmt(s))}s`;
}

/** Baut Keyframes aus Anfangswert und Segmenten (Zeiten in Sekunden). */
function keysOf(initial: unknown, segments: readonly Segment[]): Key[] {
  const keys: Key[] = [{ t: 0, v: initial }];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const s of segments) {
    const last = keys[keys.length - 1];
    if (last === undefined) continue;
    if (s.set) {
      // Setzen: bis zum Zeitpunkt halten, dann springen.
      if (Math.abs(last.t - s.start) < 1e-9 && (keys.length === 1 || last.ease === 'hold')) keys[keys.length - 1] = { ...last, v: s.to };
      else keys.push({ t: s.start, v: s.to, ease: 'hold' });
      continue;
    }
    if (last.t < s.start - 1e-9 || !same(last.v, s.from)) keys.push({ t: s.start, v: s.from, ...(keys.length > 0 ? { ease: 'hold' } : {}) });
    keys.push({ t: s.end, v: s.to, ease: s.ease });
  }
  // Erster Keyframe braucht kein Easing.
  const [first, ...rest] = keys;
  return first === undefined ? [] : [{ t: first.t, v: first.v }, ...rest];
}

function toIr(keys: readonly Key[], map: (v: unknown) => unknown = (v) => v): unknown {
  const mapped = keys.map((k) => ({ ...k, v: map(k.v) }));
  const [first] = mapped;
  if (first === undefined) return undefined;
  if (mapped.every((k) => JSON.stringify(k.v) === JSON.stringify(first.v))) return first.v;
  return { $keyframes: mapped.map((k) => ({ t: seconds(k.t), v: k.v, ...(k.ease !== undefined ? { ease: k.ease } : {}) })) };
}

interface Ctx {
  readonly rt: Runtime;
  readonly width: number;
  readonly assets: Record<string, unknown>[];
}

function keysFor(node: Node, prop: string, ctx: Ctx): Key[] {
  return keysOf(node.initial.get(prop), ctx.rt.segments.get(`${node.id}\u0000${prop}`) ?? []);
}

function isAnimated(keys: readonly Key[]): boolean {
  const [first] = keys;
  return first !== undefined && keys.some((k) => JSON.stringify(k.v) !== JSON.stringify(first.v));
}

/** Setzt eine Property, wenn sie vom Standard abweicht. */
function put(target: JsonNode, key: string, value: unknown, isDefault: (v: unknown) => boolean = () => false): void {
  if (value !== undefined && !isDefault(value)) target[key] = value;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function paint(shape: JsonNode, node: Node, ctx: Ctx, stroked: boolean): void {
  const fill = keysFor(node, 'fill', ctx);
  const stroke = keysFor(node, 'stroke', ctx);
  const hasFill = fill.some((k) => k.v !== undefined);
  const hasStroke = stroke.some((k) => k.v !== undefined);
  // Fehlende Farbe = unsichtbar (wie in Motion Canvas), nicht das IR-Standardweiß.
  if (hasFill) put(shape, 'fill', toIr(fill, (v) => v ?? 'transparent'));
  if (hasStroke && stroked) {
    put(shape, 'stroke', toIr(stroke, (v) => v ?? 'transparent'));
    put(shape, 'strokeWidth', toIr(keysFor(node, 'lineWidth', ctx), (v) => Math.max(0, num(v))));
  }
  if (!hasFill && !(hasStroke && stroked)) shape[shape['type'] === 'polyline' ? 'stroke' : 'fill'] = 'transparent';
}

function shapeOf(node: Node, ctx: Ctx): JsonNode | undefined {
  const id = `${node.id}-shape`;
  const width = keysFor(node, 'width', ctx);
  const height = keysFor(node, 'height', ctx);
  const half = (v: unknown) => fmt(-num(v) / 2);
  if (node instanceof Rect || node instanceof Circle) {
    const shape: JsonNode = { id, type: node instanceof Rect ? 'rect' : 'ellipse' };
    shape['width'] = toIr(width, (v) => Math.max(0, num(v)));
    shape['height'] = toIr(height, (v) => Math.max(0, num(v)));
    put(shape, 'x', toIr(width, half), (v) => v === 0);
    put(shape, 'y', toIr(height, half), (v) => v === 0);
    if (node instanceof Rect) put(shape, 'cornerRadius', toIr(keysFor(node, 'radius', ctx), (v) => Math.max(0, num(v))), (v) => v === 0);
    paint(shape, node, ctx, true);
    return shape;
  }
  if (node instanceof Img) {
    const src = node.initial.get('src');
    if (typeof src !== 'string' || src.length === 0) {
      ctx.rt.diagnostics.push(lossyDiag(node, 'src', 'Img without src was skipped.', 'Set src to an image path.'));
      return undefined;
    }
    const assetId = `${node.id}-asset`;
    ctx.assets.push({ id: assetId, type: 'image', src });
    const shape: JsonNode = { id, type: 'image', asset: assetId, fit: 'fill' };
    if (!isAnimated(width) && num(width[0]?.v) === 0) {
      ctx.rt.diagnostics.push(lossyDiag(node, 'size', 'Img without width and height cannot be centered; its top-left corner sits at the position.', 'Give the Img an explicit width and height.'));
      return shape;
    }
    shape['width'] = toIr(width, (v) => Math.max(0, num(v)));
    shape['height'] = toIr(height, (v) => Math.max(0, num(v)));
    put(shape, 'x', toIr(width, half), (v) => v === 0);
    put(shape, 'y', toIr(height, half), (v) => v === 0);
    return shape;
  }
  if (node instanceof Txt) {
    const text = keysFor(node, 'text', ctx);
    const size = keysFor(node, 'fontSize', ctx);
    const lines = Math.max(1, ...text.map((k) => (typeof k.v === 'string' ? k.v.split('\n').length : 1)));
    if (text.some((k) => typeof k.v === 'string' && k.v.split('\n').length !== lines)) {
      ctx.rt.diagnostics.push(lossyDiag(node, 'text', 'The line count of the text changes over time; vertical centering uses the largest line count.', 'Keep the number of lines constant or animate y.'));
    }
    // Breite Box mit zentrierter Ausrichtung ersetzt die Mitte-Verankerung, ohne umzubrechen.
    const wide = 4 * ctx.width;
    const shape: JsonNode = { id, type: 'text', text: toIr(text), width: wide, textAlign: 'center', x: -wide / 2, lineHeight: 1.2 };
    put(shape, 'fontSize', toIr(size));
    put(shape, 'y', toIr(size, (v) => fmt((-num(v) * 1.2 * lines) / 2)));
    const family = node.initial.get('fontFamily');
    if (typeof family === 'string') shape['fontFamily'] = family;
    put(shape, 'fontWeight', toIr(keysFor(node, 'fontWeight', ctx)));
    const fill = keysFor(node, 'fill', ctx);
    if (fill.some((k) => k.v !== undefined)) put(shape, 'fill', toIr(fill, (v) => v ?? 'transparent'));
    const stroke = keysFor(node, 'stroke', ctx);
    if (stroke.some((k) => k.v !== undefined)) {
      put(shape, 'stroke', toIr(stroke, (v) => v ?? 'transparent'));
      put(shape, 'strokeWidth', toIr(keysFor(node, 'lineWidth', ctx), (v) => Math.max(0, num(v))));
    }
    return shape;
  }
  if (node instanceof Line) {
    const pts = keysFor(node, 'points', ctx);
    if (pts.every((k) => k.v === undefined)) {
      ctx.rt.diagnostics.push(lossyDiag(node, 'points', 'Line without points was skipped.', 'Give the Line at least two points.'));
      return undefined;
    }
    const shape: JsonNode = { id, type: 'polyline', points: toIr(pts.filter((k) => k.v !== undefined)) };
    paint(shape, node, ctx, true);
    if (shape['fill'] !== undefined && shape['fill'] !== 'transparent') {
      ctx.rt.diagnostics.push(lossyDiag(node, 'fill', 'Filled lines are drawn as open polylines.', 'Use a stroke for lines.'));
    }
    put(shape, 'trimStart', toIr(keysFor(node, 'start', ctx), (v) => Math.min(Math.max(num(v), 0), 1)), (v) => v === 0);
    put(shape, 'trimEnd', toIr(keysFor(node, 'end', ctx), (v) => Math.min(Math.max(num(v), 0), 1)), (v) => v === 1);
    return shape;
  }
  return undefined;
}

function lossyDiag(node: Node, prop: string, problem: string, suggestion: string): Diagnostic {
  return { code: 'OV_IMPORT_LOSSY', severity: 'warning', errorClass: 'MotionCanvasAdapterError', problem, path: `${node.id}.${prop}`, nodeId: node.id, suggestions: [suggestion] };
}

function nodeToIr(node: Node, ctx: Ctx, seen: Set<Node>): JsonNode {
  if (seen.has(node)) {
    throw new OpenVideoError({ code: 'OV_MC_CYCLE', errorClass: 'MotionCanvasAdapterError', problem: `Node "${node.id}" is added twice or contains itself.`, suggestions: ['Add every node only once.'] });
  }
  seen.add(node);
  const group: JsonNode = { id: node.id, type: 'group', origin: { x: 0, y: 0 } };
  put(group, 'x', toIr(keysFor(node, 'x', ctx)), (v) => v === 0);
  put(group, 'y', toIr(keysFor(node, 'y', ctx)), (v) => v === 0);
  put(group, 'rotation', toIr(keysFor(node, 'rotation', ctx)), (v) => v === 0);
  put(group, 'scale', toIr(keysFor(node, 'scale', ctx)), (v) => JSON.stringify(v) === '{"x":1,"y":1}');
  put(group, 'opacity', toIr(keysFor(node, 'opacity', ctx), (v) => Math.min(Math.max(num(v), 0), 1)), (v) => v === 1);
  const shape = shapeOf(node, ctx);
  const children = [...(shape !== undefined ? [shape] : []), ...node.children.map((c) => nodeToIr(c, ctx, seen))];
  if (children.length > 0) group['children'] = children;
  return group;
}

function sceneId(name: string, used: Set<string>): string {
  const base = /^[A-Za-z]/u.test(name) ? name.replace(/[^A-Za-z0-9_-]/gu, '_') : `scene_${name.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${String(n)}`;
  used.add(id);
  return id;
}

/**
 * Führt die Szenen symbolisch aus und baut ein IR-Project. Szenen laufen nacheinander;
 * jede wird eine Gruppe mit `timing`. `waitUntil`-Events werden Composition-Marker.
 *
 * @example
 * ```ts
 * const { project, diagnostics } = toProject([intro, outro], { width: 1920, height: 1080, fps: 30 });
 * ```
 */
export function toProject(scenes: readonly Scene[], options: ToProjectOptions): ToProjectResult {
  const diagnostics: Diagnostic[] = [];
  const nodes: JsonNode[] = [];
  const markers: Record<string, unknown>[] = [];
  const assets: Record<string, unknown>[] = [];
  const usedScenes = new Set<string>();
  const usedMarkers = new Set<string>();
  let offset = 0;
  for (const scene of scenes) {
    const id = sceneId(scene.name, usedScenes);
    const rt = new Runtime(id, options.fps, options.events ?? {});
    const view = new View2D();
    const duration = execute(rt, scene.generator(view));
    const length = Math.max(duration, 1 / options.fps);
    const ctx: Ctx = { rt, width: options.width, assets };
    const seen = new Set<Node>();
    const children = view.children.map((n) => nodeToIr(n, ctx, seen));
    nodes.push({
      id,
      type: 'group',
      name: scene.name,
      x: options.width / 2,
      y: options.height / 2,
      origin: { x: 0, y: 0 },
      timing: { from: seconds(offset), duration: seconds(length) },
      ...(children.length > 0 ? { children } : {}),
    });
    for (const event of rt.events) {
      let markerId = event.name.replace(/[^A-Za-z0-9_-]/gu, '_');
      if (!/^[A-Za-z]/u.test(markerId)) markerId = `event_${markerId}`;
      for (let n = 2; usedMarkers.has(markerId); n++) markerId = `${markerId.replace(/-\d+$/u, '')}-${String(n)}`;
      usedMarkers.add(markerId);
      markers.push({ id: markerId, time: seconds(offset + event.time), label: event.name, kind: 'event' });
    }
    diagnostics.push(...rt.diagnostics);
    offset += length;
  }
  const composition: Record<string, unknown> = {
    id: options.id ?? 'main',
    width: options.width,
    height: options.height,
    fps: options.fps,
    duration: seconds(Math.max(offset, 1 / options.fps)),
    ...(options.background !== undefined ? { background: options.background } : {}),
    ...(markers.length > 0 ? { markers } : {}),
    nodes,
  };
  const project: Record<string, unknown> = { schemaVersion: SCHEMA_VERSION, metadata: { createdWith: '@agentic-video/motion-canvas-adapter' }, compositions: [composition], ...(assets.length > 0 ? { assets } : {}) };
  return { project, diagnostics };
}
