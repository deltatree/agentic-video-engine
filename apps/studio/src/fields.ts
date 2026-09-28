/**
 * Eingabefelder aus dem JSON Schema der Node-Typen (`NODE_SCHEMAS` aus `@agentic-video/core`).
 * Der Inspector baut seine Felder daraus; es gibt keine zweite, handgepflegte Liste.
 */
import { ANIMATABLE_MARK, NODE_SCHEMAS, isRecord } from '@agentic-video/core';

/** Art eines Eingabefelds. */
export type FieldKind =
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly integer: boolean }
  | { readonly kind: 'color' }
  | { readonly kind: 'text' }
  | { readonly kind: 'enum'; readonly options: readonly string[] }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'vec2' }
  | { readonly kind: 'json' };

/** Ein Feld im Inspector. */
export interface FieldSpec {
  readonly name: string;
  readonly description: string;
  readonly animatable: boolean;
  readonly field: FieldKind;
}

const COLOR_HINT = '#([0-9a-fA-F]{3}';

/** Properties, die eigene Panels haben oder nicht direkt bearbeitet werden. */
export const HIDDEN_FIELDS: ReadonlySet<string> = new Set(['id', 'type', 'children', 'timing', 'filters', 'shadow', 'effects', 'mask', 'meta']);

function literalKind(schema: Readonly<Record<string, unknown>>): FieldKind {
  const type = schema['type'];
  if (Array.isArray(schema['enum'])) return { kind: 'enum', options: schema['enum'].map(String) };
  if (type === 'number' || type === 'integer') {
    return {
      kind: 'number',
      integer: type === 'integer',
      ...(typeof schema['minimum'] === 'number' ? { min: schema['minimum'] } : {}),
      ...(typeof schema['maximum'] === 'number' ? { max: schema['maximum'] } : {}),
    };
  }
  if (type === 'string') return typeof schema['pattern'] === 'string' && schema['pattern'].includes(COLOR_HINT) ? { kind: 'color' } : { kind: 'text' };
  if (type === 'boolean') return { kind: 'boolean' };
  if (type === 'object' && isRecord(schema['properties'])) {
    const keys = Object.keys(schema['properties']);
    if (keys.length === 2 && keys.includes('x') && keys.includes('y')) return { kind: 'vec2' };
  }
  return { kind: 'json' };
}

/**
 * Bestimmt Feldart und Animierbarkeit eines Property-Schemas.
 *
 * @example
 * ```ts
 * describeSchema(NODE_SCHEMAS.rect.properties.x); // { animatable: true, field: { kind: 'number', integer: false } }
 * ```
 */
export function describeSchema(schema: unknown): { animatable: boolean; field: FieldKind } {
  if (!isRecord(schema)) return { animatable: false, field: { kind: 'json' } };
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const first: unknown = anyOf[0];
    if (schema[ANIMATABLE_MARK] === true && isRecord(first)) return { animatable: true, field: literalKind(first) };
    const consts = anyOf.filter(isRecord).map((b) => b['const']);
    if (consts.length === anyOf.length && consts.every((c) => typeof c === 'string')) return { animatable: false, field: { kind: 'enum', options: consts.map(String) } };
    // Farbe oder Verlauf (Paint): der erste Zweig entscheidet über das Feld.
    const inner = describeSchema(first);
    return inner.field.kind === 'color' ? inner : { animatable: false, field: { kind: 'json' } };
  }
  return { animatable: false, field: literalKind(schema) };
}

/**
 * Alle bearbeitbaren Felder eines Node-Typs in Schema-Reihenfolge.
 *
 * @example
 * ```ts
 * fieldsFor('text').map((f) => f.name); // ['name', 'comment', 'visible', 'locked', …, 'text', …]
 * ```
 */
export function fieldsFor(type: string): FieldSpec[] {
  const entry = Object.entries(NODE_SCHEMAS).find(([t]) => t === type)?.[1];
  if (entry === undefined) return [];
  const props: unknown = entry.properties;
  if (!isRecord(props)) return [];
  return Object.entries(props)
    .filter(([name]) => !HIDDEN_FIELDS.has(name))
    .map(([name, schema]) => ({ name, description: isRecord(schema) && typeof schema['description'] === 'string' ? schema['description'] : '', ...describeSchema(schema) }));
}

/**
 * Felder eines Objekt-Schemas (z. B. ein Filter oder der Schatten) ohne `type`.
 *
 * @example
 * ```ts
 * objectFields(shadowSchema).map((f) => f.name); // ['color', 'blur', 'offsetX', 'offsetY']
 * ```
 */
export function objectFields(schema: unknown): FieldSpec[] {
  if (!isRecord(schema) || !isRecord(schema['properties'])) return [];
  return Object.entries(schema['properties'])
    .filter(([name]) => name !== 'type')
    .map(([name, s]) => ({ name, description: '', ...describeSchema(s) }));
}

/**
 * Zweige einer Union aus Objekten mit `type`-Literal (Filter, Layer-Effekte) nach Typname.
 *
 * @example
 * ```ts
 * unionBranches(filterSchema).get('blur'); // Schema des Blur-Filters
 * ```
 */
export function unionBranches(schema: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const list = isRecord(schema) ? schema['anyOf'] : undefined;
  if (!Array.isArray(list)) return out;
  for (const branch of list) {
    if (!isRecord(branch) || !isRecord(branch['properties'])) continue;
    const t = branch['properties']['type'];
    if (isRecord(t) && typeof t['const'] === 'string') out.set(t['const'], branch);
  }
  return out;
}

/**
 * Schema einer Property eines Node-Typs (für Filter, Effekte, Schatten).
 *
 * @example
 * ```ts
 * propertySchema('rect', 'shadow');
 * ```
 */
export function propertySchema(type: string, property: string): unknown {
  const entry = Object.entries(NODE_SCHEMAS).find(([t]) => t === type)?.[1];
  const props: unknown = entry?.properties;
  if (!isRecord(props)) return undefined;
  const s = props[property];
  // Arrays (filters, effects): das Schema der Einträge.
  if (isRecord(s) && s['type'] === 'array') return s['items'];
  return s;
}
