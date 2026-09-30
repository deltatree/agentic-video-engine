/**
 * Reine Timeline-Logik (Story 20.6): Einrasten, Keyframes verschieben, Marker, Shuttle (J/K/L),
 * In/Out-Bereich und Keyframe-Sprung.
 */
import { frames, hasKeyframes, uniqueId, type TimeInfo } from './ir.js';
import { records, str, type Rec } from './json.js';

/**
 * Rastet einen Frame am nächsten Ziel innerhalb von `threshold` Frames ein.
 *
 * @example
 * ```ts
 * snapFrame(48, [0, 50, 90], 3); // { frame: 50, target: 50 }
 * snapFrame(40, [0, 50], 3); // { frame: 40 }
 * ```
 */
export function snapFrame(frame: number, targets: readonly number[], threshold: number): { frame: number; target?: number } {
  let best: number | undefined;
  for (const t of targets) if (Math.abs(t - frame) <= threshold && (best === undefined || Math.abs(t - frame) < Math.abs(best - frame))) best = t;
  return best !== undefined ? { frame: best, target: best } : { frame };
}

/**
 * Verschiebung (Frames) eines Zeitfensters, eingerastet mit Anfang oder Ende an einem Ziel.
 *
 * @example
 * ```ts
 * snapSpan(10, 20, 7, [30], 3); // { delta: 10, target: 30 } (Ende 27 → 30)
 * ```
 */
export function snapSpan(start: number, end: number, delta: number, targets: readonly number[], threshold: number): { delta: number; target?: number } {
  const a = snapFrame(start + delta, targets, threshold);
  const b = snapFrame(end + delta, targets, threshold);
  const da = a.target !== undefined ? Math.abs(a.frame - (start + delta)) : Infinity;
  const db = b.target !== undefined ? Math.abs(b.frame - (end + delta)) : Infinity;
  if (da === Infinity && db === Infinity) return { delta };
  if (da <= db && a.target !== undefined) return { delta: a.frame - start, target: a.target };
  if (b.target !== undefined) return { delta: b.frame - end, target: b.target };
  return { delta };
}

/**
 * Einrastziele der Timeline: Anfang, Ende, Playhead, Marker, In/Out, Kanten anderer Balken und Keyframes.
 *
 * @example
 * ```ts
 * timelineSnapTargets({ duration: 100, playhead: 42, markers: [], spans: [{ id: 'a', start: 3, end: 9 }] }); // [0, 100, 42, 3, 9]
 * ```
 */
export function timelineSnapTargets(input: {
  readonly duration: number;
  readonly playhead: number;
  readonly markers: readonly { readonly frame: number }[];
  readonly spans: readonly { readonly id: string; readonly start: number; readonly end: number; readonly keyframes?: readonly number[] }[];
  readonly exclude?: string;
  readonly inPoint?: number | undefined;
  readonly outPoint?: number | undefined;
}): number[] {
  const out = new Set<number>([0, input.duration, input.playhead]);
  for (const m of input.markers) out.add(m.frame);
  for (const s of input.spans) {
    if (s.id === input.exclude) continue;
    out.add(s.start);
    out.add(s.end);
    for (const k of s.keyframes ?? []) out.add(k);
  }
  if (input.inPoint !== undefined) out.add(input.inPoint);
  if (input.outPoint !== undefined) out.add(input.outPoint);
  return [...out];
}

/**
 * Verschiebt einen Keyframe (Index in `$keyframes`) auf einen neuen lokalen Frame.
 * Liegt dort schon ein anderer Keyframe, kommt `undefined` (nichts überschreiben).
 *
 * @example
 * ```ts
 * moveKeyframe({ $keyframes: [{ t: 0, v: 0 }, { t: 10, v: 1 }] }, 1, 20, time); // { $keyframes: [{ t: 0, v: 0 }, { t: 20, v: 1 }] }
 * ```
 */
export function moveKeyframe(value: unknown, index: number, frame: number, time: TimeInfo): Rec | undefined {
  if (!hasKeyframes(value)) return undefined;
  const list = records(value['$keyframes']);
  const key = list[index];
  if (key === undefined) return undefined;
  const target = Math.max(0, Math.round(frame));
  if (list.some((k, i) => i !== index && Math.round(frames(k['t'], time, -1)) === target)) return undefined;
  const next = list.map((k, i) => (i === index ? { ...k, t: target } : k)).sort((a, b) => frames(a['t'], time) - frames(b['t'], time));
  return { ...value, $keyframes: next };
}

/**
 * Neue Marker-Liste mit einem Marker am Frame.
 *
 * @example
 * ```ts
 * addMarker([], 30); // [{ id: 'marker', time: 30 }]
 * ```
 */
export function addMarker(markers: readonly Rec[], frame: number): Rec[] {
  const id = uniqueId('marker', new Set(markers.map((m) => str(m['id'], ''))));
  return [...markers, { id, time: Math.max(0, Math.round(frame)) }];
}

/**
 * Setzt das Label eines Markers (leer entfernt es). Die ID bleibt, damit `marker:<id>`-Zeiten gültig bleiben.
 *
 * @example
 * ```ts
 * renameMarker([{ id: 'm', time: 0 }], 'm', 'Intro'); // [{ id: 'm', time: 0, label: 'Intro' }]
 * ```
 */
export function renameMarker(markers: readonly Rec[], id: string, label: string): Rec[] {
  const clean = label.trim();
  return markers.map((m) => {
    if (m['id'] !== id) return m;
    if (clean === '') return Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'label'));
    return { ...m, label: clean };
  });
}

/**
 * Entfernt einen Marker. Wird er noch als `marker:<id>` benutzt, kommt ein Text mit dem Grund.
 *
 * @example
 * ```ts
 * removeMarker([{ id: 'm', time: 0 }], 'm', {}); // []
 * ```
 */
export function removeMarker(markers: readonly Rec[], id: string, comp: Readonly<Rec> | undefined): Rec[] | string {
  const text = JSON.stringify({ ...comp, markers: [] });
  if (text.includes(`"marker:${id}"`) || text.includes(`"marker:${id}+`) || text.includes(`"marker:${id}-`)) return `Marker "${id}" is still used as "marker:${id}". Change those times first.`;
  return markers.filter((m) => m['id'] !== id);
}

/**
 * Shuttle nach J/K/L: L vorwärts (wiederholt schneller, bis 8×), J rückwärts, K stoppt.
 *
 * @example
 * ```ts
 * shuttle(0, 'l'); // 1
 * shuttle(1, 'l'); // 2
 * shuttle(2, 'j'); // -1
 * ```
 */
export function shuttle(speed: number, key: 'j' | 'k' | 'l'): number {
  if (key === 'k') return 0;
  if (key === 'l') return speed <= 0 ? 1 : Math.min(8, speed * 2);
  return speed >= 0 ? -1 : Math.max(-8, speed * 2);
}

/**
 * Nächster Frame der Wiedergabe mit Tempo und optionalem In/Out-Bereich (Schleife darin).
 *
 * @example
 * ```ts
 * advanceFrame(99, 1, 100, undefined, undefined); // 0
 * advanceFrame(20, 1, 100, 10, 20); // 10
 * advanceFrame(10, -1, 100, 10, 20); // 20
 * ```
 */
export function advanceFrame(frame: number, step: number, duration: number, inPoint: number | undefined, outPoint: number | undefined): number {
  const lo = Math.max(0, Math.min(inPoint ?? 0, duration - 1));
  const hi = Math.max(lo, Math.min(outPoint ?? duration - 1, duration - 1));
  const next = frame + step;
  if (next > hi) return lo;
  if (next < lo) return hi;
  return next;
}

/**
 * Nächster (dir = 1) oder vorheriger (dir = −1) Keyframe-Frame nach `frame`.
 *
 * @example
 * ```ts
 * keyframeJump([[0, 10], [25]], 10, 1); // 25
 * keyframeJump([[0, 10], [25]], 10, -1); // 0
 * ```
 */
export function keyframeJump(lists: readonly (readonly number[])[], frame: number, dir: 1 | -1): number | undefined {
  const all = [...new Set(lists.flat().map((f) => Math.round(f)))].sort((a, b) => a - b);
  return dir === 1 ? all.find((f) => f > frame) : [...all].reverse().find((f) => f < frame);
}
