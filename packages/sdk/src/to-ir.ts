/**
 * `toIR`: Übersetzt SDK-Definitionen in ein IR-Project (FR-17a).
 *
 * Frame-Funktionen werden für jeden Frame ausgewertet. Werte, die sich ändern,
 * werden `$sampled` (ein Wert je lokalem Frame der Node); konstante Werte bleiben
 * Literal. Nodes, die nur in manchen Frames existieren, erhalten `visible` als
 * `$sampled`. So rendert das exportierte JSON ohne Code dasselbe Bild.
 */
import {
  ANIMATABLE_MARK,
  NODE_MARK,
  NODE_SCHEMAS,
  OpenVideoError,
  SCHEMA_VERSION,
  Timing,
  compositionDurationFrames,
  computeLocalTime,
  conforms,
  evaluateAnimated,
  isRecord,
  resolveMarkers,
  type AnimationContext,
  type Diagnostic,
  type IrProject,
  type Settings,
} from '@agentic-video/core';
import { withFrameContext } from './animation.js';
import { AssetRegistry, FrameConverter, nodeProps, type Draft, type FrameScene } from './convert.js';
import { isCompositionDefinition, isProjectDefinition, type CompositionDefinition, type CompositionInit, type ProjectDefinition } from './definition.js';

/** Optionen für {@link toIR}. */
export interface ToIROptions {
  /** Wird nach der Auswertung jedes Frames einer Frame-Funktion aufgerufen (z. B. für Fortschritt). */
  readonly sample?: (frame: number, compositionId: string) => void;
  /** Empfängt Warnungen, z. B. `OV_SDK_CLAMPED`. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
}

const ROOT = '\u0000root';
const NODE_SCHEMA_MAP: ReadonlyMap<string, unknown> = new Map(Object.entries(NODE_SCHEMAS));

function sdkError(code: string, problem: string, suggestions: readonly string[], extra: Partial<Diagnostic> = {}): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'SdkError', problem, suggestions, ...extra });
}

/**
 * Prüft die äußere Form eines IR-Projects (Version und Compositions). Die volle
 * Prüfung macht `validateProject`.
 *
 * @example
 * ```ts
 * if (isIrProjectShape(json)) render(json);
 * ```
 */
export function isIrProjectShape(value: unknown): value is IrProject {
  return isRecord(value) && typeof value['schemaVersion'] === 'string' && Array.isArray(value['compositions']) && value['compositions'].every((c) => isRecord(c) && Array.isArray(c['nodes']));
}

/**
 * Übersetzt eine Project- oder Composition-Definition in ein IR-Project.
 *
 * @example
 * ```ts
 * const ir = toIR(composition({ width: 640, height: 360, fps: 30, duration: 30,
 *   scene: ({ frame }) => Rect({ x: frame * 2, width: 10, height: 10 }) }));
 * // ir.compositions[0].nodes[0].x → { $sampled: { start: 0, values: [0, 2, 4, …] } }
 * ```
 */
export function toIR(input: ProjectDefinition | CompositionDefinition, options: ToIROptions = {}): IrProject {
  let init: ProjectDefinition['definition'];
  if (isProjectDefinition(input)) init = input.definition;
  else if (isCompositionDefinition(input)) init = { compositions: [input] };
  else {
    throw sdkError('OV_SDK_INVALID_DEFINITION', 'Expected the result of composition() or project().', ['export default composition({ width, height, fps, duration, scene })']);
  }
  const registry = new AssetRegistry(init.assets ?? []);
  const single = init.compositions.length === 1;
  const compositions = init.compositions.map((c, i) => {
    if (!isCompositionDefinition(c)) throw sdkError('OV_SDK_INVALID_DEFINITION', `compositions[${String(i)}] is not a composition() definition.`, ['compositions: [composition({ … })]']);
    return buildComposition(c.definition, c.definition.id ?? (single ? 'main' : `composition-${String(i + 1)}`), registry, init.settings, options);
  });
  const assets = [...(init.assets ?? []), ...registry.declared];
  const out: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    ...(init.metadata !== undefined ? { metadata: init.metadata } : {}),
    ...(init.settings !== undefined ? { settings: init.settings } : {}),
    compositions,
    ...(assets.length > 0 ? { assets } : {}),
    ...(init.fonts !== undefined ? { fonts: init.fonts } : {}),
    ...(init.audio !== undefined ? { audio: init.audio } : {}),
    ...(init.renderProfiles !== undefined ? { renderProfiles: init.renderProfiles } : {}),
  };
  if (!isIrProjectShape(out)) throw sdkError('OV_SDK_INVALID_DEFINITION', 'The project has no compositions.', ['project({ compositions: [composition({ … })] })']);
  return out;
}

interface MergeContext {
  readonly compositionId: string;
  readonly fps: number;
  readonly seed: number;
  readonly markers: ReadonlyMap<string, number>;
  readonly resolveRef: (ref: string) => unknown;
  readonly onDiagnostic: ((d: Diagnostic) => void) | undefined;
}

function buildComposition(def: CompositionInit, id: string, registry: AssetRegistry, settings: Settings | undefined, options: ToIROptions): Record<string, unknown> {
  const { scene, tracks, markers, background } = def;
  const durationFrames = compositionDurationFrames({ fps: def.fps, duration: def.duration, ...(markers !== undefined ? { markers } : {}) });
  const size = { width: def.width, height: def.height };
  const frames: FrameScene[] = [];
  if (typeof scene === 'function') {
    for (let f = 0; f < durationFrames; f++) {
      const arg = { frame: f, time: f / def.fps, fps: def.fps, width: def.width, height: def.height, durationFrames };
      try {
        const tree = withFrameContext({ frame: f, fps: def.fps }, () => scene(arg));
        frames.push(new FrameConverter(registry, size).convertScene(tree));
      } catch (error) {
        if (error instanceof OpenVideoError && error.diagnostic.frame === undefined) {
          throw new OpenVideoError({ ...error.diagnostic, compositionId: id, frame: f, problem: `Frame ${String(f)}: ${error.diagnostic.problem}`, cause: error });
        }
        throw error;
      }
      options.sample?.(f, id);
    }
  } else {
    frames.push(new FrameConverter(registry, size).convertScene(scene));
  }
  const first = frames[0];
  if (first === undefined) throw sdkError('OV_SDK_INVALID_DEFINITION', `Composition "${id}" has no frames.`, ['duration: "5s"']);
  frames.forEach((fr, f) => {
    for (const [what, a, b] of [
      ['background', fr.background, first.background],
      ['tracks', fr.tracks, first.tracks],
      ['markers', fr.markers, first.markers],
    ] as const) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw sdkError('OV_SDK_UNSTABLE_TREE', `Composition ${what} changes at frame ${String(f)}.`, [`Keep ${what} the same in every frame; animate node properties instead.`], { compositionId: id, frame: f });
      }
    }
  });

  const allMarkers = [...(markers ?? []), ...first.markers];
  const markerList = allMarkers.flatMap((m) => (typeof m['id'] === 'string' && (typeof m['time'] === 'number' || typeof m['time'] === 'string') ? [{ id: m['id'], time: m['time'] }] : []));
  const theme = settings?.theme;
  const ctx: MergeContext = {
    compositionId: id,
    fps: def.fps,
    seed: def.seed ?? settings?.seed ?? 0,
    markers: resolveMarkers(markerList, def.fps),
    resolveRef: (ref) => ref.split('.').slice(1).reduce<unknown>((cur, key) => (isRecord(cur) ? cur[key] : undefined), theme),
    onDiagnostic: options.onDiagnostic,
  };
  const nodes = mergeFrames(
    frames.map((fr) => fr.nodes),
    durationFrames,
    ctx,
  );
  const allTracks = [...(tracks ?? []), ...first.tracks];
  const bg = first.background ?? background;
  const { name, width, height, fps, duration, colorSpace, seed, safeArea, audio } = def;
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    width,
    height,
    fps,
    duration,
    ...(bg !== undefined ? { background: bg } : {}),
    ...(colorSpace !== undefined ? { colorSpace } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(safeArea !== undefined ? { safeArea } : {}),
    ...(allTracks.length > 0 ? { tracks: allTracks } : {}),
    ...(allMarkers.length > 0 ? { markers: allMarkers } : {}),
    nodes,
    ...(audio !== undefined ? { audio } : {}),
  };
}

// ---------------------------------------------------------------------------
// Zusammenführen der Frames
// ---------------------------------------------------------------------------

interface NodeInfo {
  readonly type: string;
  readonly parentKey: string;
  readonly frames: (Draft | undefined)[];
}

/** Zeitlage einer Node in einem Composition-Frame (wie in `evaluateScene`). */
interface Slot {
  readonly active: boolean;
  readonly localFrame: number;
  readonly start: number;
  readonly duration: number;
}

interface Sample {
  readonly frame: number;
  readonly slot: Slot;
  readonly value: unknown;
}

function mergeOrder(order: Map<string, string[]>, key: string, ids: readonly string[]): void {
  const list = order.get(key) ?? [];
  let prev = -1;
  for (const id of ids) {
    const at = list.indexOf(id);
    if (at === -1) {
      list.splice(prev + 1, 0, id);
      prev += 1;
    } else {
      prev = at;
    }
  }
  order.set(key, list);
}

function mergeFrames(frames: readonly Draft[][], durationFrames: number, ctx: MergeContext): Record<string, unknown>[] {
  const count = frames.length;
  const info = new Map<string, NodeInfo>();
  const order = new Map<string, string[]>();
  frames.forEach((roots, f) => {
    const seen = new Set<string>();
    const visit = (list: readonly Draft[], parentKey: string): void => {
      const ids: string[] = [];
      for (const d of list) {
        const id = d.id ?? '';
        const where = { compositionId: ctx.compositionId, nodeId: id, frame: f };
        if (seen.has(id)) throw sdkError('OV_SDK_DUPLICATE_ID', `Node id "${id}" is used twice at frame ${String(f)}.`, [`id="${id}-2"`], where);
        seen.add(id);
        let ni = info.get(id);
        if (ni === undefined) {
          ni = { type: d.type, parentKey, frames: Array.from({ length: count }, (): Draft | undefined => undefined) };
          info.set(id, ni);
        } else if (ni.type !== d.type) {
          throw sdkError('OV_SDK_UNSTABLE_TREE', `Node "${id}" changes its type from ${ni.type} to ${d.type} at frame ${String(f)}.`, ['Give the two elements different ids.', 'Keep the element type the same in every frame.'], where);
        } else if (ni.parentKey !== parentKey) {
          throw sdkError('OV_SDK_UNSTABLE_TREE', `Node "${id}" moves to another parent at frame ${String(f)}.`, ['Keep the tree structure the same in every frame; animate visibility instead.'], where);
        }
        ni.frames[f] = d;
        ids.push(id);
        visit(d.children, id);
      }
      mergeOrder(order, parentKey, ids);
    };
    visit(roots, ROOT);
  });

  const rootTimeline: Slot[] = Array.from({ length: count }, (_, f) => ({ active: true, localFrame: f, start: 0, duration: durationFrames }));
  const build = (id: string, parentTimeline: readonly Slot[]): Record<string, unknown> => {
    const ni = info.get(id);
    const firstDraft = ni?.frames.find((d) => d !== undefined);
    if (ni === undefined || firstDraft === undefined) throw sdkError('OV_SDK_UNSTABLE_TREE', `Node "${id}" vanished while merging frames.`, []);
    const flat = ni.frames.map((d) => (d === undefined ? undefined : nodeProps(d)));
    const where = { compositionId: ctx.compositionId, nodeId: id };

    const timingValues = new Set(flat.flatMap((p) => (p === undefined ? [] : [JSON.stringify(p['timing'])])));
    if (timingValues.size > 1) throw sdkError('OV_SDK_UNSTABLE_TREE', `Node "${id}" changes its timing between frames.`, ['Keep timing constant; compute animated values in the scene function instead.'], where);
    const rawTiming = firstDraft.props['timing'];
    const timing = rawTiming !== undefined && conforms(Timing, rawTiming) ? rawTiming : undefined;
    const timeline: Slot[] = parentTimeline.map((p) => {
      if (!p.active) return { active: false, localFrame: 0, start: p.start, duration: 0 };
      const markers = p.start === 0 ? ctx.markers : new Map([...ctx.markers].map(([k, v]) => [k, v - p.start]));
      const lt = computeLocalTime(timing, p.localFrame, { fps: ctx.fps, seed: ctx.seed, markers, parentStart: p.start, parentDuration: p.duration });
      return { active: lt.active, localFrame: lt.localFrame, start: lt.startFrame, duration: lt.durationFrames };
    });
    const relevant = timeline.flatMap((slot, f) => (slot.active ? [f] : []));
    const missing = relevant.some((f) => flat[f] === undefined);

    const keys: string[] = [];
    for (const p of flat) if (p !== undefined) for (const k of Object.keys(p)) if (!keys.includes(k)) keys.push(k);
    const out: Record<string, unknown> = { id, type: ni.type };
    for (const key of keys) {
      flat.forEach((p, f) => {
        if (p !== undefined && !Object.hasOwn(p, key)) {
          throw sdkError('OV_SDK_UNSTABLE_TREE', `Property "${key}" of node "${id}" is missing at frame ${String(f)}.`, [`Set ${key} in every frame, e.g. ${key}={cond ? a : b}.`], { ...where, frame: f });
        }
      });
      if (key === 'visible' && missing) continue;
      const samples: Sample[] = relevant.flatMap((f) => {
        const p = flat[f];
        const slot = timeline[f];
        return p === undefined || slot === undefined ? [] : [{ frame: f, slot, value: p[key] }];
      });
      const firstFlat = flat.find((p) => p !== undefined);
      out[key] = samples.length === 0 ? firstFlat?.[key] : mergeValue(schemaFor(ni.type, key), samples, ctx, id, key);
    }
    if (missing) {
      const samples: Sample[] = relevant.flatMap((f) => {
        const p = flat[f];
        const slot = timeline[f];
        if (slot === undefined) return [];
        return [{ frame: f, slot, value: p === undefined ? false : visibleAt(p['visible'], slot, ctx) }];
      });
      out['visible'] = mergeValue(schemaFor(ni.type, 'visible'), samples, ctx, id, 'visible');
    }
    const children = (order.get(id) ?? []).map((child) => build(child, timeline));
    if (children.length > 0) out['children'] = children;
    return out;
  };
  return (order.get(ROOT) ?? []).map((id) => build(id, rootTimeline));
}

function animationContext(slot: Slot, ctx: MergeContext): AnimationContext {
  return { frame: slot.localFrame, fps: ctx.fps, seed: ctx.seed, durationFrames: slot.duration, markers: ctx.markers, markerOffset: slot.start, resolveRef: ctx.resolveRef };
}

function visibleAt(value: unknown, slot: Slot, ctx: MergeContext): boolean {
  if (value === undefined) return true;
  return evaluateAnimated(value, animationContext(slot, ctx)) !== false;
}

function schemaFor(type: string, key: string): unknown {
  const schema = NODE_SCHEMA_MAP.get(type);
  const props = isRecord(schema) ? schema['properties'] : undefined;
  return isRecord(props) ? props[key] : undefined;
}

function isAnimatableSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  if (schema[ANIMATABLE_MARK] === true) return true;
  const anyOf = schema['anyOf'];
  return Array.isArray(anyOf) && anyOf.some((b) => isRecord(b) && b[ANIMATABLE_MARK] === true);
}

const ANIMATION_KEYS = ['$keyframes', '$spring', '$expr', '$sampled', '$ref'];

function containsAnimation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsAnimation);
  if (!isRecord(value)) return false;
  return ANIMATION_KEYS.some((k) => k in value) || Object.values(value).some(containsAnimation);
}

/** Führt die Werte einer Property über alle relevanten Frames zusammen. */
function mergeValue(schema: unknown, samples: readonly Sample[], ctx: MergeContext, nodeId: string, path: string): unknown {
  const first = samples[0]?.value;
  const firstJson = JSON.stringify(first);
  if (samples.every((s) => JSON.stringify(s.value) === firstJson)) return first;
  if (isRecord(schema) && !isAnimatableSchema(schema) && isRecord(first)) {
    // Objekt ohne eigene Animierbarkeit (z. B. shadow, mask): Felder einzeln zusammenführen.
    let objectSchema: unknown = schema;
    if (schema[NODE_MARK] === true && typeof first['type'] === 'string') objectSchema = NODE_SCHEMA_MAP.get(first['type']);
    const props = isRecord(objectSchema) ? objectSchema['properties'] : undefined;
    const keys = Object.keys(first).join('|');
    if (isRecord(props) && samples.every((s) => isRecord(s.value) && Object.keys(s.value).join('|') === keys && s.value['type'] === first['type'])) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(first)) {
        out[key] = mergeValue(
          props[key],
          samples.map((s) => ({ ...s, value: isRecord(s.value) ? s.value[key] : undefined })),
          ctx,
          nodeId,
          `${path}.${key}`,
        );
      }
      return out;
    }
  }
  return sampled(schema, samples, ctx, nodeId, path);
}

function sampled(schema: unknown, samples: readonly Sample[], ctx: MergeContext, nodeId: string, path: string): unknown {
  const byFrame = new Map<number, unknown>();
  for (const s of samples) {
    const lf = s.slot.localFrame;
    const where = { compositionId: ctx.compositionId, nodeId, frame: s.frame, path: `composition.${ctx.compositionId}.nodes.${nodeId}.${path}` };
    if (!Number.isInteger(lf) || lf < 0) {
      throw sdkError('OV_SDK_SAMPLED_TIMING', `Cannot sample "${path}" of node "${nodeId}": local frame ${String(lf)} is not a whole frame.`, ['Remove speed, remap or reverse from the timing of this node or its parents.', 'Use animate() or keyframes() instead of a frame function.'], where);
    }
    const value = containsAnimation(s.value) ? evaluateAnimated(s.value, animationContext(s.slot, ctx)) : s.value;
    const known = byFrame.get(lf);
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(value)) {
      throw sdkError('OV_SDK_SAMPLED_TIMING', `Cannot sample "${path}" of node "${nodeId}": local frame ${String(lf)} has two different values (loop or hold in timing).`, ['Remove loop or hold from the timing, or use keyframes().'], where);
    }
    byFrame.set(lf, value);
  }
  const frames = [...byFrame.keys()];
  const start = Math.min(...frames);
  const end = Math.max(...frames);
  const values: unknown[] = [];
  let last: unknown = byFrame.get(start);
  for (let lf = start; lf <= end; lf++) {
    if (byFrame.has(lf)) last = byFrame.get(lf);
    values.push(last);
  }
  return { $sampled: { start, values: clamp(schema, values, ctx, nodeId, path) } };
}

/**
 * Klemmt Zahlen auf die Grenzen des Schemas (wie CSS bei `opacity`) und meldet das als Warnung.
 * Beispiel: Eine überschwingende Feder auf `opacity` liefert Werte über 1.
 */
function clamp(schema: unknown, values: readonly unknown[], ctx: MergeContext, nodeId: string, path: string): unknown[] {
  const anyOf = isRecord(schema) ? schema['anyOf'] : undefined;
  const literal: unknown = Array.isArray(anyOf) ? anyOf[0] : schema;
  if (!isRecord(literal) || (literal['type'] !== 'number' && literal['type'] !== 'integer')) return [...values];
  const min = typeof literal['minimum'] === 'number' ? literal['minimum'] : Number.NEGATIVE_INFINITY;
  const max = typeof literal['maximum'] === 'number' ? literal['maximum'] : Number.POSITIVE_INFINITY;
  let clamped = 0;
  const out = values.map((v) => {
    if (typeof v !== 'number' || (v >= min && v <= max)) return v;
    clamped += 1;
    return Math.min(Math.max(v, min), max);
  });
  if (clamped > 0) {
    ctx.onDiagnostic?.({
      code: 'OV_SDK_CLAMPED',
      severity: 'warning',
      errorClass: 'SdkWarning',
      problem: `${String(clamped)} sampled values of "${path}" on node "${nodeId}" were outside ${String(min)}..${String(max)} and were clamped.`,
      compositionId: ctx.compositionId,
      nodeId,
      path: `composition.${ctx.compositionId}.nodes.${nodeId}.${path}`,
      details: { clampedFrames: clamped, minimum: Number.isFinite(min) ? min : 'none', maximum: Number.isFinite(max) ? max : 'none' },
      suggestions: ['Use config: { damping: 26 } for a spring without overshoot.', 'Clamp the value in the scene function, e.g. Math.min(1, value).'],
    });
  }
  return out;
}
