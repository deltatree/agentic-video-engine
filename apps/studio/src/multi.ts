/**
 * Mehrfachbearbeitung im Inspector (Story 20.8): gemeinsame Felder mehrerer Nodes,
 * „gemischte“ Werte und ein Patch-Satz für alle.
 */
import type { FieldSpec } from './fields.js';
import { hasKeyframes } from './ir.js';
import type { PatchJson, Rec } from './json.js';

/** Marker für unterschiedliche Werte. */
export const MIXED = Symbol('mixed');

/**
 * Felder, die alle Typen gemeinsam haben (Reihenfolge des ersten Typs).
 *
 * @example
 * ```ts
 * commonFields([fieldsFor('rect'), fieldsFor('text')]).map((f) => f.name); // ['name', …, 'x', 'y', …]
 * ```
 */
export function commonFields(lists: readonly (readonly FieldSpec[])[]): FieldSpec[] {
  const [first, ...rest] = lists;
  if (first === undefined) return [];
  return first.filter((f) => rest.every((l) => l.some((g) => g.name === f.name && g.field.kind === f.field.kind)));
}

/**
 * Gemeinsamer Wert oder {@link MIXED}.
 *
 * @example
 * ```ts
 * sharedValue([1, 1]); // 1
 * sharedValue([1, 2]); // MIXED
 * ```
 */
export function sharedValue(values: readonly unknown[]): unknown {
  const [first, ...rest] = values;
  const key = JSON.stringify(first);
  return rest.every((v) => JSON.stringify(v) === key) ? first : MIXED;
}

/**
 * Patches, die eine Property auf allen Nodes setzen; Keyframe-Animationen bekommen einen Keyframe
 * am jeweiligen lokalen Frame. Nodes mit anderer Animation (Expression, Feder) werden übersprungen.
 *
 * @example
 * ```ts
 * multiSetPatches([{ id: 'a', node: {...}, local: 0 }], 'opacity', 0.5);
 * ```
 */
export function multiSetPatches(targets: readonly { readonly id: string; readonly node: Readonly<Rec>; readonly local: number }[], property: string, value: unknown): { patches: PatchJson[]; skipped: string[] } {
  const patches: PatchJson[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const raw = t.node[property];
    if (hasKeyframes(raw)) {
      if (value !== null) patches.push({ op: 'addKeyframe', nodeId: t.id, property, keyframe: { t: t.local, v: value } });
    } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).some((k) => k.startsWith('$'))) skipped.push(t.id);
    else patches.push({ op: 'setProperty', nodeId: t.id, property, value });
  }
  return { patches, skipped };
}
