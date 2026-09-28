/**
 * Semantische Patches (FR-19, FR-20): kleine, atomare Änderungen an der IR.
 *
 * Jeder Patch ändert nur die genannten Stellen. Alle anderen Bytes der
 * serialisierten IR bleiben gleich. Jede Operation liefert ihre Umkehrung (Undo).
 */
import { OpenVideoError, validateProject, type Diagnostic, type TimeValue, type ValidateOptions } from '@agentic-video/schema';
import { resolveMarkers, toFrames } from '@agentic-video/timeline';
import { isRecord } from './guards.js';

/** Ein Keyframe für `addKeyframe`. */
export interface PatchKeyframe {
  readonly t: TimeValue;
  readonly v: unknown;
  readonly ease?: string;
}

/**
 * Alle Patch-Operationen. `compositionId` ist optional, wenn die Node-ID eindeutig ist.
 *
 * Bei `setProperty`, `setCompositionProperty` und `setProjectProperty` löscht `value: null`
 * die Property. Mit `keepNull: true` wird stattdessen der JSON-Wert `null` gesetzt.
 *
 * @example
 * ```ts
 * const p: Patch = { op: 'setProperty', nodeId: 'title', property: 'fontSize', value: 82 };
 * ```
 */
export type Patch =
  | { readonly op: 'setProperty'; readonly nodeId: string; readonly property: string; readonly value: unknown; readonly keepNull?: boolean; readonly compositionId?: string }
  | { readonly op: 'addNode'; readonly parentId: string | null; readonly node: Readonly<Record<string, unknown>>; readonly index?: number; readonly compositionId?: string }
  | { readonly op: 'removeNode'; readonly nodeId: string; readonly compositionId?: string }
  | { readonly op: 'moveNode'; readonly nodeId: string; readonly parentId: string | null; readonly index?: number; readonly compositionId?: string }
  | { readonly op: 'addKeyframe'; readonly nodeId: string; readonly property: string; readonly keyframe: PatchKeyframe; readonly compositionId?: string }
  | { readonly op: 'removeKeyframe'; readonly nodeId: string; readonly property: string; readonly t: TimeValue; readonly compositionId?: string }
  | { readonly op: 'replaceAsset'; readonly assetId: string; readonly src: string; readonly type?: string; readonly hash?: string }
  | { readonly op: 'addAsset'; readonly asset: Readonly<Record<string, unknown>> }
  | { readonly op: 'removeAsset'; readonly assetId: string }
  | { readonly op: 'setCompositionProperty'; readonly compositionId: string; readonly property: string; readonly value: unknown; readonly keepNull?: boolean }
  | { readonly op: 'setProjectProperty'; readonly property: string; readonly value: unknown; readonly keepNull?: boolean };

/** Namen aller Patch-Operationen. */
export const PATCH_OPS = ['setProperty', 'addNode', 'removeNode', 'moveNode', 'addKeyframe', 'removeKeyframe', 'replaceAsset', 'addAsset', 'removeAsset', 'setCompositionProperty', 'setProjectProperty'] as const;

/** Ergebnis von {@link applyPatches}. */
export interface PatchResult {
  readonly ok: boolean;
  /** Neues Project (bei Fehler das unveränderte Original). */
  readonly project: Record<string, unknown>;
  /** Patches, die die Änderung rückgängig machen. */
  readonly inverse: readonly Patch[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Optionen für {@link applyPatches}. */
export interface PatchOptions {
  /** Validierung nach dem Patchen (Standard: an). */
  readonly validate?: boolean;
  readonly validateOptions?: ValidateOptions;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Tiefe Kopie JSON-artiger Daten mit erhaltener Schlüsselreihenfolge. */
export function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

/** Tiefe Kopie eines Objekts. */
export function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy = cloneJson(value);
  if (!isRecord(copy)) throw new TypeError('Expected an object');
  return copy;
}

function isTimeValue(value: unknown): value is TimeValue {
  return typeof value === 'number' || typeof value === 'string';
}

function patchError(problem: string, suggestions: readonly string[], extra: Partial<Diagnostic> = {}): OpenVideoError {
  return new OpenVideoError({ code: 'OV_PATCH_INVALID', errorClass: 'PatchError', problem, suggestions, ...extra });
}

interface Located {
  readonly container: unknown[];
  readonly index: number;
  readonly node: Record<string, unknown>;
  readonly parentId: string | null;
  readonly composition: Record<string, unknown>;
}

function compositions(project: Record<string, unknown>): Record<string, unknown>[] {
  const comps = project['compositions'];
  return Array.isArray(comps) ? comps.filter(isRecord) : [];
}

function findIn(list: unknown[], id: string, parentId: string | null, composition: Record<string, unknown>): Located | undefined {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!isRecord(n)) continue;
    if (n['id'] === id) return { container: list, index: i, node: n, parentId, composition };
    const children = n['children'];
    if (Array.isArray(children)) {
      const hit = findIn(children, id, typeof n['id'] === 'string' ? n['id'] : null, composition);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function locate(project: Record<string, unknown>, nodeId: string, compositionId: string | undefined): Located {
  const comps = compositions(project).filter((c) => compositionId === undefined || c['id'] === compositionId);
  if (compositionId !== undefined && comps.length === 0) throw patchError(`Composition "${compositionId}" does not exist.`, ['Use composition.get to list compositions.']);
  const hits: Located[] = [];
  for (const comp of comps) {
    const nodes = comp['nodes'];
    if (!Array.isArray(nodes)) continue;
    const hit = findIn(nodes, nodeId, null, comp);
    if (hit !== undefined) hits.push(hit);
  }
  const [first, second] = hits;
  if (first === undefined) throw patchError(`Node "${nodeId}" does not exist.`, ['Use scene.tree to list node ids.'], { nodeId });
  if (second !== undefined) throw patchError(`Node id "${nodeId}" exists in several compositions.`, ['Add compositionId to the patch.'], { nodeId });
  return first;
}

function splitPath(path: string): string[] {
  const parts = path.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) throw patchError('Property path is empty.', ['Use a property name like "fontSize" or "scale.x".']);
  const forbidden = ['id', 'type', 'children', '__proto__', 'constructor', 'prototype'];
  const first = parts[0] ?? '';
  if (forbidden.includes(first) || parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) {
    throw patchError(`Property "${path}" cannot be set with setProperty.`, first === 'children' ? ['Use addNode, removeNode or moveNode.'] : ['Use a regular property name.']);
  }
  return parts;
}

/** Was die Umkehrung eines Setzens wiederherstellen muss. */
interface Restore {
  readonly path: string;
  readonly value: unknown;
  /** `true`, wenn der alte Wert `null` war (nicht fehlend). */
  readonly keepNull: boolean;
}

/**
 * Ermittelt, was die Umkehrung eines Setzens wiederherstellen muss: den ersten
 * vorher fehlenden Vorfahren (dann `null` = entfernen) oder den alten Wert.
 * Ein alter Wert `null` wird mit `keepNull` wiederhergestellt, nicht gelöscht.
 */
function inversePath(target: Record<string, unknown>, parts: readonly string[]): Restore {
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i);
    const v = getPath(target, prefix);
    if (v === undefined) return { path: prefix.join('.'), value: null, keepNull: false };
    if (i === parts.length) return { path: parts.join('.'), value: cloneJson(v), keepNull: v === null };
  }
  return { path: parts.join('.'), value: null, keepNull: false };
}

/** Felder `value` und `keepNull` einer Umkehrung. */
function restoreFields(r: Restore): { value: unknown; keepNull?: boolean } {
  return r.keepNull ? { value: null, keepNull: true } : { value: r.value };
}

function getPath(target: Record<string, unknown>, parts: readonly string[]): unknown {
  let cur: unknown = target;
  for (const p of parts) {
    if (!isRecord(cur) || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Standardwerte zusammengesetzter Properties, wenn nur eine Komponente gesetzt wird (z. B. `scale.x`). */
export const COMPOUND_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  scale: { x: 1, y: 1 },
  origin: { x: 0.5, y: 0.5 },
  skew: { x: 0, y: 0 },
  from: { x: 0, y: 0 },
  to: { x: 0, y: 0 },
};

function setPath(target: Record<string, unknown>, parts: readonly string[], value: unknown, keepNull = false): void {
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] ?? '';
    const next = cur[key];
    if (!isRecord(next)) {
      if (next !== undefined) throw patchError(`Cannot set "${parts.join('.')}": "${parts.slice(0, i + 1).join('.')}" is not an object.`, ['Set the whole property instead.']);
      const defaults = i === 0 ? COMPOUND_DEFAULTS[key] : undefined;
      const created: Record<string, unknown> = defaults !== undefined ? { ...defaults } : {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next;
    }
  }
  const last = parts[parts.length - 1] ?? '';
  if (value === undefined || (value === null && !keepNull)) {
    Reflect.deleteProperty(cur, last);
  } else {
    cur[last] = value;
  }
}

/** Alle IDs einer Node und ihrer Nachfahren (Kinder und Masken-Nodes), mit Wiederholungen. */
function subtreeIds(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const out: string[] = typeof node['id'] === 'string' ? [node['id']] : [];
  const children = node['children'];
  if (Array.isArray(children)) for (const c of children) out.push(...subtreeIds(c));
  const mask = node['mask'];
  if (isRecord(mask)) out.push(...subtreeIds(mask['node']));
  return out;
}

function collectIds(list: readonly unknown[], into: Set<string>): void {
  for (const n of list) for (const id of subtreeIds(n)) into.add(id);
}

function nodesArray(comp: Record<string, unknown>): unknown[] {
  const nodes = comp['nodes'];
  if (!Array.isArray(nodes)) throw patchError(`Composition "${String(comp['id'])}" has no nodes array.`, []);
  return nodes;
}

function containerFor(project: Record<string, unknown>, parentId: string | null, compositionId: string | undefined): { list: unknown[]; composition: Record<string, unknown> } {
  if (parentId === null) {
    const comps = compositions(project);
    const comp = compositionId === undefined ? comps[0] : comps.find((c) => c['id'] === compositionId);
    if (comp === undefined) throw patchError(compositionId === undefined ? 'The project has no composition.' : `Composition "${compositionId}" does not exist.`, []);
    return { list: nodesArray(comp), composition: comp };
  }
  const parent = locate(project, parentId, compositionId);
  const existing = parent.node['children'];
  if (Array.isArray(existing)) return { list: existing, composition: parent.composition };
  const created: unknown[] = [];
  parent.node['children'] = created;
  return { list: created, composition: parent.composition };
}

function frameOf(t: TimeValue, comp: Record<string, unknown>): number {
  const fps = Number(comp['fps']);
  const markersRaw = comp['markers'];
  const markers = resolveMarkers(
    Array.isArray(markersRaw)
      ? markersRaw.filter(isRecord).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) }))
      : [],
    fps,
  );
  return toFrames(t, { fps, markers });
}

function assets(project: Record<string, unknown>): unknown[] {
  const existing = project['assets'];
  if (Array.isArray(existing)) return existing;
  const created: unknown[] = [];
  project['assets'] = created;
  return created;
}

/** Wendet einen Patch auf `project` (wird verändert) an und liefert seine Umkehrung. */
function applyOne(project: Record<string, unknown>, patch: Patch): Patch[] {
  switch (patch.op) {
    case 'setProperty': {
      const loc = locate(project, patch.nodeId, patch.compositionId);
      const parts = splitPath(patch.property);
      const restore = inversePath(loc.node, parts);
      setPath(loc.node, parts, cloneJson(patch.value), patch.keepNull === true);
      const compositionId = String(loc.composition['id']);
      return [{ op: 'setProperty', nodeId: patch.nodeId, property: restore.path, ...restoreFields(restore), compositionId }];
    }
    case 'addNode': {
      const id = patch.node['id'];
      if (typeof id !== 'string') throw patchError('The new node needs a string "id".', ['node: { id: "title", type: "text", text: "Hello" }']);
      const { list, composition } = containerFor(project, patch.parentId, patch.compositionId);
      const existing = new Set<string>();
      collectIds(nodesArray(composition), existing);
      const added = new Set<string>();
      for (const newId of subtreeIds(patch.node)) {
        if (existing.has(newId)) throw patchError(`Node id "${newId}" already exists.`, [`Use a unique id such as "${newId}-2".`], { nodeId: newId });
        if (added.has(newId)) throw patchError(`Node id "${newId}" appears twice in the new subtree.`, ['Give every node in the new subtree its own id.'], { nodeId: newId });
        added.add(newId);
      }
      const index = patch.index === undefined ? list.length : Math.min(Math.max(0, patch.index), list.length);
      list.splice(index, 0, cloneRecord(patch.node));
      return [{ op: 'removeNode', nodeId: id, compositionId: String(composition['id']) }];
    }
    case 'removeNode': {
      const loc = locate(project, patch.nodeId, patch.compositionId);
      loc.container.splice(loc.index, 1);
      return [{ op: 'addNode', parentId: loc.parentId, node: loc.node, index: loc.index, compositionId: String(loc.composition['id']) }];
    }
    case 'moveNode': {
      const loc = locate(project, patch.nodeId, patch.compositionId);
      if (patch.parentId !== null) {
        const inside = findIn([loc.node], patch.parentId, null, loc.composition);
        if (inside !== undefined) throw patchError(`Cannot move "${patch.nodeId}" into its own descendant "${patch.parentId}".`, ['Choose a parent outside the moved subtree.']);
      }
      loc.container.splice(loc.index, 1);
      const { list } = containerFor(project, patch.parentId, String(loc.composition['id']));
      const index = patch.index === undefined ? list.length : Math.min(Math.max(0, patch.index), list.length);
      list.splice(index, 0, loc.node);
      return [{ op: 'moveNode', nodeId: patch.nodeId, parentId: loc.parentId, index: loc.index, compositionId: String(loc.composition['id']) }];
    }
    case 'addKeyframe': {
      const loc = locate(project, patch.nodeId, patch.compositionId);
      const parts = splitPath(patch.property);
      const before = getPath(loc.node, parts);
      const restore = inversePath(loc.node, parts);
      const frame = frameOf(patch.keyframe.t, loc.composition);
      const key = { t: patch.keyframe.t, v: cloneJson(patch.keyframe.v), ...(patch.keyframe.ease !== undefined ? { ease: patch.keyframe.ease } : {}) };
      let next: Record<string, unknown>;
      if (before === undefined) {
        next = { $keyframes: [key] };
      } else if (isRecord(before) && Array.isArray(before['$keyframes'])) {
        const existing = before['$keyframes'].filter(isRecord).filter((k) => {
          const t = k['t'];
          return !(isTimeValue(t) && frameOf(t, loc.composition) === frame);
        });
        existing.push(key);
        const at = (k: Record<string, unknown>): number => {
          const t = k['t'];
          return isTimeValue(t) ? frameOf(t, loc.composition) : 0;
        };
        existing.sort((a, b) => at(a) - at(b));
        next = { ...before, $keyframes: existing };
      } else if (isRecord(before) && Object.keys(before).some((k) => k.startsWith('$'))) {
        throw patchError(`Property "${patch.property}" is animated with ${Object.keys(before).join(', ')}, not with keyframes.`, ['Replace it with setProperty first.'], { nodeId: patch.nodeId });
      } else {
        next = { $keyframes: frame === 0 ? [key] : [{ t: 0, v: cloneJson(before) }, key] };
      }
      setPath(loc.node, parts, next);
      return [{ op: 'setProperty', nodeId: patch.nodeId, property: restore.path, ...restoreFields(restore), compositionId: String(loc.composition['id']) }];
    }
    case 'removeKeyframe': {
      const loc = locate(project, patch.nodeId, patch.compositionId);
      const parts = splitPath(patch.property);
      const before = getPath(loc.node, parts);
      if (!isRecord(before) || !Array.isArray(before['$keyframes'])) throw patchError(`Property "${patch.property}" has no keyframes.`, ['Use timeline.inspect to see animated properties.'], { nodeId: patch.nodeId });
      const frame = frameOf(patch.t, loc.composition);
      const keys = before['$keyframes'].filter(isRecord);
      const remaining = keys.filter((k) => {
        const t = k['t'];
        return !(isTimeValue(t) && frameOf(t, loc.composition) === frame);
      });
      if (remaining.length === keys.length) throw patchError(`No keyframe at ${JSON.stringify(patch.t)} on "${patch.property}".`, ['Use timeline.inspect to list keyframe times.'], { nodeId: patch.nodeId });
      const only = remaining[0];
      const next = remaining.length === 0 ? null : remaining.length === 1 && only !== undefined && Object.keys(before).length === 1 ? only['v'] : { ...before, $keyframes: remaining };
      setPath(loc.node, parts, next);
      return [{ op: 'setProperty', nodeId: patch.nodeId, property: patch.property, value: cloneJson(before), compositionId: String(loc.composition['id']) }];
    }
    case 'replaceAsset': {
      const list = assets(project);
      const asset = list.filter(isRecord).find((a) => a['id'] === patch.assetId);
      if (asset === undefined) throw patchError(`Asset "${patch.assetId}" does not exist.`, ['Use asset.import to add it.']);
      const before = cloneRecord(asset);
      asset['src'] = patch.src;
      if (patch.type !== undefined) asset['type'] = patch.type;
      if (patch.hash !== undefined) asset['hash'] = patch.hash;
      else delete asset['hash'];
      return [
        {
          op: 'replaceAsset',
          assetId: patch.assetId,
          src: String(before['src']),
          ...(typeof before['type'] === 'string' ? { type: before['type'] } : {}),
          ...(typeof before['hash'] === 'string' ? { hash: before['hash'] } : {}),
        },
      ];
    }
    case 'addAsset': {
      const id = patch.asset['id'];
      if (typeof id !== 'string') throw patchError('The asset needs a string "id".', ['asset: { id: "logo", type: "svg", src: "./assets/logo.svg" }']);
      const list = assets(project);
      if (list.filter(isRecord).some((a) => a['id'] === id)) throw patchError(`Asset "${id}" already exists.`, ['Use replaceAsset to change it.']);
      list.push(cloneRecord(patch.asset));
      return [{ op: 'removeAsset', assetId: id }];
    }
    case 'removeAsset': {
      const list = assets(project);
      const index = list.findIndex((a) => isRecord(a) && a['id'] === patch.assetId);
      const asset = list[index];
      if (index < 0 || !isRecord(asset)) throw patchError(`Asset "${patch.assetId}" does not exist.`, []);
      list.splice(index, 1);
      return [{ op: 'addAsset', asset }];
    }
    case 'setCompositionProperty': {
      const comp = compositions(project).find((c) => c['id'] === patch.compositionId);
      if (comp === undefined) throw patchError(`Composition "${patch.compositionId}" does not exist.`, []);
      const parts = splitPath(patch.property);
      if (parts[0] === 'nodes') throw patchError('Use addNode, removeNode or moveNode to change nodes.', []);
      const restore = inversePath(comp, parts);
      setPath(comp, parts, cloneJson(patch.value), patch.keepNull === true);
      return [{ op: 'setCompositionProperty', compositionId: patch.compositionId, property: restore.path, ...restoreFields(restore) }];
    }
    case 'setProjectProperty': {
      const parts = splitPath(patch.property);
      if (parts[0] === 'compositions' || parts[0] === 'assets') throw patchError(`Use the dedicated operations to change "${parts[0]}".`, []);
      const restore = inversePath(project, parts);
      setPath(project, parts, cloneJson(patch.value), patch.keepNull === true);
      return [{ op: 'setProjectProperty', property: restore.path, ...restoreFields(restore) }];
    }
  }
}

function errorKeys(diagnostics: readonly Diagnostic[]): Set<string> {
  return new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}|${d.path ?? ''}|${d.problem}`));
}

/**
 * Wendet eine Patch-Liste atomar an (alles oder nichts).
 * Neue Validierungsfehler führen zur Ablehnung; bestehende Fehler blockieren nicht,
 * damit ein Agent ein fehlerhaftes Project schrittweise reparieren kann.
 *
 * @example
 * ```ts
 * const r = applyPatches(project, [
 *   { op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 },
 *   { op: 'setProperty', nodeId: 'headline', property: 'y', value: 720 },
 * ]);
 * if (r.ok) project = r.project; // r.inverse macht die Änderung rückgängig
 * ```
 */
export function applyPatches(project: Readonly<Record<string, unknown>>, patches: readonly Patch[], options: PatchOptions = {}): PatchResult {
  const working = cloneRecord(project);
  const inverse: Patch[] = [];
  const original = cloneRecord(project);
  try {
    patches.forEach((patch, i) => {
      try {
        inverse.unshift(...applyOne(working, patch).reverse());
      } catch (error) {
        if (error instanceof OpenVideoError) {
          throw new OpenVideoError({ ...error.diagnostic, problem: `Patch ${String(i + 1)} (${patch.op}): ${error.diagnostic.problem}` });
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof OpenVideoError) return { ok: false, project: original, inverse: [], diagnostics: [error.diagnostic] };
    throw error;
  }
  if (options.validate !== false) {
    const before = errorKeys(validateProject(project, options.validateOptions).diagnostics);
    const after = validateProject(working, options.validateOptions).diagnostics;
    const introduced = after.filter((d) => d.severity === 'error' && !before.has(`${d.code}|${d.path ?? ''}|${d.problem}`));
    if (introduced.length > 0) return { ok: false, project: original, inverse: [], diagnostics: introduced };
    return { ok: true, project: working, inverse, diagnostics: after };
  }
  return { ok: true, project: working, inverse, diagnostics: [] };
}

/** Typ-Hilfe für JSON-Daten in Patches. */
export type PatchJson = Json;
