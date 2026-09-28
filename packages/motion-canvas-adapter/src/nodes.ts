/**
 * Knoten-Fabriken wie in Motion Canvas (`Node`, `Rect`, `Circle`, `Txt`, `Line`, `Img`)
 * mit Signal-Eigenschaften: `node.x()` liest, `node.x(300)` setzt sofort,
 * `node.x(300, 1, easeInOutCubic)` liefert einen Tween-Task.
 */
import { isRecord, type Diagnostic } from '@agentic-video/core';
import { runtime, type ThreadGenerator } from './runtime.js';
import { easeInOutCubic, easingName, type TimingFunction } from './timing.js';

/** Vektor-Eingabe wie in Motion Canvas: Zahl (beide Achsen), `[x, y]` oder `{ x, y }`. */
export type PossibleVector2 = number | readonly [number, number] | { readonly x: number; readonly y: number };

/** Ein 2D-Vektor. */
export interface Vector2 {
  readonly x: number;
  readonly y: number;
}

/** Signal wie in Motion Canvas. */
export interface Signal<TIn, TOut> {
  /** Liest den Wert zur aktuellen Szenenzeit. */
  (): TOut;
  /** Setzt den Wert sofort. */
  (value: TIn): Node;
  /** Liefert einen Tween-Task über `duration` Sekunden (Standard-Easing `easeInOutCubic`). */
  (value: TIn, duration: number, timing?: TimingFunction): ThreadGenerator;
}

/** Vektor-Signal mit Teil-Signalen `.x` und `.y`. */
export type Vector2Signal = Signal<PossibleVector2, Vector2> & { readonly x: Signal<number, number>; readonly y: Signal<number, number> };

/** Gemeinsame Eigenschaften aller Knoten. */
export interface NodeProps {
  /** Stabiler Schlüssel; wird Teil der Node-ID. */
  readonly key?: string;
  readonly x?: number;
  readonly y?: number;
  readonly position?: PossibleVector2;
  readonly rotation?: number;
  readonly scale?: PossibleVector2;
  readonly opacity?: number;
  readonly children?: readonly Node[];
  readonly [prop: string]: unknown;
}

export function toVector(v: unknown): Vector2 | undefined {
  if (typeof v === 'number') return { x: v, y: v };
  if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number') return { x: v[0], y: v[1] };
  if (isRecord(v) && typeof v['x'] === 'number' && typeof v['y'] === 'number') return { x: v['x'], y: v['y'] };
  return undefined;
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000',
  white: '#FFFFFF',
  red: '#FF0000',
  green: '#008000',
  lime: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  cyan: '#00FFFF',
  aqua: '#00FFFF',
  magenta: '#FF00FF',
  fuchsia: '#FF00FF',
  orange: '#FFA500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#C0C0C0',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  teal: '#008080',
  pink: '#FFC0CB',
  transparent: 'transparent',
};

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
}

/** Normalisiert eine CSS-Farbe auf eine IR-Farbe; `undefined` bei Unbekanntem. */
export function toColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  const named = NAMED_COLORS[t];
  if (named !== undefined) return named;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(t)?.[1];
  if (hex !== undefined) {
    const full = (hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex).toUpperCase();
    return full.length === 8 && full.endsWith('FF') ? `#${full.slice(0, 6)}` : `#${full}`;
  }
  const rgb = /^rgba?\(([^)]*)\)$/u.exec(t);
  if (rgb === null) return undefined;
  const parts = (rgb[1] ?? '').split(/[\s,/]+/u).filter((p) => p.length > 0).map(Number);
  if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return undefined;
  const [r = 0, g = 0, b = 0, a = 1] = parts;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a >= 1 ? '' : hex2(a * 255)}`;
}

/** Beschreibung einer Signal-Property: IR-Name, Normalisierung, Standardwert. */
interface PropSpec {
  readonly normalize: (v: unknown) => unknown;
  readonly fallback: unknown;
}

const num = (v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): unknown => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const vec = (v: unknown): unknown => toVector(v);
const points = (v: unknown): unknown => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(toVector).filter((p): p is Vector2 => p !== undefined).map((p) => [p.x, p.y]);
  return out.length === v.length && out.length >= 2 ? out : undefined;
};

const BASE_PROPS: Readonly<Record<string, PropSpec>> = {
  x: { normalize: num, fallback: 0 },
  y: { normalize: num, fallback: 0 },
  rotation: { normalize: num, fallback: 0 },
  scale: { normalize: vec, fallback: { x: 1, y: 1 } },
  opacity: { normalize: num, fallback: 1 },
};

const SHAPE_PROPS: Readonly<Record<string, PropSpec>> = {
  fill: { normalize: toColor, fallback: undefined },
  stroke: { normalize: toColor, fallback: undefined },
  lineWidth: { normalize: num, fallback: 0 },
};

const asNumber = (fallback: number) => (v: unknown): number => (typeof v === 'number' ? v : fallback);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asOptionalString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asVector = (v: unknown): Vector2 => toVector(v) ?? { x: 1, y: 1 };
const asPoints = (v: unknown): number[][] => (Array.isArray(v) ? v.map((p) => toVector(p)).filter((p): p is Vector2 => p !== undefined).map((p) => [p.x, p.y]) : []);

/** Motion-Canvas-Knoten `Node`: eine Gruppe mit Transform. Mittelpunkt ist die Position. */
export class Node {
  readonly id: string;
  readonly kind: string;
  readonly children: Node[] = [];
  /** Werte zu Szenenbeginn (nach dem Konstruktor). */
  readonly initial = new Map<string, unknown>();
  /** Normalisierung je Property. */
  readonly specs = new Map<string, PropSpec>();
  readonly x: Signal<number, number>;
  readonly y: Signal<number, number>;
  readonly position: Vector2Signal;
  readonly rotation: Signal<number, number>;
  readonly scale: Vector2Signal;
  readonly opacity: Signal<number, number>;

  constructor(props: NodeProps = {}, kind = 'node', extra: Readonly<Record<string, PropSpec>> = {}) {
    const rt = runtime();
    this.kind = kind;
    this.id = rt.nodeId(kind, typeof props.key === 'string' ? props.key : undefined);
    for (const [k, spec] of Object.entries({ ...BASE_PROPS, ...extra })) {
      this.specs.set(k, spec);
      this.initial.set(k, spec.fallback);
    }
    this.x = makeSignal(this, 'x', asNumber(0));
    this.y = makeSignal(this, 'y', asNumber(0));
    this.position = Object.assign(makeVectorSignal(this, ['x', 'y']), { x: this.x, y: this.y });
    this.rotation = makeSignal(this, 'rotation', asNumber(0));
    this.scale = Object.assign(makeSignal<PossibleVector2, Vector2>(this, 'scale', asVector), {
      x: makeComponentSignal(this, 'scale', 'x'),
      y: makeComponentSignal(this, 'scale', 'y'),
    });
    this.opacity = makeSignal(this, 'opacity', asNumber(1));
    for (const [key, value] of Object.entries(props)) this.applyProp(key, value);
  }

  /** Fügt Kinder hinzu (Kinder sind relativ zur Mitte dieses Knotens positioniert). */
  add(...nodes: Node[]): this {
    this.children.push(...nodes);
    return this;
  }

  /** Setzt eine Konstruktor-Eigenschaft als Anfangswert. */
  private applyProp(key: string, value: unknown): void {
    if (key === 'key' || value === undefined) return;
    if (key === 'children') {
      if (Array.isArray(value)) this.children.push(...value.filter((c): c is Node => c instanceof Node));
      return;
    }
    if (key === 'position' || key === 'size') {
      const v = toVector(value);
      const [a, b]: readonly [string, string] = key === 'position' ? ['x', 'y'] : ['width', 'height'];
      if (v !== undefined && this.specs.has(a)) {
        this.initial.set(a, v.x);
        this.initial.set(b, v.y);
        return;
      }
    }
    const spec = this.specs.get(key);
    const normalized = spec?.normalize(value);
    if (spec !== undefined && normalized !== undefined) {
      this.initial.set(key, normalized);
      return;
    }
    runtime().diagnostics.push(unsupported(this, key, value));
  }
}

function currentValue(node: Node, prop: string): unknown {
  const rt = runtime();
  return rt.valueAt(node.id, prop, node.initial.get(prop), rt.time);
}

/** Zeichnet ein Setzen (duration 0) oder einen Tween zur aktuellen Zeit auf. */
function writeProp(node: Node, prop: string, raw: unknown, duration: number, timing: TimingFunction | undefined): void {
  const rt = runtime();
  const to = node.specs.get(prop)?.normalize(raw);
  if (to === undefined) {
    rt.diagnostics.push(unsupported(node, prop, raw));
    return;
  }
  const from = currentValue(node, prop);
  const ease = duration > 0 ? easeOf(timing ?? easeInOutCubic, node, prop) : 'hold';
  rt.record(node.id, prop, { start: rt.time, end: rt.time + duration, from, to, ease, set: duration === 0 });
}

function* tweenTask(node: Node, prop: string, target: () => unknown, duration: number, timing: TimingFunction | undefined): ThreadGenerator {
  // Start- und Zielwert werden erst beim Start des Tasks gelesen (wie in Motion Canvas).
  writeProp(node, prop, target(), Math.max(0, duration), timing);
  yield { kind: 'wait', seconds: Math.max(0, duration) };
}

/** Signal für eine Property. */
function makeSignal<TIn, TOut>(node: Node, prop: string, read: (v: unknown) => TOut): Signal<TIn, TOut> {
  function signal(): TOut;
  function signal(value: TIn): Node;
  function signal(value: TIn, duration: number, timing?: TimingFunction): ThreadGenerator;
  function signal(value?: TIn, duration?: number, timing?: TimingFunction): TOut | Node | ThreadGenerator {
    if (value === undefined) return read(currentValue(node, prop));
    if (duration === undefined) {
      writeProp(node, prop, value, 0, undefined);
      return node;
    }
    return tweenTask(node, prop, () => value, duration, timing);
  }
  return signal;
}

/** Signal, das zwei Properties gemeinsam setzt (z. B. `position` → x, y). */
function makeVectorSignal(node: Node, props: readonly [string, string]): Signal<PossibleVector2, Vector2> {
  const [a, b] = props;
  function signal(): Vector2;
  function signal(value: PossibleVector2): Node;
  function signal(value: PossibleVector2, duration: number, timing?: TimingFunction): ThreadGenerator;
  function signal(value?: PossibleVector2, duration?: number, timing?: TimingFunction): Vector2 | Node | ThreadGenerator {
    if (value === undefined) return { x: asNumber(0)(currentValue(node, a)), y: asNumber(0)(currentValue(node, b)) };
    const v = toVector(value) ?? { x: 0, y: 0 };
    if (duration === undefined) {
      writeProp(node, a, v.x, 0, undefined);
      writeProp(node, b, v.y, 0, undefined);
      return node;
    }
    return (function* (): ThreadGenerator {
      yield { kind: 'fork', tasks: [tweenTask(node, a, () => v.x, duration, timing), tweenTask(node, b, () => v.y, duration, timing)], join: 'all' };
    })();
  }
  return signal;
}

/** Teil-Signal einer Vektor-Property (z. B. `scale.x`). */
function makeComponentSignal(node: Node, prop: string, component: 'x' | 'y'): Signal<number, number> {
  const current = (): Vector2 => asVector(currentValue(node, prop));
  function signal(): number;
  function signal(value: number): Node;
  function signal(value: number, duration: number, timing?: TimingFunction): ThreadGenerator;
  function signal(value?: number, duration?: number, timing?: TimingFunction): number | Node | ThreadGenerator {
    if (value === undefined) return current()[component];
    if (duration === undefined) {
      writeProp(node, prop, { ...current(), [component]: value }, 0, undefined);
      return node;
    }
    return tweenTask(node, prop, () => ({ ...current(), [component]: value }), duration, timing);
  }
  return signal;
}

function easeOf(timing: TimingFunction, node: Node, prop: string): string {
  const name = easingName(timing);
  if (name !== undefined) return name;
  runtime().diagnostics.push({
    code: 'OV_IMPORT_LOSSY',
    severity: 'warning',
    errorClass: 'MotionCanvasAdapterError',
    problem: `Custom timing function "${timing.name || 'anonymous'}" on ${prop} cannot be converted; "linear" is used.`,
    path: `${node.id}.${prop}`,
    nodeId: node.id,
    suggestions: ['Use an easing exported by @agentic-video/motion-canvas-adapter, e.g. easeInOutCubic.'],
  });
  return 'linear';
}

function unsupported(node: Node, key: string, value: unknown): Diagnostic {
  const shown = typeof value === 'function' || typeof value === 'symbol' || value === undefined ? typeof value : JSON.stringify(value);
  const layout = ['layout', 'direction', 'gap', 'padding', 'margin', 'alignItems', 'justifyContent', 'alignContent', 'wrap', 'grow', 'shrink', 'basis'].includes(key);
  return {
    code: 'OV_IMPORT_LOSSY',
    severity: 'warning',
    errorClass: 'MotionCanvasAdapterError',
    problem: layout ? `Layout property "${key}" is not supported (no flexbox layout engine); it was ignored.` : `Property "${key}" with value ${shown} is not supported on ${node.kind} and was ignored.`,
    path: `${node.id}.${key}`,
    nodeId: node.id,
    suggestions: [layout ? 'Position children with explicit x/y values.' : 'Use x, y, position, rotation, scale, opacity, fill, stroke, lineWidth, width, height, size and the node-specific properties.'],
  };
}

/** Gemeinsame Eigenschaften gezeichneter Formen. */
export interface ShapeProps extends NodeProps {
  readonly fill?: string;
  readonly stroke?: string;
  readonly lineWidth?: number;
}

/** Basisklasse gezeichneter Formen: Füllung und Kontur. */
export class Shape extends Node {
  readonly fill: Signal<string, string | undefined>;
  readonly stroke: Signal<string, string | undefined>;
  readonly lineWidth: Signal<number, number>;

  constructor(props: ShapeProps, kind: string, extra: Readonly<Record<string, PropSpec>> = {}) {
    super(props, kind, { ...SHAPE_PROPS, ...extra });
    this.fill = makeSignal(this, 'fill', asOptionalString);
    this.stroke = makeSignal(this, 'stroke', asOptionalString);
    this.lineWidth = makeSignal(this, 'lineWidth', asNumber(0));
  }
}

const SIZE_PROPS: Readonly<Record<string, PropSpec>> = {
  width: { normalize: num, fallback: 0 },
  height: { normalize: num, fallback: 0 },
};

/** Eigenschaften von Formen mit Größe. */
export interface SizedProps extends ShapeProps {
  readonly width?: number;
  readonly height?: number;
  readonly size?: PossibleVector2;
}

/** Form mit Breite und Höhe. */
export class SizedShape extends Shape {
  readonly width: Signal<number, number>;
  readonly height: Signal<number, number>;
  readonly size: Signal<PossibleVector2, Vector2>;

  constructor(props: SizedProps, kind: string, extra: Readonly<Record<string, PropSpec>> = {}) {
    super(props, kind, { ...SIZE_PROPS, ...extra });
    this.width = makeSignal(this, 'width', asNumber(0));
    this.height = makeSignal(this, 'height', asNumber(0));
    this.size = makeVectorSignal(this, ['width', 'height']);
  }
}

/** Eigenschaften von {@link Rect}. */
export interface RectProps extends SizedProps {
  readonly radius?: number;
}

/**
 * Rechteck, mittig an seiner Position.
 *
 * @example
 * ```ts
 * const rect = new Rect({ width: 200, height: 100, fill: '#e13238', radius: 8 });
 * ```
 */
export class Rect extends SizedShape {
  readonly radius: Signal<number, number>;

  constructor(props: RectProps = {}) {
    super(props, 'rect', { radius: { normalize: num, fallback: 0 } });
    this.radius = makeSignal(this, 'radius', asNumber(0));
  }
}

/**
 * Kreis oder Ellipse, mittig an seiner Position.
 *
 * @example
 * ```ts
 * const dot = new Circle({ size: 80, fill: 'white' });
 * ```
 */
export class Circle extends SizedShape {
  constructor(props: SizedProps = {}) {
    super(props, 'circle');
  }
}

/** Eigenschaften von {@link Txt}. */
export interface TxtProps extends ShapeProps {
  readonly text?: string;
  readonly fontSize?: number;
  readonly fontFamily?: string;
  readonly fontWeight?: number;
}

/**
 * Text, mittig an seiner Position.
 *
 * @example
 * ```ts
 * const title = new Txt({ text: 'Hello', fontSize: 64, fill: '#ffffff' });
 * ```
 */
export class Txt extends Shape {
  readonly text: Signal<string, string>;
  readonly fontSize: Signal<number, number>;
  readonly fontWeight: Signal<number, number>;

  constructor(props: TxtProps = {}) {
    super(props, 'txt', {
      text: { normalize: str, fallback: '' },
      fontSize: { normalize: num, fallback: 48 },
      fontFamily: { normalize: str, fallback: undefined },
      fontWeight: { normalize: num, fallback: undefined },
    });
    this.text = makeSignal(this, 'text', asString);
    this.fontSize = makeSignal(this, 'fontSize', asNumber(48));
    this.fontWeight = makeSignal(this, 'fontWeight', asNumber(400));
  }
}

/** Eigenschaften von {@link Line}. */
export interface LineProps extends ShapeProps {
  readonly points?: readonly PossibleVector2[];
  /** Anfang des sichtbaren Abschnitts (0..1). */
  readonly start?: number;
  /** Ende des sichtbaren Abschnitts (0..1). */
  readonly end?: number;
}

/**
 * Linienzug durch Punkte relativ zur Position.
 *
 * @example
 * ```ts
 * const line = new Line({ points: [[-100, 0], [100, 0]], stroke: 'white', lineWidth: 8, end: 0 });
 * yield* line.end(1, 1);
 * ```
 */
export class Line extends Shape {
  readonly points: Signal<readonly PossibleVector2[], number[][]>;
  readonly start: Signal<number, number>;
  readonly end: Signal<number, number>;

  constructor(props: LineProps = {}) {
    super(props, 'line', {
      points: { normalize: points, fallback: undefined },
      start: { normalize: num, fallback: 0 },
      end: { normalize: num, fallback: 1 },
    });
    this.points = makeSignal(this, 'points', asPoints);
    this.start = makeSignal(this, 'start', asNumber(0));
    this.end = makeSignal(this, 'end', asNumber(1));
  }
}

/** Eigenschaften von {@link Img}. */
export interface ImgProps extends SizedProps {
  /** Pfad oder URL des Bildes; wird ein Asset des Projects. */
  readonly src?: string;
}

/**
 * Bild, mittig an seiner Position. Ohne Breite und Höhe ist die Mitte unbekannt (Diagnose).
 *
 * @example
 * ```ts
 * const logo = new Img({ src: 'assets/logo.png', width: 300, height: 120 });
 * ```
 */
export class Img extends SizedShape {
  constructor(props: ImgProps = {}) {
    super(props, 'img', { src: { normalize: str, fallback: undefined } });
  }
}

/**
 * Die Wurzel einer Szene (`view`). Ursprung ist die Bildmitte, y zeigt nach unten.
 *
 * @example
 * ```ts
 * makeScene('intro', function* (view) { view.add(new Rect({ size: 100 })); });
 * ```
 */
export class View2D {
  readonly children: Node[] = [];

  /** Fügt Knoten der Szene hinzu. */
  add(...nodes: Node[]): this {
    this.children.push(...nodes);
    return this;
  }
}
