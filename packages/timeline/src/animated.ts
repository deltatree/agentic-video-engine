/**
 * Auswertung animierter Werte (AD-3): `$keyframes`, `$spring`, `$expr`, `$sampled`, `$ref`.
 *
 * Jede Auswertung ist eine reine Funktion von Wert, lokalem Frame, fps, Seed und Kontext.
 */
import { OpenVideoError, type TimeValue } from '@agentic-video/schema';
import { easing } from './easing.js';
import { compileExpression, type ExprValue } from './expression.js';
import { interpolate } from './interpolate.js';
import { springProgress } from './spring.js';
import { toFrames } from './time.js';

/** Kontext für die Auswertung einer Property. */
export interface AnimationContext {
  /** Lokaler Frame der Node (darf gebrochen sein, z. B. für Motion Blur). */
  readonly frame: number;
  readonly fps: number;
  readonly seed: number;
  /** Dauer der Node in Frames. */
  readonly durationFrames: number;
  /** Marker in Frames (Composition-Zeit). */
  readonly markers?: ReadonlyMap<string, number>;
  /** Versatz zwischen Composition-Zeit und lokaler Zeit (Composition-Frame = lokal + offset). */
  readonly markerOffset?: number;
  /** Löst `theme.<gruppe>.<name>` auf. */
  readonly resolveRef?: (ref: string) => unknown;
  /** Zusätzliche Variablen für Expressions. */
  readonly vars?: Readonly<Record<string, number | readonly number[]>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prüft, ob ein Wert eine Animationsbeschreibung ist (Objekt mit genau einem `$`-Schlüssel). */
export function isAnimated(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['$keyframes', '$spring', '$expr', '$sampled', '$ref'].some((k) => k in value);
}

function localMarkers(ctx: AnimationContext): ReadonlyMap<string, number> | undefined {
  if (ctx.markers === undefined) return undefined;
  const offset = ctx.markerOffset ?? 0;
  if (offset === 0) return ctx.markers;
  return new Map([...ctx.markers].map(([k, v]) => [k, v - offset]));
}

function frameOf(t: TimeValue, ctx: AnimationContext): number {
  const markers = localMarkers(ctx);
  return toFrames(t, { fps: ctx.fps, ...(markers !== undefined ? { markers } : {}) });
}

interface ResolvedKey {
  readonly f: number;
  readonly v: unknown;
  readonly ease: string | undefined;
}

function evaluateKeyframes(spec: Record<string, unknown>, ctx: AnimationContext): unknown {
  const raw = spec['$keyframes'];
  if (!Array.isArray(raw) || raw.length === 0) throw animError('$keyframes needs at least one keyframe.');
  const keys: ResolvedKey[] = raw
    .filter(isRecord)
    .map((k) => {
      const t = k['t'];
      if (typeof t !== 'number' && typeof t !== 'string') throw animError('Keyframe "t" must be a time value.');
      const ease = k['ease'];
      return { f: frameOf(t, ctx), v: k['v'], ease: typeof ease === 'string' ? ease : undefined };
    })
    .sort((a, b) => a.f - b.f);
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) throw animError('$keyframes needs at least one keyframe.');
  const delay = typeof spec['delay'] === 'number' || typeof spec['delay'] === 'string' ? frameOf(spec['delay'], ctx) : 0;
  let f = ctx.frame - delay;

  const loop = spec['loop'];
  const span = last.f - first.f;
  if ((loop === 'repeat' || loop === 'pingpong') && span > 0 && f > first.f) {
    const repeat = spec['repeat'];
    const maxCycles = typeof repeat === 'number' ? repeat : Number.POSITIVE_INFINITY;
    const rel = f - first.f;
    const cycle = Math.floor(rel / span);
    if (cycle < maxCycles) {
      const within = rel - cycle * span;
      f = first.f + (loop === 'pingpong' && cycle % 2 === 1 ? span - within : within);
    } else {
      // Nach der letzten Wiederholung: Endzustand der letzten Runde halten
      f = loop === 'pingpong' && maxCycles % 2 === 0 ? first.f : last.f;
    }
  }

  if (f <= first.f) return first.v;
  if (f >= last.f) return last.v;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    const a = keys[i - 1];
    if (a === undefined || b === undefined) continue;
    if (f === b.f) return b.v;
    if (f < b.f) {
      const span2 = b.f - a.f;
      const p = span2 <= 0 ? 1 : (f - a.f) / span2;
      // Das Easing eines Keyframes gilt für das Segment, das auf ihn zuläuft.
      return interpolate(a.v, b.v, easing(b.ease)(p));
    }
  }
  return last.v;
}

function evaluateSpring(spec: Record<string, unknown>, ctx: AnimationContext): unknown {
  const s = spec['$spring'];
  if (!isRecord(s)) throw animError('$spring must be an object.');
  const at = typeof s['at'] === 'number' || typeof s['at'] === 'string' ? frameOf(s['at'], ctx) : 0;
  const seconds = (ctx.frame - at) / ctx.fps;
  const params = {
    ...(typeof s['stiffness'] === 'number' ? { stiffness: s['stiffness'] } : {}),
    ...(typeof s['damping'] === 'number' ? { damping: s['damping'] } : {}),
    ...(typeof s['mass'] === 'number' ? { mass: s['mass'] } : {}),
    ...(typeof s['velocity'] === 'number' ? { velocity: s['velocity'] } : {}),
  };
  return interpolate(s['from'], s['to'], springProgress(seconds, params));
}

function evaluateSampled(spec: Record<string, unknown>, ctx: AnimationContext): unknown {
  const s = spec['$sampled'];
  if (!isRecord(s) || !Array.isArray(s['values']) || s['values'].length === 0) throw animError('$sampled needs values.');
  const values: readonly unknown[] = s['values'];
  const start = typeof s['start'] === 'number' ? s['start'] : 0;
  const pos = ctx.frame - start;
  if (pos <= 0) return values[0];
  if (pos >= values.length - 1) return values[values.length - 1];
  const i = Math.floor(pos);
  const frac = pos - i;
  return frac === 0 ? values[i] : interpolate(values[i], values[i + 1], frac);
}

function exprToValue(v: ExprValue): unknown {
  return typeof v === 'string' || typeof v === 'number' ? v : [...v];
}

function animError(problem: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_ANIMATION_INVALID', errorClass: 'TimelineError', problem, suggestions: ['Check the animation against the JSON Schema.'] });
}

/**
 * Wertet einen (möglicherweise animierten) Property-Wert für einen Frame aus.
 * Nicht animierte Werte werden unverändert zurückgegeben; verschachtelte Objekte
 * und Arrays werden rekursiv ausgewertet.
 *
 * @example
 * ```ts
 * evaluateAnimated({ $keyframes: [{ t: 0, v: 0 }, { t: '1s', v: 100, ease: 'easeOutCubic' }] }, { frame: 15, fps: 30, seed: 0, durationFrames: 60 });
 * // 87.5
 * ```
 */
export function evaluateAnimated(value: unknown, ctx: AnimationContext): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => evaluateAnimated(v, ctx));
  if (!isRecord(value)) return value;
  if ('$keyframes' in value) return evaluateAnimated(evaluateKeyframes(value, ctx), ctx);
  if ('$spring' in value) return evaluateSpring(value, ctx);
  if ('$sampled' in value) return evaluateSampled(value, ctx);
  if ('$expr' in value) {
    const src = value['$expr'];
    if (typeof src !== 'string') throw animError('$expr must be a string.');
    const markers = localMarkers(ctx);
    return exprToValue(
      compileExpression(src).evaluate({
        frame: ctx.frame,
        time: ctx.frame / ctx.fps,
        fps: ctx.fps,
        seed: ctx.seed,
        duration: ctx.durationFrames / ctx.fps,
        progress: ctx.durationFrames > 0 ? Math.min(Math.max(ctx.frame / ctx.durationFrames, 0), 1) : 0,
        ...(markers !== undefined ? { markers: new Map([...markers].map(([k, f]) => [k, f / ctx.fps])) } : {}),
        ...(ctx.vars !== undefined ? { vars: ctx.vars } : {}),
      }),
    );
  }
  if ('$ref' in value && typeof value['$ref'] === 'string' && Object.keys(value).length === 1) {
    if (ctx.resolveRef === undefined) throw animError(`Cannot resolve "${value['$ref']}" without a theme.`);
    return evaluateAnimated(ctx.resolveRef(value['$ref']), ctx);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = evaluateAnimated(v, ctx);
  return out;
}
