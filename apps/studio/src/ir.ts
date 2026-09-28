/**
 * Reine Hilfen rund um die Composition IR: Nodes finden, IDs vergeben,
 * Zeiten umrechnen, animierte Werte lesen. Keine React- und keine DOM-Abhängigkeit.
 */
import { evaluateAnimated, framesToSmpte, isAnimated, isRecord, resolveMarkers, toFrames } from '@agentic-video/core';
import { num, records, type PatchJson, type Rec } from './json.js';

/** Fundstelle einer Node in der IR. */
export interface Located {
  readonly node: Rec;
  readonly parentId: string | null;
  readonly index: number;
  readonly depth: number;
}

/**
 * Besucht alle Nodes (Tiefe zuerst, in Zeichenreihenfolge).
 *
 * @example
 * ```ts
 * walkNodes(comp['nodes'], (n) => console.log(n['id']));
 * ```
 */
export function walkNodes(list: unknown, fn: (node: Rec, where: Located) => void, parentId: string | null = null, depth = 0): void {
  records(list).forEach((node, index) => {
    fn(node, { node, parentId, index, depth });
    walkNodes(node['children'], fn, typeof node['id'] === 'string' ? node['id'] : null, depth + 1);
  });
}

/**
 * Sucht eine Node per ID.
 *
 * @example
 * ```ts
 * findNode(comp, 'title')?.node['type']; // 'text'
 * ```
 */
export function findNode(comp: Readonly<Rec> | undefined, id: string): Located | undefined {
  let hit: Located | undefined;
  walkNodes(comp?.['nodes'], (node, where) => {
    if (hit === undefined && node['id'] === id) hit = where;
  });
  return hit;
}

/**
 * Alle Node-IDs einer Composition (auch in Masken).
 *
 * @example
 * ```ts
 * allIds(comp).has('title'); // true
 * ```
 */
export function allIds(comp: Readonly<Rec> | undefined): Set<string> {
  const ids = new Set<string>();
  const visit = (node: Rec): void => {
    if (typeof node['id'] === 'string') ids.add(node['id']);
    const mask = node['mask'];
    if (isRecord(mask) && isRecord(mask['node'])) visit(mask['node']);
  };
  walkNodes(comp?.['nodes'], visit);
  return ids;
}

/**
 * Liefert eine freie ID aus einem Wunschnamen.
 *
 * @example
 * ```ts
 * uniqueId('title', new Set(['title'])); // 'title-2'
 * ```
 */
export function uniqueId(base: string, taken: Set<string>): string {
  const clean = base.replace(/[^A-Za-z0-9_-]/gu, '-').replace(/^[^A-Za-z]+/u, '') || 'node';
  let id = clean;
  for (let i = 2; taken.has(id); i++) id = `${clean}-${String(i)}`;
  taken.add(id);
  return id;
}

/**
 * Kopiert eine Node mit neuen IDs (auch für Kinder und Masken).
 *
 * @example
 * ```ts
 * cloneWithNewIds({ id: 'a', type: 'rect' }, new Set(['a']))['id']; // 'a-copy'
 * ```
 */
export function cloneWithNewIds(node: Readonly<Rec>, taken: Set<string>): Rec {
  const copy: unknown = JSON.parse(JSON.stringify(node));
  const renew = (n: Rec): void => {
    const id = typeof n['id'] === 'string' ? n['id'] : 'node';
    n['id'] = uniqueId(id.endsWith('-copy') || /-copy-\d+$/u.test(id) ? id.replace(/-\d+$/u, '') : `${id}-copy`, taken);
    for (const child of records(n['children'])) renew(child);
    const mask = n['mask'];
    if (isRecord(mask) && isRecord(mask['node'])) renew(mask['node']);
  };
  if (!isRecord(copy)) return { id: uniqueId('node', taken), type: 'group' };
  renew(copy);
  return copy;
}

/**
 * Entfernt IDs, deren Vorfahre auch gewählt ist (für Löschen, Gruppieren, Kopieren).
 *
 * @example
 * ```ts
 * topLevel(comp, ['group', 'group-child']); // ['group']
 * ```
 */
export function topLevel(comp: Readonly<Rec> | undefined, ids: readonly string[]): string[] {
  const chosen = new Set(ids);
  const parents = new Map<string, string | null>();
  walkNodes(comp?.['nodes'], (node, where) => {
    if (typeof node['id'] === 'string') parents.set(node['id'], where.parentId);
  });
  return ids.filter((id) => {
    for (let p = parents.get(id) ?? null; p !== null; p = parents.get(p) ?? null) if (chosen.has(p)) return false;
    return parents.has(id);
  });
}

/** Zeitkontext einer Composition. */
export interface TimeInfo {
  readonly fps: number;
  readonly markers: ReadonlyMap<string, number>;
}

/**
 * Liest fps und Marker einer Composition.
 *
 * @example
 * ```ts
 * timeInfo({ fps: 30, markers: [{ id: 'a', time: '1s' }] }).markers.get('a'); // 30
 * ```
 */
export function timeInfo(comp: Readonly<Rec> | undefined): TimeInfo {
  const fps = num(comp?.['fps'], 30);
  const markers = resolveMarkers(
    records(comp?.['markers']).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })),
    fps,
  );
  return { fps, markers };
}

/**
 * Rechnet einen Zeitwert (Frames, "2s", "marker:x") in Frames um.
 *
 * @example
 * ```ts
 * frames('1s', { fps: 30, markers: new Map() }); // 30
 * ```
 */
export function frames(value: unknown, time: TimeInfo, fallback = 0): number {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  try {
    return toFrames(value, { fps: time.fps, markers: time.markers });
  } catch {
    return fallback;
  }
}

/**
 * Zeigt einen Frame als Frame-Nummer oder SMPTE-Timecode.
 *
 * @example
 * ```ts
 * formatFrame(45, 30, 'smpte'); // '00:00:01:15'
 * ```
 */
export function formatFrame(frame: number, fps: number, mode: 'frames' | 'smpte'): string {
  return mode === 'smpte' ? framesToSmpte(Math.max(0, Math.round(frame)), fps) : String(Math.round(frame));
}

/**
 * Wertet einen (vielleicht animierten) Wert am lokalen Frame aus.
 *
 * @example
 * ```ts
 * valueAt({ $keyframes: [{ t: 0, v: 0 }, { t: 10, v: 100 }] }, 5, 30, 60); // 50
 * ```
 */
export function valueAt(value: unknown, localFrame: number, fps: number, durationFrames: number): unknown {
  if (!isAnimated(value)) return value;
  try {
    return evaluateAnimated(value, { frame: localFrame, fps, seed: 0, durationFrames });
  } catch {
    return undefined;
  }
}

/**
 * Prüft, ob ein Wert mit Keyframes animiert ist.
 *
 * @example
 * ```ts
 * hasKeyframes({ $keyframes: [] }); // true
 * ```
 */
export function hasKeyframes(value: unknown): value is Rec & { $keyframes: unknown[] } {
  return isRecord(value) && Array.isArray(value['$keyframes']);
}

/**
 * Patches, die eine Zahl-Property am lokalen Frame auf `next` setzen:
 * statische Werte direkt, Keyframe-Animationen über einen Keyframe an dieser Stelle.
 * Andere Animationen (Expression, Feder …) lassen sich nicht direkt setzen.
 *
 * @example
 * ```ts
 * setNumberAt('box', 'x', 40, 120, 0); // [{ op: 'setProperty', nodeId: 'box', property: 'x', value: 120 }]
 * ```
 */
export function setNumberAt(nodeId: string, property: string, current: unknown, next: number, localFrame: number): PatchJson[] | undefined {
  const value = Math.round(next * 100) / 100;
  if (current === undefined || typeof current === 'number') return [{ op: 'setProperty', nodeId, property, value }];
  if (hasKeyframes(current)) return [{ op: 'addKeyframe', nodeId, property, keyframe: { t: Math.max(0, Math.round(localFrame)), v: value } }];
  return undefined;
}

/** Häufige Easing-Namen für Auswahllisten. */
export const EASINGS: readonly string[] = [
  'linear',
  'hold',
  'ease',
  'easeIn',
  'easeOut',
  'easeInOut',
  'easeInSine',
  'easeOutSine',
  'easeInOutSine',
  'easeInQuad',
  'easeOutQuad',
  'easeInOutQuad',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeInQuart',
  'easeOutQuart',
  'easeInOutQuart',
  'easeInExpo',
  'easeOutExpo',
  'easeInOutExpo',
  'easeInBack',
  'easeOutBack',
  'easeInOutBack',
  'easeOutElastic',
  'easeOutBounce',
];

const BEZIER_ALIASES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
  easeInSine: [0.12, 0, 0.39, 0],
  easeOutSine: [0.61, 1, 0.88, 1],
  easeInOutSine: [0.37, 0, 0.63, 1],
  easeInQuad: [0.11, 0, 0.5, 0],
  easeOutQuad: [0.5, 1, 0.89, 1],
  easeInOutQuad: [0.45, 0, 0.55, 1],
  easeInCubic: [0.32, 0, 0.67, 0],
  easeOutCubic: [0.33, 1, 0.68, 1],
  easeInOutCubic: [0.65, 0, 0.35, 1],
};

/**
 * Liest die Bezier-Griffe eines Easings (für den Kurven-Editor).
 *
 * @example
 * ```ts
 * bezierOf('cubic-bezier(0.4, 0, 0.2, 1)'); // [0.4, 0, 0.2, 1]
 * ```
 */
export function bezierOf(ease: string | undefined): [number, number, number, number] {
  const alias = BEZIER_ALIASES[ease ?? 'linear'];
  if (alias !== undefined) return [...alias];
  const m = /^cubic-bezier\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)$/u.exec(ease ?? '');
  if (m === null) return [0, 0, 1, 1];
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/**
 * Schreibt Bezier-Griffe als Easing-Text.
 *
 * @example
 * ```ts
 * bezierText([0.4, 0, 0.2, 1]); // 'cubic-bezier(0.4, 0, 0.2, 1)'
 * ```
 */
export function bezierText(b: readonly [number, number, number, number]): string {
  const r = (n: number): string => String(Math.round(n * 1000) / 1000);
  return `cubic-bezier(${r(b[0])}, ${r(b[1])}, ${r(b[2])}, ${r(b[3])})`;
}
