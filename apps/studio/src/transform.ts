/**
 * Transform-Griffe der Bühne (Story 20.4): Größe ändern (8 Griffe), Drehen, Rahmenauswahl.
 * Reine Geometrie in Composition-Pixeln; die Umrechnung in Patches folgt ADR 0004:
 * `x`, `y` ist die linke obere Ecke der lokalen Box, Skalierung und Drehung wirken um `origin`.
 */
import { isAnimated, isRecord } from '@agentic-video/core';
import type { Box } from './geometry.js';
import { setNumberAt } from './ir.js';
import type { PatchJson, Rec } from './json.js';

/** Ein Griff: Ecke oder Kantenmitte. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Alle acht Griffe (Reihenfolge für die Darstellung). */
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Neue Box nach dem Ziehen eines Griffs um `dx`, `dy`. Die gegenüberliegende Kante bleibt stehen;
 * `keepAspect` (Shift) hält das Seitenverhältnis; `fromCenter` (Alt) skaliert um die Mitte.
 * Mindestgröße 1 px; Ziehen über die Gegenkante hinaus spiegelt nicht, sondern stoppt.
 *
 * @example
 * ```ts
 * resizeBox({ x: 0, y: 0, width: 100, height: 50 }, 'se', 20, 10, false); // { x: 0, y: 0, width: 120, height: 60 }
 * ```
 */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number, keepAspect: boolean, fromCenter = false): Box {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');
  const k = fromCenter ? 2 : 1;
  let width = box.width + (east ? dx * k : west ? -dx * k : 0);
  let height = box.height + (south ? dy * k : north ? -dy * k : 0);
  if (keepAspect && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height;
    const horizontal = east || west;
    const vertical = north || south;
    if (horizontal && vertical) {
      // Die stärker gezogene Richtung bestimmt die Größe.
      if (Math.abs(width / box.width) >= Math.abs(height / box.height)) height = width / ratio;
      else width = height * ratio;
    } else if (horizontal) height = width / ratio;
    else width = height * ratio;
  }
  width = Math.max(1, width);
  height = Math.max(1, height);
  let x = box.x;
  let y = box.y;
  if (fromCenter) {
    x = box.x + (box.width - width) / 2;
    y = box.y + (box.height - height) / 2;
  } else {
    if (west) x = box.x + box.width - width;
    else if (!east) x = box.x + (box.width - width) / 2;
    if (north) y = box.y + box.height - height;
    else if (!south) y = box.y + (box.height - height) / 2;
  }
  return { x, y, width, height };
}

/**
 * Winkel (Grad) von `center` zu `point`, 0 = rechts, im Uhrzeigersinn (y nach unten).
 *
 * @example
 * ```ts
 * angleOf({ x: 0, y: 0 }, { x: 0, y: 10 }); // 90
 * ```
 */
export function angleOf(center: { x: number; y: number }, point: { x: number; y: number }): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

/**
 * Neue Drehung aus Start- und aktuellem Zeigerwinkel; `snap` rastet auf 15° ein.
 *
 * @example
 * ```ts
 * rotateBy(10, 0, 50, true); // 60
 * ```
 */
export function rotateBy(rotation: number, startAngle: number, angle: number, snap: boolean): number {
  let delta = angle - startAngle;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const next = rotation + delta;
  const rounded = snap ? Math.round(next / 15) * 15 : Math.round(next * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Nodes, deren Bounds den Rahmen schneiden (Rahmenauswahl).
 *
 * @example
 * ```ts
 * marqueeHits([{ id: 'a', bounds: { x: 0, y: 0, width: 10, height: 10 } }], { x: 5, y: 5, width: 20, height: 20 }); // ['a']
 * ```
 */
export function marqueeHits(nodes: readonly { readonly id: string; readonly bounds?: Box }[], rect: Box): string[] {
  const r = normalizeBox(rect);
  return nodes
    .filter((n) => {
      const b = n.bounds;
      return b !== undefined && b.x <= r.x + r.width && b.x + b.width >= r.x && b.y <= r.y + r.height && b.y + b.height >= r.y;
    })
    .map((n) => n.id);
}

/**
 * Box mit positiver Breite und Höhe aus zwei beliebigen Ecken.
 *
 * @example
 * ```ts
 * normalizeBox({ x: 10, y: 10, width: -5, height: -5 }); // { x: 5, y: 5, width: 5, height: 5 }
 * ```
 */
export function normalizeBox(b: Box): Box {
  return { x: Math.min(b.x, b.x + b.width), y: Math.min(b.y, b.y + b.height), width: Math.abs(b.width), height: Math.abs(b.height) };
}

/** Wert eines Vec2 oder einer Zahl (für `scale`, `origin`). */
function vec(value: unknown, fallback: number): { x: number; y: number } | undefined {
  if (value === undefined) return { x: fallback, y: fallback };
  if (typeof value === 'number') return { x: value, y: value };
  if (isRecord(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number') return { x: value['x'], y: value['y'] };
  return undefined;
}

/** Drehung einer Node (0, wenn nicht gesetzt); animiert → aktueller Wert von `current`. */
function staticRotation(node: Readonly<Rec>): number | undefined {
  const r = node['rotation'];
  if (r === undefined) return 0;
  return typeof r === 'number' ? r : undefined;
}

/**
 * Kann die Node mit den Griffen skaliert werden? Liefert den Grund, wenn nicht.
 *
 * @example
 * ```ts
 * resizeBlocker({ id: 'a', type: 'rect', rotation: 30 }); // 'rotated'
 * ```
 */
export function resizeBlocker(node: Readonly<Rec>): string | undefined {
  const rotation = staticRotation(node);
  if (rotation === undefined) return 'Its rotation is animated; resize it in the Inspector.';
  if (Math.abs(rotation % 360) > 0.001) return 'rotated';
  if (isAnimated(node['scale']) || vec(node['scale'], 1) === undefined) return 'Its scale is animated; resize it in the Inspector.';
  if (isAnimated(node['origin']) || vec(node['origin'], 0.5) === undefined) return 'Its origin is animated; resize it in the Inspector.';
  return undefined;
}

/**
 * Patches, die eine Node von der Welt-Box `from` auf `to` bringen (ohne Drehung).
 * Nodes mit `width`/`height` bekommen neue Maße, alle anderen (Text ohne Breite, Pfade, Gruppen)
 * eine neue `scale`. Animierte Zahlen bekommen einen Keyframe am lokalen Frame.
 *
 * @example
 * ```ts
 * resizePatches({ id: 'a', type: 'rect', x: 0, y: 0, width: 10, height: 10 }, box, bigger, 0);
 * ```
 */
export function resizePatches(node: Readonly<Rec>, from: Box, to: Box, localFrame: number, valueAt: (value: unknown) => unknown = (v) => v): PatchJson[] | string {
  const blocker = resizeBlocker(node);
  if (blocker !== undefined) return blocker === 'rotated' ? 'Rotated nodes are resized in the Inspector (width, height, scale).' : blocker;
  const id = String(node['id']);
  const scale = vec(node['scale'], 1) ?? { x: 1, y: 1 };
  const origin = vec(node['origin'], 0.5) ?? { x: 0.5, y: 0.5 };
  const num = (key: string): number | undefined => {
    const v = valueAt(node[key]);
    return typeof v === 'number' ? v : undefined;
  };
  const x = num('x') ?? 0;
  const y = num('y') ?? 0;
  const patches: PatchJson[] = [];
  const push = (key: string, value: number): string | undefined => {
    const next = setNumberAt(id, key, node[key], value, localFrame);
    if (next === undefined) return `${id}.${key} uses an expression or spring; edit it in the Code panel.`;
    patches.push(...next);
    return undefined;
  };
  const sized = typeof valueAt(node['width']) === 'number' && typeof valueAt(node['height']) === 'number' && scale.x !== 0 && scale.y !== 0;
  let problem: string | undefined;
  if (sized) {
    // Welt-Box = lokale Box um origin skaliert: X = x + ox·w·(1 − sx), W = w·sx.
    const w = to.width / scale.x;
    const h = to.height / scale.y;
    problem ??= push('width', w);
    problem ??= push('height', h);
    problem ??= push('x', to.x - origin.x * w * (1 - scale.x));
    problem ??= push('y', to.y - origin.y * h * (1 - scale.y));
  } else {
    if (from.width <= 0 || from.height <= 0) return `${id} has no size to scale.`;
    if (node['scale'] !== undefined && !isRecord(node['scale']) && typeof node['scale'] !== 'number') return `${id}.scale is animated; resize it in the Inspector.`;
    const sx = (scale.x * to.width) / from.width;
    const sy = (scale.y * to.height) / from.height;
    const lw = from.width / (scale.x === 0 ? 1 : scale.x);
    const lh = from.height / (scale.y === 0 ? 1 : scale.y);
    // Die lokale Box beginnt bei x + ox·lw·(1 − s) in der Welt; daraus die neue Position.
    const offsetX = from.x - (x + origin.x * lw * (1 - scale.x));
    const offsetY = from.y - (y + origin.y * lh * (1 - scale.y));
    patches.push({ op: 'setProperty', nodeId: id, property: 'scale', value: { x: Math.round(sx * 1000) / 1000, y: Math.round(sy * 1000) / 1000 } });
    problem ??= push('x', to.x - offsetX - origin.x * lw * (1 - sx));
    problem ??= push('y', to.y - offsetY - origin.y * lh * (1 - sy));
  }
  return problem ?? patches;
}
