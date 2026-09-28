/**
 * Anime.js-artige Timeline (v4-Konzepte), die in `$keyframes`-Patches übersetzt.
 *
 * OpenVideo besitzt die Zeit (A8): Die Timeline startet nie eine Uhr. Sie sammelt
 * Tween-Segmente mit Start und Ende in Millisekunden und erzeugt daraus Patches.
 */
import { applyPatches, easing, isRecord, OpenVideoError, type Diagnostic, type Patch, type PatchResult } from '@agentic-video/core';
import { lossy, note } from './diagnostics.js';
import { mapEase, reverseEase, type EaseInput } from './ease.js';
import type { FunctionValue } from './helpers.js';

/** Ziele: Node-IDs als Text, Liste oder Selektor `#id`. */
export type Targets = string | readonly string[];

/** Position in der Timeline: ms, `'+=100'`, `'-=100'`, `'<'`, `'<<'`, `'<+=50'`, Label oder `'label+=100'`. */
export type TimePosition = number | string;

/** Parameter eines Eintrags wie in Anime.js. Alle anderen Schlüssel sind animierte Properties. */
export interface AnimationParams {
  readonly duration?: number | FunctionValue<number>;
  readonly delay?: number | FunctionValue<number>;
  readonly ease?: EaseInput;
  /** Wiederholungen: Zahl (zusätzliche Durchläufe) oder `true` (endlos). */
  readonly loop?: number | boolean;
  readonly alternate?: boolean;
  readonly reversed?: boolean;
  /** Wird ignoriert: OpenVideo besitzt die Zeit. */
  readonly autoplay?: boolean;
  readonly [property: string]: unknown;
}

/** Standardwerte einer Timeline. */
export interface TimelineDefaults {
  readonly duration?: number;
  readonly delay?: number;
  readonly ease?: EaseInput;
}

/** Optionen für {@link createTimeline}. */
export interface TimelineOptions {
  readonly defaults?: TimelineDefaults;
  readonly loop?: number | boolean;
  readonly alternate?: boolean;
  readonly autoplay?: boolean;
  readonly [key: string]: unknown;
}

/** Ergebnis von {@link Timeline.compile}. */
export interface CompiledTimeline {
  readonly patches: Patch[];
  readonly diagnostics: Diagnostic[];
}

type Value = { readonly kind: 'num'; readonly n: number } | { readonly kind: 'rel'; readonly op: '+' | '-' | '*'; readonly n: number } | { readonly kind: 'str'; readonly s: string };

interface Plan {
  readonly entry: number;
  readonly target: string;
  /** IR-Property, bei Vektoren mit Komponente: `scale.x`. */
  readonly channel: string;
  readonly start: number;
  readonly end: number;
  readonly from?: Value;
  readonly to: Value;
  readonly ease: string;
  readonly path: string;
}

interface EntryInfo {
  readonly loop?: number | boolean;
  readonly alternate: boolean;
  readonly reversed: boolean;
}

interface Channel {
  readonly prop: string;
  readonly component?: 'x' | 'y';
  /** `x`/`y` in Anime.js sind Verschiebungen relativ zum Basiswert der Node. */
  readonly relative: boolean;
  readonly angle: boolean;
}

const CONTROL_KEYS = new Set(['duration', 'delay', 'ease', 'easing', 'loop', 'alternate', 'reversed', 'autoplay', 'direction']);
const IGNORED_KEYS = new Set(['loopDelay', 'endDelay', 'composition', 'modifier', 'playbackRate', 'frameRate', 'playbackEase', 'keyframes', 'round']);
const CALLBACK = /^(on[A-Z]\w*|begin|complete|update|change|changeBegin|changeComplete|loopBegin|loopComplete)$/u;
const UNSUPPORTED_PROPS = new Set(['translateZ', 'z', 'rotateX', 'rotateY', 'perspective', 'matrix', 'matrix3d']);
const DEFAULT_EASE = 'easeOutQuad';

function channelsOf(key: string): Channel[] | undefined {
  switch (key) {
    case 'x':
    case 'translateX':
      return [{ prop: 'x', relative: true, angle: false }];
    case 'y':
    case 'translateY':
      return [{ prop: 'y', relative: true, angle: false }];
    case 'rotate':
    case 'rotateZ':
    case 'rotation':
      return [{ prop: 'rotation', relative: false, angle: true }];
    case 'scale':
      return [
        { prop: 'scale', component: 'x', relative: false, angle: false },
        { prop: 'scale', component: 'y', relative: false, angle: false },
      ];
    case 'scaleX':
      return [{ prop: 'scale', component: 'x', relative: false, angle: false }];
    case 'scaleY':
      return [{ prop: 'scale', component: 'y', relative: false, angle: false }];
    case 'skew':
      return [{ prop: 'skew', component: 'x', relative: false, angle: true }, { prop: 'skew', component: 'y', relative: false, angle: true }];
    case 'skewX':
      return [{ prop: 'skew', component: 'x', relative: false, angle: true }];
    case 'skewY':
      return [{ prop: 'skew', component: 'y', relative: false, angle: true }];
    case 'color':
    case 'backgroundColor':
      return [{ prop: 'fill', relative: false, angle: false }];
    default:
      return UNSUPPORTED_PROPS.has(key) ? undefined : [{ prop: key, relative: false, angle: false }];
  }
}

function channelKey(c: Channel): string {
  return c.component !== undefined ? `${c.prop}.${c.component}` : c.prop;
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
}

/** Normalisiert CSS-Farben (`#rgb`, `#rrggbbaa`, `rgb()`, `rgba()`) auf IR-Farben. */
function normalizeColor(text: string): string | undefined {
  const t = text.trim();
  const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.exec(t)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex;
    const out = `#${full.toUpperCase()}`;
    return out.length === 9 && out.endsWith('FF') ? out.slice(0, 7) : out;
  }
  const rgb = /^rgba?\(([^)]*)\)$/iu.exec(t);
  if (rgb === null) return undefined;
  const parts = (rgb[1] ?? '').split(/[\s,/]+/u).filter((p) => p.length > 0);
  if (parts.length < 3) return undefined;
  const channel = (p: string | undefined) => (p?.endsWith('%') === true ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
  const values = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
  if (values.some((v) => !Number.isFinite(v)) || !Number.isFinite(alpha)) return undefined;
  return `#${values.map(hex2).join('')}${alpha >= 1 ? '' : hex2(alpha * 255)}`;
}

function formatMs(ms: number): string {
  const r = Math.round(ms * 1000) / 1000;
  return `${Object.is(r, -0) ? '0' : String(r)}ms`;
}

/**
 * Timeline wie `createTimeline()` in Anime.js v4. Einträge werden mit {@link Timeline.add}
 * hinzugefügt; {@link Timeline.toPatches} erzeugt die IR-Änderungen.
 */
export class Timeline {
  private readonly plans: Plan[] = [];
  private readonly entries: EntryInfo[] = [];
  private readonly labels = new Map<string, number>();
  private readonly addDiagnostics: Diagnostic[] = [];
  private end = 0;
  private previousStart = 0;
  private previousEnd = 0;

  constructor(private readonly options: TimelineOptions = {}) {
    if (options.autoplay !== undefined) this.addDiagnostics.push(note('OV_ANIME_IGNORED', 'timeline.autoplay', 'autoplay is ignored: OpenVideo owns the clock.', 'Remove autoplay; the video plays the timeline.'));
    if (options.loop !== undefined && options.loop !== false && options.loop !== 0) {
      this.addDiagnostics.push(lossy('timeline.loop', 'Timeline-level loop is not supported; the timeline plays once.', 'Loop single entries with `loop`, or set timing.loop on a parent group.'));
    }
    if (options.alternate === true) this.addDiagnostics.push(lossy('timeline.alternate', 'Timeline-level alternate is not supported.', 'Use `alternate` on single entries.'));
  }

  /** Gesamtdauer in Millisekunden. */
  get duration(): number {
    return this.end;
  }

  /** Diagnosen, die beim Hinzufügen entstanden sind. */
  get diagnostics(): readonly Diagnostic[] {
    return this.addDiagnostics;
  }

  /**
   * Setzt ein Label an eine Position (Standard: Ende der Timeline).
   *
   * @example
   * ```ts
   * createTimeline().add('a', { x: 100 }).label('intro-done').add('b', { opacity: 0 }, 'intro-done+=200');
   * ```
   */
  label(name: string, position?: TimePosition): this {
    this.labels.set(name, this.resolvePosition(position));
    return this;
  }

  /**
   * Fügt eine Animation der Ziele hinzu.
   *
   * @example
   * ```ts
   * createTimeline()
   *   .add('#title', { y: [40, 0], opacity: [0, 1], duration: 600, ease: 'outCubic' })
   *   .add('#subtitle', { opacity: 1 }, '-=300');
   * ```
   */
  add(targets: Targets, params: AnimationParams, position?: TimePosition): this {
    const start = this.resolvePosition(position);
    const entry = this.entries.length;
    const path = `timeline[${String(entry)}]`;
    const ids = this.resolveTargets(targets, path);
    const direction = params['direction'];
    const info: EntryInfo = {
      ...(params.loop !== undefined ? { loop: params.loop } : {}),
      alternate: params.alternate === true || direction === 'alternate',
      reversed: params.reversed === true || direction === 'reverse',
    };
    this.entries.push(info);
    if (params.autoplay !== undefined) this.addDiagnostics.push(note('OV_ANIME_IGNORED', `${path}.autoplay`, 'autoplay is ignored: OpenVideo owns the clock.', 'Remove autoplay; the video plays the timeline.'));
    const defaults = this.options.defaults ?? {};
    const easeInput = params.ease ?? params['easing'] ?? defaults.ease;
    const entryEase = easeInput === undefined ? DEFAULT_EASE : this.ease(easeInput, `${path}.ease`);
    let entryEnd = start;
    const properties = Object.keys(params).filter((k) => !CONTROL_KEYS.has(k));
    for (const key of properties) {
      if (CALLBACK.test(key)) {
        this.addDiagnostics.push(lossy(`${path}.${key}`, `Callback "${key}" is not run: the IR has no scripting hooks.`, 'Express the effect as another timeline entry.'));
      } else if (IGNORED_KEYS.has(key)) {
        this.addDiagnostics.push(lossy(`${path}.${key}`, `Parameter "${key}" is not supported and was ignored.`, 'Remove the parameter or model its effect with more entries.'));
      }
    }
    ids.forEach((target, index) => {
      const total = ids.length;
      const duration = this.number(params.duration ?? defaults.duration ?? 1000, target, index, total, `${path}.duration`);
      const delay = this.number(params.delay ?? defaults.delay ?? 0, target, index, total, `${path}.delay`);
      for (const key of properties) {
        if (CALLBACK.test(key) || IGNORED_KEYS.has(key)) continue;
        const end = this.addProperty(entry, target, index, total, key, params[key], start + delay, duration, entryEase, `${path}.${key}`);
        entryEnd = Math.max(entryEnd, end);
      }
    });
    this.previousStart = start;
    this.previousEnd = entryEnd;
    this.end = Math.max(this.end, entryEnd);
    return this;
  }

  /** Übersetzt die Timeline in `setProperty`-Patches mit `$keyframes` und liefert alle Diagnosen. */
  compile(project: Readonly<Record<string, unknown>>): CompiledTimeline {
    const diagnostics: Diagnostic[] = [...this.addDiagnostics];
    const groups = new Map<string, Plan[]>();
    for (const plan of this.plans) {
      const key = `${plan.target}\u0000${plan.channel}`;
      const list = groups.get(key) ?? [];
      list.push(plan);
      groups.set(key, list);
    }
    // Kanäle je Node-Property sammeln (Vektoren haben zwei Kanäle).
    const perProperty = new Map<string, { target: string; prop: string; channels: Map<string, Key[]>; entries: Set<number> }>();
    for (const plans of groups.values()) {
      const [first] = plans;
      if (first === undefined) continue;
      const node = findNode(project, first.target);
      if (node === undefined) continue;
      const [prop = first.channel, component] = first.channel.split('.');
      const keys = this.resolveChannel(plans, node, prop, component, diagnostics);
      const id = `${first.target}\u0000${prop}`;
      const bucket = perProperty.get(id) ?? { target: first.target, prop, channels: new Map<string, Key[]>(), entries: new Set<number>() };
      bucket.channels.set(component ?? '', keys);
      for (const p of plans) bucket.entries.add(p.entry);
      perProperty.set(id, bucket);
    }
    for (const target of new Set(this.plans.map((p) => p.target))) {
      if (findNode(project, target) === undefined) {
        diagnostics.push(lossy(`targets.${target}`, `Target node "${target}" does not exist; its animation was dropped.`, 'Use node ids from scene.tree as targets.', target));
      }
    }
    const patches: Patch[] = [];
    for (const bucket of perProperty.values()) {
      const node = findNode(project, bucket.target);
      if (node === undefined) continue;
      const existing = node[bucket.prop];
      if (isRecord(existing) && Object.keys(existing).some((k) => k.startsWith('$'))) {
        diagnostics.push(lossy(`nodes.${bucket.target}.${bucket.prop}`, `The existing animation of "${bucket.prop}" is replaced.`, 'Combine both animations in one timeline.', bucket.target));
      }
      const keys = bucket.channels.has('') ? (bucket.channels.get('') ?? []) : this.mergeVector(bucket.channels, node, bucket.prop, diagnostics);
      const value: Record<string, unknown> = { $keyframes: keys.map((k) => ({ t: formatMs(k.t), v: k.v, ...(k.ease !== undefined ? { ease: k.ease } : {}) })) };
      this.applyLoop(value, bucket.entries, `nodes.${bucket.target}.${bucket.prop}`, diagnostics);
      patches.push({ op: 'setProperty', nodeId: bucket.target, property: bucket.prop, value });
    }
    return { patches, diagnostics };
  }

  /**
   * Liefert die Patches (`setProperty` mit `$keyframes`) für ein Project.
   *
   * @example
   * ```ts
   * const patches = createTimeline().add('logo', { x: 200 }).toPatches(project);
   * ```
   */
  toPatches(project: Readonly<Record<string, unknown>>): Patch[] {
    return this.compile(project).patches;
  }

  // -------------------------------------------------------------------------

  private ease(input: unknown, path: string): string {
    const mapped = mapEase(input, path);
    this.addDiagnostics.push(...mapped.diagnostics);
    return mapped.ease;
  }

  private number(value: unknown, target: string, index: number, total: number, path: string): number {
    const v: unknown = typeof value === 'function' ? Reflect.apply(value, undefined, [target, index, total]) : value;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
    const parsed = typeof v === 'string' ? /^(-?[0-9.]+)\s*(ms|s)?$/u.exec(v.trim()) : null;
    if (parsed !== null) return Math.max(0, Number(parsed[1]) * (parsed[2] === 's' ? 1000 : 1));
    throw new OpenVideoError({ code: 'OV_ANIME_INVALID', errorClass: 'AnimeAdapterError', problem: `${path} must be a number of milliseconds, got ${JSON.stringify(v)}.`, path, suggestions: ['duration: 600'] });
  }

  private resolveTargets(targets: Targets, path: string): string[] {
    const list = typeof targets === 'string' ? targets.split(',').map((t) => t.trim()) : [...targets];
    const out: string[] = [];
    for (const t of list) {
      const id = t.startsWith('#') ? t.slice(1) : t;
      if (/^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9_-]+)*$/u.test(id)) out.push(id);
      else this.addDiagnostics.push(lossy(`${path}.targets`, `Target "${t}" is not a node id; CSS selectors other than #id are not supported.`, 'Pass node ids, e.g. "logo" or "#logo".'));
    }
    return out;
  }

  private resolvePosition(position: TimePosition | undefined): number {
    if (position === undefined) return this.end;
    if (typeof position === 'number') return Math.max(0, position);
    const text = position.trim();
    const m = /^(<<|<)?(?:([+-])=\s*([0-9.]+))?$/u.exec(text);
    if (m !== null && text.length > 0) {
      const base = m[1] === '<<' ? this.previousStart : m[1] === '<' ? this.previousEnd : this.end;
      const delta = m[3] !== undefined ? Number(m[3]) * (m[2] === '-' ? -1 : 1) : 0;
      return Math.max(0, base + delta);
    }
    const label = /^([A-Za-z_][\w-]*)(?:([+-])=\s*([0-9.]+))?$/u.exec(text);
    const at = label !== null ? this.labels.get(label[1] ?? '') : undefined;
    if (label === null || at === undefined) {
      throw new OpenVideoError({
        code: 'OV_ANIME_POSITION',
        errorClass: 'AnimeAdapterError',
        problem: `Unknown timeline position ${JSON.stringify(position)}.`,
        suggestions: ['Use ms (500), "+=100", "-=100", "<", "<<", "<+=50" or a label defined with .label(name).'],
      });
    }
    const delta = label[3] !== undefined ? Number(label[3]) * (label[2] === '-' ? -1 : 1) : 0;
    return Math.max(0, at + delta);
  }

  private parseValue(raw: unknown, channel: Channel, path: string): Value | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { kind: 'num', n: raw };
    if (typeof raw !== 'string') {
      this.addDiagnostics.push(lossy(path, `Value ${JSON.stringify(raw)} is not supported.`, 'Use numbers, strings with units or colors.'));
      return undefined;
    }
    const text = raw.trim();
    const m = /^(?:([+\-*])=)?\s*(-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?)\s*(px|deg|turn|rad|%)?$/iu.exec(text);
    if (m !== null) {
      const unit = (m[3] ?? '').toLowerCase();
      if (unit === '%') {
        this.addDiagnostics.push(lossy(path, `Percent value "${text}" cannot be resolved without layout; the property was skipped.`, 'Use pixel values.'));
        return undefined;
      }
      let n = Number(m[2]);
      if (unit === 'turn') n *= 360;
      else if (unit === 'rad') n = (n * 180) / Math.PI;
      if ((unit === 'turn' || unit === 'rad' || unit === 'deg') && !channel.angle) {
        this.addDiagnostics.push(lossy(path, `Angle unit "${unit}" on "${channel.prop}" was converted to degrees.`, 'Use angle units only on rotate or skew.'));
      }
      const op = m[1];
      return op === '+' || op === '-' || op === '*' ? { kind: 'rel', op, n } : { kind: 'num', n };
    }
    const color = normalizeColor(text);
    return { kind: 'str', s: color ?? text };
  }

  /** Legt die Segmente einer Property für ein Ziel an und liefert deren Ende (ms). */
  private addProperty(entry: number, target: string, index: number, total: number, key: string, rawIn: unknown, start: number, duration: number, ease: string, path: string): number {
    const channels = channelsOf(key);
    if (channels === undefined) {
      if (index === 0) this.addDiagnostics.push(lossy(path, `Property "${key}" (3D CSS transform) is not supported and was skipped.`, 'Use a scene3d node for 3D motion.'));
      return start;
    }
    const raw: unknown = typeof rawIn === 'function' ? Reflect.apply(rawIn, undefined, [target, index, total]) : rawIn;
    interface Step {
      readonly from?: unknown;
      readonly to: unknown;
      readonly duration?: unknown;
      readonly delay?: unknown;
      readonly ease?: unknown;
    }
    let steps: Step[];
    let propDuration = duration;
    let propDelay = 0;
    let propEase = ease;
    const resolve = (v: unknown): unknown => (typeof v === 'function' ? Reflect.apply(v, undefined, [target, index, total]) : v);
    if (Array.isArray(raw)) {
      const items: unknown[] = raw.map(resolve);
      if (items.every(isRecord)) {
        steps = items.filter(isRecord).map((s) => ({ ...(s['from'] !== undefined ? { from: resolve(s['from']) } : {}), to: resolve(s['to'] ?? s['value']), duration: s['duration'], delay: s['delay'], ease: s['ease'] ?? s['easing'] }));
      } else if (items.length === 2) {
        steps = [{ from: items[0], to: items[1] }];
      } else {
        steps = items.map((to) => ({ to }));
      }
    } else if (isRecord(raw)) {
      propDuration = raw['duration'] !== undefined ? this.number(raw['duration'], target, index, total, `${path}.duration`) : duration;
      propDelay = raw['delay'] !== undefined ? this.number(raw['delay'], target, index, total, `${path}.delay`) : 0;
      const e = raw['ease'] ?? raw['easing'];
      if (e !== undefined && index === 0) propEase = this.ease(e, `${path}.ease`);
      else if (e !== undefined) propEase = mapEase(e, `${path}.ease`).ease;
      steps = [{ ...(raw['from'] !== undefined ? { from: resolve(raw['from']) } : {}), to: resolve(raw['to'] ?? raw['value']) }];
    } else {
      steps = [{ to: raw }];
    }
    let t = start + propDelay;
    const perStep = steps.length > 0 ? propDuration / steps.length : propDuration;
    for (const [i, step] of steps.entries()) {
      const stepPath = steps.length > 1 ? `${path}[${String(i)}]` : path;
      t += step.delay !== undefined ? this.number(step.delay, target, index, total, `${stepPath}.delay`) : 0;
      const d = step.duration !== undefined ? this.number(step.duration, target, index, total, `${stepPath}.duration`) : perStep;
      const stepEase = step.ease === undefined ? propEase : index === 0 ? this.ease(step.ease, `${stepPath}.ease`) : mapEase(step.ease, `${stepPath}.ease`).ease;
      for (const channel of channels) {
        const to = this.parseValue(step.to, channel, stepPath);
        const from = step.from !== undefined ? this.parseValue(step.from, channel, stepPath) : undefined;
        if (to === undefined) continue;
        this.plans.push({ entry, target, channel: channelKey(channel), start: t, end: t + d, ...(from !== undefined ? { from } : {}), to, ease: stepEase, path: stepPath });
      }
      t += d;
    }
    return t;
  }

  /** Löst die Segmente eines Kanals in Keyframes (IR-Werte) auf. */
  private resolveChannel(plansIn: readonly Plan[], node: Readonly<Record<string, unknown>>, prop: string, component: string | undefined, diagnostics: Diagnostic[]): Key[] {
    const plans = [...plansIn].sort((a, b) => a.start - b.start);
    const relative = prop === 'x' || prop === 'y';
    const base = baseValue(node, prop, component);
    interface Seg {
      start: number;
      end: number;
      from: unknown;
      to: unknown;
      ease: string;
      entry: number;
      path: string;
    }
    const segs: Seg[] = [];
    let current: unknown = base;
    const toIr = (v: Value, reference: unknown): unknown => {
      if (v.kind === 'str') return v.s;
      if (v.kind === 'num') return relative && typeof base === 'number' ? base + v.n : v.n;
      const ref = typeof reference === 'number' ? reference : 0;
      return v.op === '+' ? ref + v.n : v.op === '-' ? ref - v.n : ref * v.n;
    };
    for (const plan of plans) {
      const prev = segs[segs.length - 1];
      if (prev !== undefined && plan.start < prev.end - 1e-9) {
        diagnostics.push(lossy(plan.path, `Tween overlaps an earlier tween on "${prop}" of "${plan.target}"; the earlier tween is cut at ${formatMs(plan.start)}.`, 'Move the entry so tweens on the same property do not overlap.', plan.target));
        const span = prev.end - prev.start;
        const p = span > 0 ? (plan.start - prev.start) / span : 1;
        const cut = typeof prev.from === 'number' && typeof prev.to === 'number' ? prev.from + (prev.to - prev.from) * easing(prev.ease)(p) : p < 1 ? prev.from : prev.to;
        prev.end = plan.start;
        prev.to = cut;
        current = cut;
      }
      const from = plan.from !== undefined ? toIr(plan.from, current) : current;
      const to = toIr(plan.to, from);
      if (from === undefined) {
        diagnostics.push(lossy(plan.path, `Property "${prop}" of "${plan.target}" has no start value; the tween jumps to its end value.`, 'Give a start value with [from, to].', plan.target));
      }
      segs.push({ start: plan.start, end: plan.end, from: from ?? to, to, ease: plan.ease, entry: plan.entry, path: plan.path });
      current = to;
    }
    // reversed: Segmente eines Eintrags zeitlich spiegeln.
    for (const [entryIndex, info] of this.entries.entries()) {
      if (!info.reversed) continue;
      const own = segs.filter((s) => s.entry === entryIndex);
      if (own.length === 0) continue;
      const lo = Math.min(...own.map((s) => s.start));
      const hi = Math.max(...own.map((s) => s.end));
      for (const s of own) {
        const reversed = reverseEase(s.ease);
        if (reversed === undefined) diagnostics.push(lossy(s.path, `Easing "${s.ease}" cannot be reversed; "linear" is used.`, 'Use a named easing or cubicBezier() with reversed.'));
        [s.start, s.end] = [lo + hi - s.end, lo + hi - s.start];
        [s.from, s.to] = [s.to, s.from];
        s.ease = reversed ?? 'linear';
      }
      segs.sort((a, b) => a.start - b.start);
    }
    const keys: Key[] = [];
    for (const s of segs) {
      const last = keys[keys.length - 1];
      if (last === undefined || last.t < s.start - 1e-9 || JSON.stringify(last.v) !== JSON.stringify(s.from)) {
        // Vor dem Start gilt der alte Wert; zum Start springt er auf den Startwert.
        keys.push({ t: s.start, v: s.from, ...(last !== undefined ? { ease: 'hold' } : {}) });
      }
      keys.push({ t: s.end, v: s.to, ease: s.ease });
    }
    return keys;
  }

  /** Führt Vektor-Kanäle (`scale.x`, `scale.y`) zu einer Keyframe-Liste zusammen. */
  private mergeVector(channels: ReadonlyMap<string, Key[]>, node: Readonly<Record<string, unknown>>, prop: string, diagnostics: Diagnostic[]): Key[] {
    const xs = channels.get('x');
    const ys = channels.get('y');
    const bx = baseValue(node, prop, 'x');
    const by = baseValue(node, prop, 'y');
    const times = [...new Set([...(xs ?? []), ...(ys ?? [])].map((k) => k.t))].sort((a, b) => a - b);
    const aligned = xs !== undefined && ys !== undefined && xs.length === ys.length && xs.every((k, i) => k.t === ys[i]?.t && k.ease === ys[i].ease);
    if (!aligned && xs !== undefined && ys !== undefined) {
      diagnostics.push(lossy(`nodes.${prop}`, `The x and y parts of "${prop}" have different timing; they were merged at shared keyframe times with linear interpolation in between.`, `Animate both parts with the same timing, e.g. { ${prop}: 1.2 }.`));
    }
    return times.map((t) => {
      const kx = xs?.find((k) => k.t === t);
      const ease = kx?.ease ?? ys?.find((k) => k.t === t)?.ease;
      const v = { x: xs !== undefined ? sample(xs, t) : bx, y: ys !== undefined ? sample(ys, t) : by };
      return { t, v, ...(ease !== undefined ? { ease: aligned || xs === undefined || ys === undefined ? ease : 'linear' } : {}) };
    });
  }

  private applyLoop(value: Record<string, unknown>, entries: ReadonlySet<number>, path: string, diagnostics: Diagnostic[]): void {
    const looping = [...entries].map((e) => ({ e, info: this.entries[e] })).filter(({ info }) => info !== undefined && ((info.loop !== undefined && info.loop !== false && info.loop !== 0) || info.alternate));
    if (looping.length === 0) return;
    const [only] = looping;
    if (entries.size > 1 || only === undefined) {
      diagnostics.push(lossy(path, 'loop/alternate on an entry that shares a property with other entries is not supported; the property plays once.', 'Loop only properties that a single entry animates.'));
      return;
    }
    const loop = only.info?.loop;
    const alternate = only.info?.alternate === true;
    if (loop === undefined || loop === false || loop === 0) {
      diagnostics.push(lossy(path, 'alternate without loop only plays forward once.', 'Add loop: 1 or more to alternate.'));
      return;
    }
    value['loop'] = alternate ? 'pingpong' : 'repeat';
    value['repeat'] = loop === true ? 'infinite' : Math.max(1, Math.round(loop) + 1);
  }
}

interface Key {
  readonly t: number;
  readonly v: unknown;
  readonly ease?: string;
}

/** Wert einer numerischen Keyframe-Liste zur Zeit t (ms). */
function sample(keys: readonly Key[], t: number): unknown {
  const [first] = keys;
  if (first === undefined) return undefined;
  if (t <= first.t) return first.v;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (a === undefined || b === undefined || t > b.t) continue;
    if (typeof a.v !== 'number' || typeof b.v !== 'number' || b.t === a.t) return t < b.t ? a.v : b.v;
    return a.v + (b.v - a.v) * easing(b.ease)((t - a.t) / (b.t - a.t));
  }
  return keys[keys.length - 1]?.v;
}

const DEFAULTS: Readonly<Record<string, number>> = { opacity: 1, rotation: 0, x: 0, y: 0, 'scale.x': 1, 'scale.y': 1, 'skew.x': 0, 'skew.y': 0 };

/** Aktueller Literal-Wert einer Node-Property (oder Standard). */
function baseValue(node: Readonly<Record<string, unknown>>, prop: string, component: string | undefined): unknown {
  let v = node[prop];
  if (isRecord(v) && Array.isArray(v['$keyframes'])) {
    const first: unknown = v['$keyframes'][0];
    v = isRecord(first) ? first['v'] : undefined;
  }
  if (component !== undefined) v = isRecord(v) ? v[component] : undefined;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return DEFAULTS[component !== undefined ? `${prop}.${component}` : prop];
}

function findIn(list: readonly unknown[], id: string): Readonly<Record<string, unknown>> | undefined {
  for (const n of list) {
    if (!isRecord(n)) continue;
    if (n['id'] === id) return n;
    const children = n['children'];
    if (Array.isArray(children)) {
      const hit = findIn(children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function findNode(project: Readonly<Record<string, unknown>>, id: string): Readonly<Record<string, unknown>> | undefined {
  const comps = project['compositions'];
  if (!Array.isArray(comps)) return undefined;
  for (const c of comps) {
    const nodes = isRecord(c) ? c['nodes'] : undefined;
    const hit = Array.isArray(nodes) ? findIn(nodes, id) : undefined;
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Erzeugt eine Timeline wie `createTimeline()` in Anime.js v4.
 *
 * @example
 * ```ts
 * const tl = createTimeline({ defaults: { duration: 500, ease: 'outQuad' } })
 *   .add('a', { x: 100 })
 *   .add('b', { opacity: [0, 1] }, '-=200')
 *   .add('c', { rotate: '1turn' }, '<<');
 * ```
 */
export function createTimeline(options: TimelineOptions = {}): Timeline {
  return new Timeline(options);
}

/**
 * Erzeugt eine einzelne Animation wie `animate()` in Anime.js v4 (eine Timeline mit einem Eintrag bei 0 ms).
 *
 * @example
 * ```ts
 * const patches = animate('#logo', { scale: [0.8, 1], opacity: [0, 1], duration: 800, ease: 'outBack' }).toPatches(project);
 * ```
 */
export function animate(targets: Targets, params: AnimationParams): Timeline {
  return new Timeline().add(targets, params, 0);
}

/** Ergebnis von {@link applyTimeline}: Patch-Ergebnis plus alle Diagnosen. */
export interface AppliedTimeline extends PatchResult {
  readonly patches: readonly Patch[];
}

/**
 * Wendet eine Timeline über `applyPatches` aus `core` auf ein Project an.
 *
 * @example
 * ```ts
 * const r = applyTimeline(project, createTimeline().add('logo', { x: 200 }));
 * if (r.ok) project = r.project;
 * ```
 */
export function applyTimeline(project: Readonly<Record<string, unknown>>, timeline: Timeline): AppliedTimeline {
  const compiled = timeline.compile(project);
  const result = applyPatches(project, compiled.patches);
  return { ...result, patches: compiled.patches, diagnostics: [...compiled.diagnostics, ...result.diagnostics] };
}
