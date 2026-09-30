/**
 * Erzeugt das veröffentlichte JSON Schema der IR (FR-3) aus der TypeBox-Definition.
 */
import { NODE_EXAMPLES } from './examples.js';
import { NODE_ARRAY_MARK, NODE_MARK, NODE_SCHEMAS } from './nodes.js';
import { ANIMATABLE_MARK } from './primitives.js';
import { Project } from './project.js';
import { SCHEMA_VERSION } from './version.js';

/** Öffentliche Adresse des Schemas. */
export const SCHEMA_ID = 'https://raw.githubusercontent.com/deltatree/agentic-video-engine/main/packages/schema/openvideo.schema.json';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function transform(value: unknown): Json {
  if (Array.isArray(value)) return value.map(transform);
  if (typeof value === 'object' && value !== null) {
    const record = Object.fromEntries(Object.entries(value));
    if (record[NODE_MARK] === true) return { $ref: '#/$defs/Node' };
    if (record[NODE_ARRAY_MARK] === true) return { type: 'array', items: { $ref: '#/$defs/Node' }, description: 'Child nodes.' };
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k === ANIMATABLE_MARK) continue;
      if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) continue;
      out[k] = transform(v);
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Lagert mehrfach vorkommende, große Teilbäume nach `$defs` aus. */
function dedupe(roots: Record<string, Json>, defs: Record<string, Json>): void {
  const counts = new Map<string, number>();
  const count = (value: Json): void => {
    if (Array.isArray(value)) {
      value.forEach(count);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const key = canonical(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const v of Object.values(value)) count(v);
  };
  for (const v of Object.values(roots)) count(v);
  const structural = new Set(['properties', 'anyOf', 'oneOf', 'items', 'patternProperties', 'additionalItems']);
  const childHint = (key: string, hint: string): string => (structural.has(key) ? hint : key === '$keyframes' || key === '$spring' || key === '$sampled' ? `${hint}${key.slice(1, 2).toUpperCase()}${key.slice(2)}` : key);
  const names = new Map<string, string>();
  const used = new Set(Object.keys(defs));
  const replace = (value: Json, hint: string): Json => {
    if (Array.isArray(value)) return value.map((v) => replace(v, hint));
    if (typeof value !== 'object' || value === null) return value;
    const key = canonical(value);
    if (key.length > 300 && (counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (name === undefined) {
        const base = hint.replace(/[^A-Za-z0-9_]/gu, '_') || 'Shared';
        name = base;
        for (let i = 2; used.has(name); i++) name = `${base}_${String(i)}`;
        used.add(name);
        names.set(key, name);
        const inner: Record<string, Json> = {};
        for (const [k, v] of Object.entries(value)) inner[k] = replace(v, childHint(k, hint));
        defs[name] = inner;
      }
      return { $ref: `#/$defs/${name}` };
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = replace(v, childHint(k, hint));
    return out;
  };
  for (const [k, v] of Object.entries(roots)) roots[k] = replace(v, k);
}

/**
 * Liefert das vollständige JSON Schema (Draft-07) des Projektformats.
 *
 * @example
 * ```ts
 * writeFileSync('openvideo.schema.json', JSON.stringify(buildJsonSchema(), null, 2));
 * ```
 */
export function buildJsonSchema(): Record<string, Json> {
  const root = transform(Project);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw new Error('Project schema must be an object');
  const nodeDefs: Record<string, Json> = {};
  for (const [type, schema] of Object.entries(NODE_SCHEMAS)) nodeDefs[`Node_${type.replace(/-/gu, '_')}`] = transform(schema);
  const roots: Record<string, Json> = { ...nodeDefs, __root: root };
  const shared: Record<string, Json> = {};
  dedupe(roots, shared);
  const { __root: dedupedRoot, ...dedupedNodes } = roots;
  // Beispiel je Node-Typ (Story 19.7) erst nach dem Ausgliedern, damit es nicht in `$defs` wandert.
  for (const [type, example] of Object.entries(NODE_EXAMPLES)) {
    const key = `Node_${type.replace(/-/gu, '_')}`;
    const def = dedupedNodes[key];
    if (typeof def === 'object' && def !== null && !Array.isArray(def)) dedupedNodes[key] = { ...def, examples: [transform(example)] };
  }
  const defs: Record<string, Json> = {
    ...shared,
    ...dedupedNodes,
    Node: { oneOf: Object.keys(NODE_SCHEMAS).map((type) => ({ $ref: `#/$defs/Node_${type.replace(/-/gu, '_')}` })) },
  };
  const rootObject = typeof dedupedRoot === 'object' && dedupedRoot !== null && !Array.isArray(dedupedRoot) ? dedupedRoot : {};
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: SCHEMA_ID,
    title: `OpenVideo Project ${SCHEMA_VERSION}`,
    ...rootObject,
    $defs: defs,
  };
}
