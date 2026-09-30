/**
 * Frame Evaluation (AD-2, FR-6): `evaluateScene(project, compositionId, frame) → EvaluatedScene`.
 *
 * Die Funktion ist rein. Sie hängt nur von IR, Frame, Seed und dem übergebenen
 * Register ab. Frame 471 ist gleich, egal ob Frame 470 vorher ausgewertet wurde.
 */
import { OpenVideoError, validateValue, Theme as ThemeSchema, Timing as TimingSchema, Transition as TransitionSchema, type ColorSpace, type Diagnostic, type IrNode, type Theme, type Transition } from '@agentic-video/schema';
import { computeLocalTime, easing, evaluateAnimated, resolveMarkers, toFrames, type AnimationContext, type TimelineEvent } from '@agentic-video/timeline';
import type { EvaluatedNode, EvaluatedScene, Reveal } from './contracts.js';
import { conforms, isRecord } from './guards.js';
import { contentHash } from './hash.js';
import { sortByZIndex } from './plan.js';
import type { ExpandContext, Registry } from './registry.js';

/** Optionen für {@link evaluateScene}. */
export interface EvaluateOptions {
  /** Register für Komponenten und Makro-Nodes. Ohne Register werden sie mit Diagnose übersprungen. */
  readonly registry?: Registry;
  /** Überschreibt den Seed von Composition und Project. */
  readonly seed?: number;
  /**
   * Höchstzahl ausgewerteter Knoten pro Aufruf (Standard {@link DEFAULT_MAX_NODES}).
   * Darüber bricht die Auswertung mit der Diagnose `OV_EVAL_NODE_BUDGET` ab.
   */
  readonly maxNodes?: number;
  /**
   * Subframe-Zustände für Motion Blur in {@link EvaluatedScene.motionKey} aufnehmen (Standard `true`).
   * Auswertungen von Subframes selbst setzen `false`.
   */
  readonly motionKey?: boolean;
}

/**
 * Subframe-Offsets der Blender-Motion-Blur-Zustände (Verschlusszeit ½ Frame, zentriert).
 * Muss `DEFAULT_MOTION_OFFSETS` in `@agentic-video/renderer-blender` entsprechen.
 */
export const BLENDER_MOTION_OFFSETS: readonly number[] = [-0.25, 0.25];

/** Offsets der Subframes, die eine Node für Motion Blur braucht (leer = keine). */
function motionOffsets(node: EvaluatedNode): number[] {
  if (node.type === 'blender' && node.props['motionBlur'] === true) return [...BLENDER_MOTION_OFFSETS];
  const blur = node.props['motionBlur'];
  if (node.type === 'layer' && isRecord(blur) && typeof blur['samples'] === 'number' && typeof blur['shutter'] === 'number' && blur['samples'] >= 2) {
    const samples = blur['samples'];
    const shutter = blur['shutter'];
    return Array.from({ length: samples }, (_, i) => (i / (samples - 1) - 0.5) * shutter).filter((o) => o !== 0);
  }
  return [];
}

function stripForMotion(node: EvaluatedNode): unknown {
  return {
    id: node.id,
    type: node.type,
    props: node.props,
    children: node.children.map(stripForMotion),
    mask: node.mask === undefined ? undefined : { ...node.mask, node: stripForMotion(node.mask.node) },
    reveal: node.reveal,
    time: node.time.localFrame,
  };
}

/**
 * Hash der Subframe-Zustände aller Motion-Blur-Nodes (Blender `motionBlur: true`, `layer.motionBlur`),
 * oder `undefined`, wenn die Szene keine hat. Geht in den Frame-Schlüssel ein: Gleiche Zustände am
 * Frame, aber andere Bewegung zwischen den Frames, ergeben verschiedene Pixel.
 */
function motionKeyOf(project: Readonly<Record<string, unknown>>, compositionId: string, frame: number, nodes: readonly EvaluatedNode[], options: EvaluateOptions): string | undefined {
  const wanted = new Map<string, number[]>();
  walkEvaluated(nodes, (n) => {
    const offsets = motionOffsets(n);
    if (offsets.length > 0) wanted.set(n.id, offsets);
  });
  if (wanted.size === 0) return undefined;
  const offsets = [...new Set([...wanted.values()].flat())].sort((a, b) => a - b);
  const states = offsets.map((offset) => {
    const sub = evaluateScene(project, compositionId, frame + offset, { ...options, motionKey: false });
    const found: unknown[] = [];
    walkEvaluated(sub.nodes, (n) => {
      if (wanted.get(n.id)?.includes(offset) === true) found.push(stripForMotion(n));
    });
    return { offset, nodes: found };
  });
  return contentHash(states);
}

/** Standard-Knotenbudget pro Auswertung (Schutz vor exponentiellen `composition-ref`-Bäumen). */
export const DEFAULT_MAX_NODES = 100_000;

/** Größte Verschachtelung von Komponenten, Expandern und `composition-ref` (Schutz vor Rekursion). */
export const MAX_EXPANSION_DEPTH = 16;

/** Felder einer IR-Node, die keine Render-Properties sind. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(['id', 'type', 'name', 'comment', 'locked', 'timing', 'transition', 'renderer', 'meta', 'children', 'mask', 'visible']);

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Sucht eine Composition; ohne ID die erste. */
export function findComposition(project: Readonly<Record<string, unknown>>, compositionId?: string): Record<string, unknown> {
  const comps = records(project['compositions']);
  const comp = compositionId === undefined ? comps[0] : comps.find((c) => c['id'] === compositionId);
  if (comp === undefined) {
    throw new OpenVideoError({
      code: 'OV_COMPOSITION_UNKNOWN',
      errorClass: 'EvaluationError',
      problem: compositionId === undefined ? 'The project has no composition.' : `Composition "${compositionId}" does not exist.`,
      suggestions: comps.length > 0 ? [`Use one of: ${comps.map((c) => String(c['id'])).join(', ')}.`] : ['Add a composition to project.compositions.'],
    });
  }
  return comp;
}

/** Dauer einer Composition in ganzen Frames. */
export function compositionDurationFrames(comp: Readonly<Record<string, unknown>>): number {
  const fps = Number(comp['fps']);
  const markers = resolveMarkers(markerList(comp), fps);
  const d = comp['duration'];
  if (typeof d !== 'number' && typeof d !== 'string') throw new OpenVideoError({ code: 'OV_SCHEMA_REQUIRED', errorClass: 'EvaluationError', problem: 'Composition has no duration.', suggestions: ['duration: "10s"'] });
  return Math.max(1, Math.round(toFrames(d, { fps, markers })));
}

function markerList(comp: Readonly<Record<string, unknown>>): { id: string; time: number | string }[] {
  return records(comp['markers'])
    .filter((m) => typeof m['id'] === 'string' && (typeof m['time'] === 'number' || typeof m['time'] === 'string'))
    .map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) }));
}

/** Benannte Events einer Composition: Marker mit `kind: 'event'`, mit Frame und Daten. */
function eventList(comp: Readonly<Record<string, unknown>>, markers: ReadonlyMap<string, number>): ReadonlyMap<string, TimelineEvent> {
  const out = new Map<string, TimelineEvent>();
  for (const m of records(comp['markers'])) {
    if (m['kind'] !== 'event' || typeof m['id'] !== 'string') continue;
    const frame = markers.get(m['id']);
    if (frame === undefined) continue;
    const raw = isRecord(m['data']) ? m['data'] : {};
    const data: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') data[k] = v;
    out.set(m['id'], { frame, data });
  }
  return out;
}

function colorSpaceOf(value: unknown): ColorSpace | undefined {
  return value === 'srgb' || value === 'linear' || value === 'rec709' ? value : undefined;
}

function resolveTheme(theme: Theme | undefined): (ref: string) => unknown {
  return (ref) => {
    const [, group, ...rest] = ref.split('.');
    const name = rest.join('.');
    const themeRecord: unknown = theme;
    const groupValue: unknown = group !== undefined && isRecord(themeRecord) ? themeRecord[group] : undefined;
    if (isRecord(groupValue) && Object.hasOwn(groupValue, name)) return groupValue[name];
    throw new OpenVideoError({
      code: 'OV_THEME_REF',
      errorClass: 'EvaluationError',
      problem: `Theme token "${ref}" is not defined.`,
      suggestions: [`Define settings.theme.${group ?? ''}.${name}.`],
    });
  };
}

interface EvalCtx {
  readonly project: Readonly<Record<string, unknown>>;
  readonly compositionId: string;
  readonly fps: number;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly markers: ReadonlyMap<string, number>;
  /** Benannte Events (Marker mit `kind: 'event'`) in Composition-Frames. */
  readonly events: ReadonlyMap<string, TimelineEvent>;
  readonly theme: Theme;
  readonly resolveRef: (ref: string) => unknown;
  readonly registry: Registry | undefined;
  readonly diagnostics: Diagnostic[];
  readonly compositionFrame: number;
  /** Tiefe verschachtelter Compositions, Komponenten und Expander (Schutz vor Endlosschleifen). */
  readonly depth: number;
  /** Gemeinsames Knotenbudget aller Ebenen einer Auswertung. */
  readonly budget: { remaining: number; exceeded: boolean };
}

interface Parent {
  readonly frame: number;
  readonly start: number;
  readonly duration: number;
}

function shiftedMarkers(markers: ReadonlyMap<string, number>, offset: number): ReadonlyMap<string, number> {
  return offset === 0 ? markers : new Map([...markers].map(([k, v]) => [k, v - offset]));
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vec(value: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
  return isRecord(value) ? { x: num(value['x'], fallback.x), y: num(value['y'], fallback.y) } : fallback;
}

function applyTransition(props: Record<string, unknown>, spec: Transition, relFrame: number, durationFrames: number, ctx: EvalCtx): Reveal | undefined {
  let reveal: Reveal | undefined;
  const phases: { readonly phase: 'in' | 'out'; readonly p: number; readonly type: string }[] = [];
  const timeCtx = { fps: ctx.fps, markers: ctx.markers };
  if (spec.in !== undefined) {
    const d = toFrames(spec.in.duration, timeCtx);
    if (d > 0 && relFrame < d) phases.push({ phase: 'in', p: easing(spec.in.ease)(Math.max(0, relFrame / d)), type: spec.in.type });
  }
  if (spec.out !== undefined) {
    const d = toFrames(spec.out.duration, timeCtx);
    if (d > 0 && relFrame > durationFrames - d) phases.push({ phase: 'out', p: easing(spec.out.ease)(Math.max(0, (durationFrames - relFrame) / d)), type: spec.out.type });
  }
  for (const { phase, p, type } of phases) {
    const q = 1 - p;
    const sign = phase === 'in' ? 1 : -1;
    const scale = vec(props['scale'], { x: 1, y: 1 });
    switch (type) {
      case 'fade':
        props['opacity'] = num(props['opacity'], 1) * p;
        break;
      case 'slide-left':
        props['x'] = num(props['x'], 0) + sign * ctx.width * q;
        break;
      case 'slide-right':
        props['x'] = num(props['x'], 0) - sign * ctx.width * q;
        break;
      case 'slide-up':
        props['y'] = num(props['y'], 0) + sign * ctx.height * q;
        break;
      case 'slide-down':
        props['y'] = num(props['y'], 0) - sign * ctx.height * q;
        break;
      case 'zoom-in': {
        const f = phase === 'in' ? 0.5 + 0.5 * p : 1 + 0.5 * q;
        props['scale'] = { x: scale.x * f, y: scale.y * f };
        props['opacity'] = num(props['opacity'], 1) * p;
        break;
      }
      case 'zoom-out': {
        const f = phase === 'in' ? 1.5 - 0.5 * p : 1 - 0.5 * q;
        props['scale'] = { x: scale.x * f, y: scale.y * f };
        props['opacity'] = num(props['opacity'], 1) * p;
        break;
      }
      case 'blur': {
        const existing: unknown = props['filters'];
        const filters: unknown[] = Array.isArray(existing) ? Array.from<unknown>(existing) : [];
        filters.push({ type: 'blur', radius: 24 * q });
        props['filters'] = filters;
        props['opacity'] = num(props['opacity'], 1) * p;
        break;
      }
      case 'wipe-left':
        reveal = { shape: 'rect', direction: phase === 'in' ? 'right' : 'left', progress: p };
        break;
      case 'wipe-right':
        reveal = { shape: 'rect', direction: phase === 'in' ? 'left' : 'right', progress: p };
        break;
      case 'wipe-up':
        reveal = { shape: 'rect', direction: phase === 'in' ? 'down' : 'up', progress: p };
        break;
      case 'wipe-down':
        reveal = { shape: 'rect', direction: phase === 'in' ? 'up' : 'down', progress: p };
        break;
      case 'iris':
        reveal = { shape: 'ellipse', direction: 'center', progress: p };
        break;
      default:
        ctx.diagnostics.push({ code: 'OV_TRANSITION_UNKNOWN', severity: 'warning', errorClass: 'EvaluationError', problem: `Unknown transition "${type}".`, suggestions: ['Use fade, slide-*, wipe-*, zoom-in, zoom-out, blur or iris.'] });
    }
  }
  return reveal;
}

function evaluateNode(raw: unknown, parent: Parent, pointer: string, idPrefix: string, ctx: EvalCtx): EvaluatedNode | undefined {
  if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['type'] !== 'string') return undefined;
  const id = idPrefix + raw['id'];
  if (!takeBudget(ctx, id)) return undefined;
  const type = raw['type'];
  const rawTiming = raw['timing'];
  const timing = conforms(TimingSchema, rawTiming) ? rawTiming : undefined;
  const local = computeLocalTime(timing, parent.frame, {
    fps: ctx.fps,
    seed: ctx.seed,
    markers: shiftedMarkers(ctx.markers, parent.start),
    parentStart: parent.start,
    parentDuration: parent.duration,
  });
  if (!local.active) return undefined;

  const actx: AnimationContext = {
    frame: local.localFrame,
    fps: ctx.fps,
    seed: ctx.seed,
    durationFrames: local.durationFrames,
    markers: ctx.markers,
    events: ctx.events,
    markerOffset: local.startFrame,
    resolveRef: ctx.resolveRef,
  };
  const evalValue = (value: unknown, where: string): unknown => {
    try {
      return evaluateAnimated(value, actx);
    } catch (error) {
      if (error instanceof OpenVideoError) {
        ctx.diagnostics.push({ ...error.diagnostic, nodeId: id, path: `composition.${ctx.compositionId}.nodes.${id}.${where}`, frame: ctx.compositionFrame });
        return undefined;
      }
      throw error;
    }
  };

  if (raw['visible'] !== undefined && evalValue(raw['visible'], 'visible') === false) return undefined;

  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (STRUCTURAL_KEYS.has(key) || value === undefined) continue;
    const v = evalValue(value, key);
    if (v !== undefined) props[key] = v;
  }
  const rawTransition = raw['transition'];
  const transition = conforms(TransitionSchema, rawTransition) ? rawTransition : undefined;
  const reveal = transition !== undefined ? applyTransition(props, transition, local.relFrame, local.durationFrames, ctx) : undefined;

  const time = { localFrame: local.localFrame, relFrame: local.relFrame, durationFrames: local.durationFrames, progress: local.progress, compositionFrame: ctx.compositionFrame };
  const childParent: Parent = { frame: local.localFrame, start: local.startFrame, duration: local.durationFrames };
  const renderer = typeof raw['renderer'] === 'string' ? raw['renderer'] : undefined;
  const source = sourceOf(raw);

  let outType = type;
  let children: EvaluatedNode[] = [];
  const expandCtx: ExpandContext = {
    id,
    frame: local.localFrame,
    fps: ctx.fps,
    seed: ctx.seed,
    durationFrames: local.durationFrames,
    compositionWidth: ctx.width,
    compositionHeight: ctx.height,
    theme: ctx.theme,
    project: ctx.project,
    compositionId: ctx.compositionId,
  };

  if (type === 'component') {
    const name = String(raw['component']);
    const def = ctx.registry?.components.get(name);
    if (def === undefined) {
      ctx.diagnostics.push({
        code: 'OV_COMPONENT_UNKNOWN',
        severity: 'error',
        errorClass: 'EvaluationError',
        problem: `Component "${name}" is not registered.`,
        nodeId: id,
        suggestions: ['Register the component library (e.g. @agentic-video/components) in the Registry.'],
      });
      return undefined;
    }
    const componentProps = isRecord(props['props']) ? { ...props['props'] } : {};
    if (def.propsSchema !== undefined) {
      for (const issue of validateValue(def.propsSchema, componentProps)) {
        ctx.diagnostics.push({
          code: 'OV_COMPONENT_PROPS',
          severity: 'error',
          errorClass: 'ComponentError',
          problem: `${name}: ${issue.message}`,
          nodeId: id,
          path: `composition.${ctx.compositionId}.nodes.${id}.props${issue.segments.length > 0 ? `.${issue.segments.join('.')}` : ''}`,
          frame: ctx.compositionFrame,
          suggestions: issue.suggestion !== undefined ? [issue.suggestion] : [`Allowed props of ${name}: ${Object.keys(isRecord(def.propsSchema['properties']) ? def.propsSchema['properties'] : {}).join(', ')}.`],
        });
      }
    }
    if (Array.isArray(raw['children'])) componentProps['children'] = raw['children'];
    delete props['props'];
    delete props['component'];
    const expanded = safeExpand(() => def.expand(componentProps, expandCtx), `Component "${name}"`, id, ctx);
    if (expanded === undefined) return undefined;
    children = expandInto(expanded, childParent, pointer, `${id}/`, ctx);
    outType = 'group';
  } else if (ctx.registry?.expanders.has(type) === true) {
    const expander = ctx.registry.expanders.get(type);
    if (expander !== undefined) {
      const expanded = safeExpand(() => expander.expand(raw, expandCtx), `Expander "${type}"`, id, ctx);
      if (expanded === undefined) return undefined;
      children = expandInto(expanded, childParent, pointer, `${id}/`, ctx);
    }
    outType = 'group';
  } else if (type === 'composition-ref') {
    const nested = evaluateCompositionRef(String(raw['composition']), local.localFrame, pointer, id, ctx);
    if (nested !== undefined) {
      children = nested.children;
      if (props['width'] === undefined) props['width'] = nested.width;
      if (props['height'] === undefined) props['height'] = nested.height;
      props['clip'] = true;
    }
    delete props['composition'];
    outType = 'group';
  } else if (type === 'sequence') {
    children = arrangeSequence(raw, id, childParent, ctx)
      .map(({ node, index }) => evaluateNode(node, childParent, `${pointer}/children/${String(index)}`, idPrefix, ctx))
      .filter((n): n is EvaluatedNode => n !== undefined);
    delete props['between'];
    delete props['transitions'];
    outType = 'group';
  } else {
    children = records(raw['children'])
      .map((child, i) => evaluateNode(child, childParent, `${pointer}/children/${String(i)}`, idPrefix, ctx))
      .filter((n): n is EvaluatedNode => n !== undefined);
  }

  let mask: EvaluatedNode['mask'];
  if (isRecord(raw['mask']) && isRecord(raw['mask']['node'])) {
    const maskNode = evaluateNode(raw['mask']['node'], parent, `${pointer}/mask/node`, idPrefix, ctx);
    if (maskNode !== undefined) {
      mask = { node: maskNode, mode: raw['mask']['mode'] === 'luminance' ? 'luminance' : 'alpha', invert: raw['mask']['invert'] === true };
    }
  }

  return {
    id,
    type: outType,
    props,
    children: sortByZIndex(children),
    ...(mask !== undefined ? { mask } : {}),
    ...(reveal !== undefined ? { reveal } : {}),
    time,
    ...(renderer !== undefined ? { renderer } : {}),
    pointer,
    ...(source !== undefined ? { source } : {}),
  };
}

/** Übergänge, bei denen auch der ausgehende Clip animiert (Push); sonst liegt der neue Clip über dem stehenden alten. */
const PUSH_TRANSITIONS: ReadonlySet<string> = new Set(['slide-left', 'slide-right', 'slide-up', 'slide-down']);

/** Dauer eines Sequenz-Kinds in Frames der Eltern-Zeit, oder `undefined`, wenn sie fehlt. */
function sequenceChildDuration(child: Readonly<Record<string, unknown>>, timeCtx: { fps: number; markers: ReadonlyMap<string, number> }, ctx: EvalCtx): number | undefined {
  const timing = isRecord(child['timing']) ? child['timing'] : {};
  const d = timing['duration'];
  if (typeof d === 'number' || typeof d === 'string') return toFrames(d, timeCtx);
  if (child['type'] !== 'composition-ref' || typeof child['composition'] !== 'string') return undefined;
  const comp = records(ctx.project['compositions']).find((c) => c['id'] === child['composition']);
  if (comp === undefined) return undefined;
  const speed = typeof timing['speed'] === 'number' && timing['speed'] > 0 ? timing['speed'] : 1;
  return (compositionDurationFrames(comp) / Number(comp['fps'])) * ctx.fps / speed;
}

/**
 * Ordnet die Kinder einer `sequence` hintereinander an (T9). Zwischen Kind i und i + 1 gilt
 * `transitions[i] ?? between ?? cut`. Bei einem Übergang der Dauer d beginnt Kind i + 1 d Frames
 * vor dem Ende von Kind i; es bekommt die `in`-Transition, bei `slide-*` bekommt Kind i die
 * passende `out`-Transition (Push). Eigene `transition`-Einträge der Kinder gelten, wo kein
 * Sequenz-Übergang liegt. `timing.from` der Kinder wird durch die Anordnung ersetzt.
 */
function arrangeSequence(raw: Readonly<Record<string, unknown>>, id: string, parent: Parent, ctx: EvalCtx): { node: Record<string, unknown>; index: number }[] {
  const timeCtx = { fps: ctx.fps, markers: shiftedMarkers(ctx.markers, parent.start) };
  const between = raw['between'];
  const perGap: readonly unknown[] = Array.isArray(raw['transitions']) ? raw['transitions'] : [];
  const items: { node: Record<string, unknown>; index: number; duration: number }[] = [];
  records(raw['children']).forEach((child, index) => {
    const duration = sequenceChildDuration(child, timeCtx, ctx);
    const childId = typeof child['id'] === 'string' ? child['id'] : String(index);
    if (duration === undefined || !(duration > 0)) {
      ctx.diagnostics.push({
        code: 'OV_SEQUENCE_DURATION',
        severity: 'error',
        errorClass: 'EvaluationError',
        problem: `Child "${childId}" of sequence "${id}" has no duration; it is skipped.`,
        nodeId: id,
        frame: ctx.compositionFrame,
        suggestions: [`Set timing.duration on "${childId}", e.g. { "timing": { "duration": "3s" } }.`],
      });
      return;
    }
    if (isRecord(child['timing']) && child['timing']['from'] !== undefined) {
      ctx.diagnostics.push({
        code: 'OV_SEQUENCE_FROM_IGNORED',
        severity: 'warning',
        errorClass: 'EvaluationError',
        problem: `Child "${childId}" of sequence "${id}" sets timing.from; the sequence places its children itself.`,
        nodeId: id,
        frame: ctx.compositionFrame,
        suggestions: ['Remove timing.from from children of a sequence; use transitions to control overlaps.'],
      });
    }
    items.push({ node: child, index, duration });
  });
  const out: { node: Record<string, unknown>; index: number }[] = [];
  let start = 0;
  let incoming: Record<string, unknown> | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const next = items[i + 1];
    // transitions[i] liegt zwischen Kind i und i + 1 der IR; übersprungene Kinder verschieben den Index nicht.
    const gapSpec = perGap[item.index] ?? between;
    let overlap = 0;
    let outgoing: Record<string, unknown> | undefined;
    let nextIn: Record<string, unknown> | undefined;
    if (next !== undefined && isRecord(gapSpec) && typeof gapSpec['type'] === 'string' && gapSpec['type'] !== 'cut') {
      const d = gapSpec['duration'];
      overlap = typeof d === 'number' || typeof d === 'string' ? Math.min(Math.max(0, toFrames(d, timeCtx)), item.duration, next.duration) : 0;
      if (overlap > 0) {
        const spec = { type: gapSpec['type'], duration: overlap, ...(typeof gapSpec['ease'] === 'string' ? { ease: gapSpec['ease'] } : {}) };
        nextIn = spec;
        if (PUSH_TRANSITIONS.has(gapSpec['type'])) outgoing = spec;
      }
    }
    const own = isRecord(item.node['transition']) ? item.node['transition'] : {};
    const inSpec = incoming ?? own['in'];
    const outSpec = outgoing ?? (next === undefined || overlap === 0 ? own['out'] : undefined);
    const timing = isRecord(item.node['timing']) ? item.node['timing'] : {};
    out.push({
      node: {
        ...item.node,
        timing: { ...timing, from: start, duration: item.duration },
        transition: { ...(inSpec !== undefined ? { in: inSpec } : {}), ...(outSpec !== undefined ? { out: outSpec } : {}) },
      },
      index: item.index,
    });
    start += item.duration - overlap;
    incoming = nextIn;
  }
  return out;
}

function sourceOf(raw: Readonly<Record<string, unknown>>): EvaluatedNode['source'] {
  const meta = raw['meta'];
  if (!isRecord(meta) || !isRecord(meta['source'])) return undefined;
  const s = meta['source'];
  if (typeof s['file'] !== 'string' || typeof s['line'] !== 'number' || typeof s['column'] !== 'number') return undefined;
  return { file: s['file'], line: s['line'], column: s['column'] };
}

/** Zieht einen Knoten vom Budget ab; meldet die Überschreitung genau einmal. */
function takeBudget(ctx: EvalCtx, id: string): boolean {
  if (ctx.budget.remaining <= 0) {
    if (!ctx.budget.exceeded) {
      ctx.budget.exceeded = true;
      ctx.diagnostics.push({
        code: 'OV_EVAL_NODE_BUDGET',
        severity: 'error',
        errorClass: 'EvaluationError',
        problem: `The scene expands to more nodes than the budget allows; evaluation stopped at node "${id}".`,
        nodeId: id,
        frame: ctx.compositionFrame,
        suggestions: ['Reduce repeated composition-ref nodes; each ref copies the whole nested composition.', 'Split the composition into smaller compositions or pass a larger maxNodes.'],
      });
    }
    return false;
  }
  ctx.budget.remaining -= 1;
  return true;
}

/** Prüft die Verschachtelungstiefe vor einer Expansion. */
function depthExceeded(ctx: EvalCtx, id: string, what: string): boolean {
  if (ctx.depth < MAX_EXPANSION_DEPTH) return false;
  ctx.diagnostics.push({
    code: 'OV_EVAL_DEPTH',
    severity: 'error',
    errorClass: 'EvaluationError',
    problem: `${what} at "${id}" is nested deeper than ${String(MAX_EXPANSION_DEPTH)} levels (recursion?).`,
    nodeId: id,
    frame: ctx.compositionFrame,
    suggestions: ['Remove the component, expander or composition-ref that contains itself.'],
  });
  return true;
}

/** Ruft `expand` einer Komponente oder eines Expanders auf; Fehler werden zur Diagnose an der Node. */
function safeExpand(run: () => IrNode[], what: string, id: string, ctx: EvalCtx): IrNode[] | undefined {
  if (depthExceeded(ctx, id, what)) return undefined;
  try {
    const nodes: unknown = run();
    return Array.isArray(nodes) ? nodes.filter(isRecord).filter((n): n is IrNode => typeof n['id'] === 'string' && typeof n['type'] === 'string') : [];
  } catch (error) {
    const message = error instanceof OpenVideoError ? error.diagnostic.problem : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    ctx.diagnostics.push({
      code: 'OV_COMPONENT_EXPAND',
      severity: 'error',
      errorClass: 'ComponentError',
      problem: `${what} failed to expand: ${message}`,
      nodeId: id,
      frame: ctx.compositionFrame,
      suggestions: ['Check the props of this node against the component documentation.', 'The node is skipped; the rest of the scene still renders.'],
    });
    return undefined;
  }
}

function expandInto(nodes: readonly IrNode[], parent: Parent, pointer: string, prefix: string, ctx: EvalCtx): EvaluatedNode[] {
  const inner: EvalCtx = { ...ctx, depth: ctx.depth + 1 };
  return nodes.map((n, i) => evaluateNode(n, parent, `${pointer}#${String(i)}`, prefix, inner)).filter((n): n is EvaluatedNode => n !== undefined);
}

function evaluateCompositionRef(compositionId: string, frame: number, pointer: string, idPrefix: string, ctx: EvalCtx): { children: EvaluatedNode[]; width: number; height: number } | undefined {
  if (depthExceeded(ctx, idPrefix, `Composition-ref to "${compositionId}"`)) return undefined;
  let comp: Record<string, unknown>;
  try {
    comp = findComposition(ctx.project, compositionId);
  } catch (error) {
    if (error instanceof OpenVideoError) {
      ctx.diagnostics.push(error.diagnostic);
      return undefined;
    }
    throw error;
  }
  const fps = Number(comp['fps']);
  const nestedMarkers = resolveMarkers(markerList(comp), fps);
  const nestedCtx: EvalCtx = {
    ...ctx,
    compositionId,
    fps,
    width: Number(comp['width']),
    height: Number(comp['height']),
    markers: nestedMarkers,
    events: eventList(comp, nestedMarkers),
    depth: ctx.depth + 1,
  };
  // Zeit der äußeren Node (in Frames der äußeren Composition) → Frames der inneren Composition
  const innerFrame = (frame / ctx.fps) * fps;
  const duration = compositionDurationFrames(comp);
  const parent: Parent = { frame: innerFrame, start: 0, duration };
  const children = [
    ...sortByZIndex(
      records(comp['nodes'])
        .map((n, i) => evaluateNode(n, parent, `${pointer}->${compositionId}/nodes/${String(i)}`, `${idPrefix}/`, nestedCtx))
        .filter((n): n is EvaluatedNode => n !== undefined),
    ),
  ];
  const background = comp['background'];
  if (typeof background === 'string' && background !== 'transparent') {
    children.unshift({
      id: `${idPrefix}/__background`,
      type: 'rect',
      props: { width: Number(comp['width']), height: Number(comp['height']), fill: background },
      children: [],
      time: { localFrame: innerFrame, relFrame: innerFrame, durationFrames: duration, progress: innerFrame / duration, compositionFrame: ctx.compositionFrame },
      pointer: `${pointer}->${compositionId}`,
    });
  }
  return { children, width: Number(comp['width']), height: Number(comp['height']) };
}

/**
 * Wertet eine Composition für einen Frame aus.
 *
 * @param frame Composition-Frame; gebrochene Werte sind für Motion Blur erlaubt.
 *
 * @example
 * ```ts
 * const scene = evaluateScene(project, 'hero', 120, { registry });
 * scene.nodes[0]?.props['opacity'];
 * ```
 */
export function evaluateScene(project: Readonly<Record<string, unknown>>, compositionId: string | undefined, frame: number, options: EvaluateOptions = {}): EvaluatedScene {
  const comp = findComposition(project, compositionId);
  const settings = isRecord(project['settings']) ? project['settings'] : {};
  const rawTheme = settings['theme'];
  const theme: Theme = conforms(ThemeSchema, rawTheme) ? rawTheme : {};
  const fps = Number(comp['fps']);
  const width = Number(comp['width']);
  const height = Number(comp['height']);
  const seed = options.seed ?? (typeof comp['seed'] === 'number' ? comp['seed'] : typeof settings['seed'] === 'number' ? settings['seed'] : 0);
  const markers = resolveMarkers(markerList(comp), fps);
  const durationFrames = compositionDurationFrames(comp);
  const id = String(comp['id']);
  const diagnostics: Diagnostic[] = [];
  const ctx: EvalCtx = {
    project,
    compositionId: id,
    fps,
    seed,
    width,
    height,
    markers,
    events: eventList(comp, markers),
    theme,
    resolveRef: resolveTheme(theme),
    registry: options.registry,
    diagnostics,
    compositionFrame: frame,
    depth: 0,
    budget: { remaining: Math.max(0, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES)), exceeded: false },
  };
  const compIndex = records(project['compositions']).indexOf(comp);
  const parent: Parent = { frame, start: 0, duration: durationFrames };
  const nodes = records(comp['nodes'])
    .map((n, i) => evaluateNode(n, parent, `/compositions/${String(compIndex)}/nodes/${String(i)}`, '', ctx))
    .filter((n): n is EvaluatedNode => n !== undefined);
  const safe = isRecord(comp['safeArea']) ? comp['safeArea'] : {};
  const colorSpace: ColorSpace = colorSpaceOf(comp['colorSpace']) ?? colorSpaceOf(settings['workingColorSpace']) ?? 'srgb';
  const outputColorSpace = colorSpaceOf(settings['outputColorSpace']);
  const sorted = sortByZIndex(nodes);
  const motionKey = options.motionKey === false ? undefined : motionKeyOf(project, id, frame, sorted, options);
  return {
    compositionId: id,
    width,
    height,
    fps,
    frame,
    time: frame / fps,
    seed,
    durationFrames,
    background: typeof comp['background'] === 'string' ? comp['background'] : 'transparent',
    colorSpace,
    ...(outputColorSpace !== undefined ? { outputColorSpace } : {}),
    safeArea: { action: num(safe['action'], 0.035), title: num(safe['title'], 0.05) },
    nodes: sorted,
    diagnostics,
    ...(motionKey !== undefined ? { motionKey } : {}),
  };
}

/** Besucht alle Nodes einer Evaluated Scene in Zeichenreihenfolge (Tiefensuche). */
export function walkEvaluated(nodes: readonly EvaluatedNode[], fn: (node: EvaluatedNode, depth: number) => void, depth = 0): void {
  for (const n of nodes) {
    fn(n, depth);
    walkEvaluated(n.children, fn, depth + 1);
  }
}
