/**
 * Ebenen-Reihenfolge (Story 20.6) mit `zIndex` (Story 17.3).
 *
 * Die effektive Zeichenreihenfolge unter Geschwistern ist die stabile Sortierung nach `zIndex`
 * (Standard 0; gleiche Werte behalten die Dokumentreihenfolge), wie `sortByZIndex` in `@agentic-video/core`.
 *
 * Entscheidung für die Befehle Front/Back/Forward/Backward: Sie ordnen zuerst über die Reihenfolge im
 * Dokument (`moveNode`). Nur wenn `zIndex` die gewünschte Wirkung verhindern würde, übernimmt die Node
 * den `zIndex` ihres Ziel-Nachbarn (0 wird entfernt). So bleibt die IR ohne `zIndex` frei davon, und
 * Projekte mit `zIndex` verhalten sich trotzdem so, wie es der Szenenbaum zeigt. Animiertes `zIndex`
 * wird nicht überschrieben (Meldung statt Patch).
 */
import { isAnimated } from '@agentic-video/core';
import { findNode } from './ir.js';
import { records, str, type PatchJson, type Rec } from './json.js';

/** Ein Geschwister mit seinem `zIndex`. */
export interface Sibling {
  readonly id: string;
  /** Position im Dokument (Array-Index). */
  readonly index: number;
  readonly z: number;
  readonly zAnimated: boolean;
}

/** Ebenen-Befehl. */
export type LayerCommand = 'front' | 'back' | 'forward' | 'backward';

/**
 * `zIndex` einer IR-Node: statische Zahl, bei Animation der Wert von `resolve` (z. B. am aktuellen Frame).
 *
 * @example
 * ```ts
 * zOf({ id: 'a', type: 'rect', zIndex: 3 }); // 3
 * ```
 */
export function zOf(node: Readonly<Rec>, resolve?: (value: unknown, node: Readonly<Rec>) => unknown): number {
  const v = node['zIndex'];
  const r = isAnimated(v) && resolve !== undefined ? resolve(v, node) : v;
  return typeof r === 'number' && Number.isFinite(r) ? r : 0;
}

/**
 * Stabile Sortierung nach `zIndex` (wie `sortByZIndex` in core): kleinere Werte zuerst gezeichnet.
 *
 * @example
 * ```ts
 * sortByZ([{ id: 'a', z: 1 }, { id: 'b', z: 0 }]).map((s) => s.id); // ['b', 'a']
 * ```
 */
export function sortByZ<T extends { readonly z: number }>(list: readonly T[]): T[] {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.z - b.item.z || a.index - b.index)
    .map((e) => e.item);
}

/**
 * Geschwister einer Node (Kinder desselben Elternteils) mit `zIndex`.
 *
 * @example
 * ```ts
 * siblingsOf(comp, 'title').map((s) => s.id); // ['bg', 'title', 'logo']
 * ```
 */
export function siblingsOf(comp: Readonly<Rec> | undefined, id: string, resolve?: (value: unknown, node: Readonly<Rec>) => unknown): Sibling[] {
  const loc = findNode(comp, id);
  if (loc === undefined) return [];
  const parent = loc.parentId === null ? undefined : findNode(comp, loc.parentId)?.node;
  const list = records(loc.parentId === null ? comp?.['nodes'] : parent?.['children']);
  return list.map((n, index) => ({ id: str(n['id'], ''), index, z: zOf(n, resolve), zAnimated: isAnimated(n['zIndex']) }));
}

/**
 * Patches für einen Ebenen-Befehl; ein Text erklärt, warum es nicht geht. Leere Liste: schon am Ziel.
 *
 * @example
 * ```ts
 * layerPatches(siblingsOf(comp, 'box'), null, 'box', 'front');
 * ```
 */
export function layerPatches(siblings: readonly Sibling[], parentId: string | null, id: string, command: LayerCommand): PatchJson[] | string {
  const order = sortByZ(siblings);
  const pos = order.findIndex((s) => s.id === id);
  const self = order[pos];
  if (self === undefined) return `Node "${id}" was not found.`;
  const last = order.length - 1;
  if ((command === 'front' || command === 'forward') && pos === last) return [];
  if ((command === 'back' || command === 'backward') && pos === 0) return [];
  const setZ = (z: number): PatchJson[] | string => {
    if (z === self.z) return [];
    if (self.zAnimated) return `The zIndex of "${id}" is animated; change its keyframes in the Keyframes panel.`;
    return [{ op: 'setProperty', nodeId: id, property: 'zIndex', value: z === 0 ? null : z }];
  };
  const move = (index: number): PatchJson[] => (index === self.index ? [] : [{ op: 'moveNode', nodeId: id, parentId, index }]);
  const combine = (z: PatchJson[] | string, index: number): PatchJson[] | string => (typeof z === 'string' ? z : [...z, ...move(index)]);
  switch (command) {
    case 'front': {
      const top = order[last];
      return combine(setZ(Math.max(self.z, top?.z ?? self.z)), siblings.length - 1);
    }
    case 'back': {
      const bottom = order[0];
      return combine(setZ(Math.min(self.z, bottom?.z ?? self.z)), 0);
    }
    case 'forward': {
      const next = order[pos + 1];
      if (next === undefined) return [];
      // Direkt hinter den Nachbarn (moveNode zählt den Index nach dem Entfernen).
      return combine(setZ(next.z), self.index < next.index ? next.index : next.index + 1);
    }
    case 'backward': {
      const prev = order[pos - 1];
      if (prev === undefined) return [];
      return combine(setZ(prev.z), self.index > prev.index ? prev.index : prev.index - 1);
    }
  }
}

/** Properties, die eine Gruppe beim Auflösen verlieren darf (reine Organisation). */
const UNGROUP_SAFE = new Set(['id', 'type', 'name', 'comment', 'children', 'visible', 'locked', 'meta', 'x', 'y', 'zIndex']);

/**
 * Patches, die eine Gruppe auflösen: Kinder rücken an ihre Stelle, eine statische Verschiebung
 * (`x`, `y`) der Gruppe wird auf die Kinder übertragen. Gruppen mit Transform, Zeitfenster,
 * Effekten oder Maske lassen sich nicht verlustfrei auflösen (Text statt Patches).
 *
 * @example
 * ```ts
 * ungroupPatches(comp, 'group'); // [moveNode…, removeNode group]
 * ```
 */
export function ungroupPatches(comp: Readonly<Rec> | undefined, groupId: string): { patches: PatchJson[]; children: string[] } | string {
  const loc = findNode(comp, groupId);
  if (loc === undefined) return `Node "${groupId}" was not found.`;
  const group = loc.node;
  const type = str(group['type'], '');
  if (type !== 'group' && type !== 'layer') return `"${groupId}" is a ${type}, not a group.`;
  const extra = Object.keys(group).filter((k) => !UNGROUP_SAFE.has(k) && group[k] !== undefined);
  if (extra.length > 0) return `Ungroup would lose ${extra.join(', ')} of "${groupId}". Remove them first or keep the group.`;
  const gx = group['x'] ?? 0;
  const gy = group['y'] ?? 0;
  if (typeof gx !== 'number' || typeof gy !== 'number') return `The position of "${groupId}" is animated; ungrouping would lose it.`;
  if (isAnimated(group['zIndex']) || (typeof group['zIndex'] === 'number' && group['zIndex'] !== 0)) return `"${groupId}" has a zIndex; ungrouping would change the draw order.`;
  const children = records(group['children']);
  const patches: PatchJson[] = [];
  const ids: string[] = [];
  children.forEach((child, i) => {
    const id = str(child['id'], '');
    ids.push(id);
    patches.push({ op: 'moveNode', nodeId: id, parentId: loc.parentId, index: loc.index + 1 + i });
  });
  for (const child of children) {
    const id = str(child['id'], '');
    for (const [axis, delta] of [['x', gx] as const, ['y', gy] as const]) {
      if (delta === 0) continue;
      const v = child[axis] ?? 0;
      if (typeof v !== 'number') return `The ${axis} of "${id}" is animated; ungrouping "${groupId}" would shift it. Set the group position to 0 first.`;
      patches.push({ op: 'setProperty', nodeId: id, property: axis, value: v + delta });
    }
  }
  patches.push({ op: 'removeNode', nodeId: groupId });
  return { patches, children: ids };
}

/**
 * Kinder einer Node in effektiver Zeichenreihenfolge (für den Szenenbaum).
 *
 * @example
 * ```ts
 * orderedChildren(comp['nodes']).map((n) => n['id']);
 * ```
 */
export function orderedChildren(list: unknown, resolve?: (value: unknown, node: Readonly<Rec>) => unknown): Rec[] {
  const items = records(list).map((node) => ({ node, z: zOf(node, resolve) }));
  return sortByZ(items).map((e) => e.node);
}
