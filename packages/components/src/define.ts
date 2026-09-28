/**
 * Gemeinsame Bausteine aller Komponenten: Props lesen, Farben, Zeit,
 * Ein-/Ausblendung und die Hülle `defineComponent` (ADR 0011).
 */
import {
  NODE_SCHEMAS,
  TimeValue,
  conforms,
  formatColor,
  isRecord,
  mixColor,
  parseColor,
  toFrames,
  type ComponentDefinition,
  type ExpandContext,
  type IrNode,
  type NodeOf,
} from '@agentic-video/core';
import Type, { type TObject, type TProperties } from 'typebox';
import { resolveTheme, type ResolvedTheme } from './theme.js';

/** 2D-Punkt in lokalen Pixeln der Komponente. */
export interface Pt {
  readonly x: number;
  readonly y: number;
}

const COLOR = /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$/u;

/** Prüft, ob ein Wert eine gültige IR-Farbe ist. */
export function isColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR.test(value);
}

/**
 * Setzt die Deckkraft einer Farbe (0..1) und liefert `#RRGGBBAA`.
 *
 * @example
 * ```ts
 * withAlpha('#FF0000', 0.5); // '#FF000080'
 * ```
 */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return formatColor({ ...c, a: c.a * Math.min(1, Math.max(0, alpha)) });
}

/**
 * Mischt zwei Farben im sRGB-Raum.
 *
 * @example
 * ```ts
 * mix('#000000', '#FFFFFF', 0.5); // '#808080'
 * ```
 */
export function mix(a: string, b: string, t: number): string {
  return formatColor(mixColor(parseColor(a), parseColor(b), t));
}

/**
 * Liest ausgewertete Komponenten-Props tolerant: falsche Typen fallen auf den Standard zurück.
 *
 * @example
 * ```ts
 * const p = new Props({ width: 200 });
 * p.num('width', 100); // 200
 * ```
 */
export class Props {
  constructor(readonly raw: Readonly<Record<string, unknown>>) {}

  has(key: string): boolean {
    return this.raw[key] !== undefined;
  }

  num(key: string, fallback: number): number {
    const v = this.raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  optNum(key: string): number | undefined {
    const v = this.raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  str(key: string, fallback: string): string {
    const v = this.raw[key];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
  }

  optStr(key: string): string | undefined {
    const v = this.raw[key];
    return typeof v === 'string' ? v : undefined;
  }

  bool(key: string, fallback: boolean): boolean {
    const v = this.raw[key];
    return typeof v === 'boolean' ? v : fallback;
  }

  color(key: string, fallback: string): string {
    const v = this.raw[key];
    return isColor(v) ? v : fallback;
  }

  oneOf<T extends string>(key: string, options: readonly T[], fallback: T): T {
    const v = this.raw[key];
    return options.find((o) => o === v) ?? fallback;
  }

  point(key: string, fallback: Pt): Pt {
    return toPoint(this.raw[key]) ?? fallback;
  }

  points(key: string): Pt[] {
    const v = this.raw[key];
    return Array.isArray(v) ? v.map(toPoint).filter((p): p is Pt => p !== undefined) : [];
  }

  records(key: string): Record<string, unknown>[] {
    const v = this.raw[key];
    return Array.isArray(v) ? v.filter(isRecord) : [];
  }

  numbers(key: string): number[] {
    const v = this.raw[key];
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];
  }

  strings(key: string): string[] {
    const v = this.raw[key];
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : [];
  }

  /** Zeitwert in Frames; `marker:`-Zeiten gelten in Komponenten nicht und fallen auf den Standard zurück. */
  frames(key: string, fallback: TimeValue, fps: number): number {
    return framesOf(this.raw[key], fps) ?? framesOf(fallback, fps) ?? 0;
  }

  /** Kind-Nodes aus `children` (Node-Kinder der Komponente oder `props.children`). */
  children(): IrNode[] {
    const v = this.raw['children'];
    return Array.isArray(v) ? v.filter(isIrNode) : [];
  }
}

function toPoint(value: unknown): Pt | undefined {
  if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') return { x: value[0], y: value[1] };
  if (isRecord(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number') return { x: value['x'], y: value['y'] };
  return undefined;
}

/** Prüft grob, ob ein Wert eine eingebaute IR-Node ist (ID und bekannter Typ). Details prüft die Auswertung. */
export function isIrNode(value: unknown): value is IrNode {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string' && Object.hasOwn(NODE_SCHEMAS, value['type']);
}

/**
 * Wandelt einen Zeitwert (Frames oder `"1.5s"`) in Frames. Marker gelten hier nicht.
 *
 * @example
 * ```ts
 * framesOf('0.5s', 30); // 15
 * ```
 */
export function framesOf(value: unknown, fps: number): number | undefined {
  if (!conforms(TimeValue, value)) return undefined;
  if (typeof value === 'string' && value.startsWith('marker:')) return undefined;
  return toFrames(value, { fps });
}

// ---------------------------------------------------------------------------
// Ein- und Ausblendung
// ---------------------------------------------------------------------------

/** Arten der Ein- und Ausblendung. */
export const MOTION_TYPES = ['none', 'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale'] as const;
/** Art einer Ein- oder Ausblendung. */
export type MotionType = (typeof MOTION_TYPES)[number];

/** Schema einer Ein- oder Ausblendung: Name oder Objekt mit Dauer und Easing. */
export const MotionSpec = Type.Union([
  Type.Enum(MOTION_TYPES),
  Type.Object(
    {
      type: Type.Enum(MOTION_TYPES),
      duration: Type.Optional(TimeValue),
      ease: Type.Optional(Type.String({ description: 'Easing name. Default: theme.easing.enter / theme.easing.exit.' })),
      distance: Type.Optional(Type.Number({ minimum: 0, description: 'Slide distance in pixels. Default: theme.spacing.xl.' })),
    },
    { additionalProperties: false },
  ),
]);

/** Props, die jede Komponente versteht. */
export const COMMON_PROPS = {
  enter: Type.Optional(MotionSpec),
  exit: Type.Optional(MotionSpec),
} satisfies TProperties;

interface Motion {
  readonly type: MotionType;
  readonly frames: number;
  readonly ease: string;
  readonly distance: number;
}

function motionOf(value: unknown, fallbackType: MotionType, fallbackEase: string, theme: ResolvedTheme, fps: number): Motion {
  const spec = isRecord(value) ? value : { type: value };
  const type = MOTION_TYPES.find((t) => t === spec['type']) ?? fallbackType;
  const frames = framesOf(spec['duration'], fps) ?? framesOf(theme.motion.normal, fps) ?? 0;
  const ease = typeof spec['ease'] === 'string' ? spec['ease'] : fallbackEase;
  const distance = typeof spec['distance'] === 'number' ? spec['distance'] : theme.spacing.xl;
  return { type, frames: type === 'none' ? 0 : Math.max(0, frames), ease, distance };
}

interface MotionState {
  readonly opacity: number;
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
}

const REST: MotionState = { opacity: 1, dx: 0, dy: 0, scale: 1 };

/** Zustand am Rand: `sign` 1 = Einblendung (Start), -1 = Ausblendung (Ende). */
function edgeState(m: Motion, sign: 1 | -1): MotionState {
  const d = m.distance;
  switch (m.type) {
    case 'none':
      return REST;
    case 'fade':
      return { ...REST, opacity: 0 };
    case 'slide-up':
      return { ...REST, opacity: 0, dy: sign * d };
    case 'slide-down':
      return { ...REST, opacity: 0, dy: -sign * d };
    case 'slide-left':
      return { ...REST, opacity: 0, dx: sign * d };
    case 'slide-right':
      return { ...REST, opacity: 0, dx: -sign * d };
    case 'scale':
      return { ...REST, opacity: 0, scale: sign === 1 ? 0.8 : 1.1 };
  }
}

type Channel = 'opacity' | 'dx' | 'dy' | 'scale';

interface Key {
  readonly t: number;
  readonly v: number;
  readonly ease?: string;
}

/** Keyframes eines Kanals über Ein- und Ausblendung; `undefined`, wenn der Kanal konstant bleibt. */
function channel(ch: Channel, enter: Motion, exit: Motion, inFrames: number, outFrames: number, total: number): Key[] | undefined {
  const a = edgeState(enter, 1)[ch];
  const b = edgeState(exit, -1)[ch];
  const rest = REST[ch];
  const keys: Key[] = [];
  if (inFrames > 0 && a !== rest) keys.push({ t: 0, v: a }, { t: inFrames, v: rest, ease: enter.ease });
  if (outFrames > 0 && b !== rest) keys.push({ t: total - outFrames, v: rest }, { t: total, v: b, ease: exit.ease });
  return keys.length > 0 ? keys : undefined;
}

/**
 * Baut die animierten Properties der Hülle für Ein- und Ausblendung (lokale Zeit der Komponente).
 *
 * @example
 * ```ts
 * motionProps({ type: 'fade' }, 'none', { durationFrames: 90, fps: 30 }, DEFAULT_THEME, 'fade', 'fade');
 * // { opacity: { $keyframes: [{ t: 0, v: 0 }, { t: 15, v: 1, ease: 'easeOutCubic' }] } }
 * ```
 */
export function motionProps(
  enterValue: unknown,
  exitValue: unknown,
  ctx: Pick<ExpandContext, 'durationFrames' | 'fps'>,
  theme: ResolvedTheme,
  defaultEnter: MotionType,
  defaultExit: MotionType,
): Pick<NodeOf<'group'>, 'opacity' | 'x' | 'y' | 'scale'> {
  const enter = motionOf(enterValue, defaultEnter, theme.easing.enter, theme, ctx.fps);
  const exit = motionOf(exitValue, defaultExit, theme.easing.exit, theme, ctx.fps);
  // Der letzte sichtbare Frame ist `durationFrames - 1`: dort ist die Ausblendung abgeschlossen.
  const total = Math.max(0, ctx.durationFrames - 1);
  let inF = enter.frames;
  let outF = exit.frames;
  // Beide Phasen passen nicht in die Dauer: anteilig kürzen.
  if (inF + outF > total && inF + outF > 0) {
    const f = total / (inF + outF);
    inF *= f;
    outF *= f;
  }
  const opacity = channel('opacity', enter, exit, inF, outF, total);
  const dx = channel('dx', enter, exit, inF, outF, total);
  const dy = channel('dy', enter, exit, inF, outF, total);
  const scale = channel('scale', enter, exit, inF, outF, total);
  return {
    ...(opacity !== undefined ? { opacity: { $keyframes: opacity } } : {}),
    ...(dx !== undefined ? { x: { $keyframes: dx } } : {}),
    ...(dy !== undefined ? { y: { $keyframes: dy } } : {}),
    ...(scale !== undefined ? { scale: { $keyframes: scale.map((k) => ({ ...k, v: { x: k.v, y: k.v } })) } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Komponenten-Hülle
// ---------------------------------------------------------------------------

/** Ergebnis des Aufbaus einer Komponente: lokale Box und Kind-Nodes. */
export interface Built {
  readonly width: number;
  readonly height: number;
  readonly nodes: IrNode[];
}

/** Eingabe für den Aufbau einer Komponente. */
export interface BuildInput {
  readonly p: Props;
  readonly ctx: ExpandContext;
  readonly theme: ResolvedTheme;
}

/** Beschreibung einer Komponente für {@link defineComponent}. */
export interface ComponentSpec {
  readonly name: string;
  readonly description: string;
  readonly props: TProperties;
  readonly example: Readonly<Record<string, unknown>>;
  readonly enter?: MotionType;
  readonly exit?: MotionType;
  build(input: BuildInput): Built;
}

/**
 * Erzeugt eine `ComponentDefinition`: löst das Theme auf, baut die Nodes und legt
 * sie in eine Hülle `root` mit Ein- und Ausblendung.
 *
 * @example
 * ```ts
 * const Dot = defineComponent({
 *   name: 'Dot', description: 'A dot.', props: {}, example: {},
 *   build: ({ theme }) => ({ width: 10, height: 10, nodes: [{ id: 'd', type: 'ellipse', width: 10, height: 10, fill: theme.colors.primary }] }),
 * });
 * ```
 */
export function defineComponent(spec: ComponentSpec): ComponentDefinition {
  const propsSchema: TObject = Type.Object({ ...COMMON_PROPS, ...spec.props }, { additionalProperties: false });
  return {
    name: spec.name,
    description: spec.description,
    propsSchema,
    example: spec.example,
    expand(props, ctx) {
      const theme = resolveTheme(ctx.theme);
      const p = new Props(props);
      const built = spec.build({ p, ctx, theme });
      const root: IrNode = {
        id: 'root',
        type: 'group',
        width: built.width,
        height: built.height,
        ...motionProps(props['enter'], props['exit'], ctx, theme, spec.enter ?? 'fade', spec.exit ?? 'fade'),
        children: built.nodes,
      };
      return [root];
    },
  };
}

/**
 * Geschätzte Breite eines Textes, wenn keine Messung möglich ist (Layout-Hilfe, kein Ersatz für den Textsatz).
 *
 * @example
 * ```ts
 * estimateTextWidth('Hello', 20, true); // 60
 * ```
 */
export function estimateTextWidth(text: string, fontSize: number, mono = false): number {
  return Array.from(text).length * fontSize * (mono ? 0.6 : 0.55);
}

/** Kurzform für das Beispiel-Schema einer Farbe (für Props). */
export const ColorProp = (description: string) => Type.Optional(Type.String({ pattern: COLOR.source, description }));

/** Theme-Palette für Diagramme in fester Reihenfolge. */
export function palette(theme: ResolvedTheme): string[] {
  const c = theme.colors;
  return [c.primary, c.accent, c.secondary, c.success, c.warning, c.danger];
}

/** Klemmt einen Wert auf 0..1. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
