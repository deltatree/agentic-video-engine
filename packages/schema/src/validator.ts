/**
 * Kleiner JSON-Schema-Interpreter für die Teilmenge, die TypeBox für die IR erzeugt.
 *
 * Warum ein eigener Interpreter: Standard-Validatoren melden bei Unions jeden
 * verworfenen Zweig. Agents brauchen aber genau eine präzise Meldung mit
 * Korrekturvorschlag (FR-4). Dieser Interpreter wählt den passenden Zweig
 * (Diskriminator `type`, Animations-Schlüssel `$…`, Werttyp) und meldet nur dessen Fehler.
 */
import { ANIMATABLE_MARK } from './primitives.js';
import { NODE_ARRAY_MARK, NODE_MARK } from './nodes.js';

/** Minimale Sicht auf ein JSON-Schema-Objekt. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Pfadsegment: Objektschlüssel oder Array-Index. */
export type Segment = string | number;

/** Ein einzelner Schema-Verstoß. */
export interface SchemaIssue {
  readonly segments: readonly Segment[];
  readonly keyword: string;
  readonly message: string;
  readonly expected: string;
  readonly received: unknown;
  /** Schema-Knoten, an dem der Verstoß auftrat. */
  readonly schema: JsonSchema;
  /** Schemas der Vorfahren mit ihrer Pfadtiefe, vom Wurzelschema bis zum Elternknoten. */
  readonly ancestors: readonly AncestorFrame[];
  readonly suggestion?: string;
}

/** Ein Vorfahren-Schema und die Anzahl Pfadsegmente an seiner Stelle. */
export interface AncestorFrame {
  readonly schema: JsonSchema;
  readonly depth: number;
}

/** Rückruf für eingebettete Nodes (rekursive Validierung übernimmt der Aufrufer). */
export type NodeVisitor = (value: unknown, segments: readonly Segment[]) => void;

interface Ctx {
  readonly issues: SchemaIssue[];
  readonly onNode: NodeVisitor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaArray(value: unknown): readonly JsonSchema[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Beschreibt den JSON-Typ eines Werts für Meldungen. */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Erzeugt eine kurze Beschreibung, was ein Schema erwartet (z. B. `number >= 0`). */
export function describeSchema(schema: JsonSchema): string {
  if ('const' in schema) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum'])) return `one of ${schema['enum'].map((v) => JSON.stringify(v)).join(', ')}`;
  const anyOf = schemaArray(schema['anyOf']);
  if (anyOf.length > 0) {
    if (anyOf.every((s) => 'const' in s)) return `one of ${anyOf.map((s) => JSON.stringify(s['const'])).join(', ')}`;
    if (schema[ANIMATABLE_MARK] === true && anyOf[0] !== undefined) return `${describeSchema(anyOf[0])} or an animation ($keyframes, $spring, $expr, $sampled, $ref)`;
    const description = str(schema['description']);
    if (description !== undefined) return description;
    return anyOf.map(describeSchema).join(' or ');
  }
  const type = str(schema['type']);
  const description = str(schema['description']);
  if (type === 'number' || type === 'integer') {
    const parts: string[] = [];
    const min = num(schema['minimum']);
    const max = num(schema['maximum']);
    const exMin = num(schema['exclusiveMinimum']);
    const exMax = num(schema['exclusiveMaximum']);
    if (min !== undefined) parts.push(`>= ${String(min)}`);
    if (exMin !== undefined) parts.push(`> ${String(exMin)}`);
    if (max !== undefined) parts.push(`<= ${String(max)}`);
    if (exMax !== undefined) parts.push(`< ${String(exMax)}`);
    return [type, ...parts].join(' ');
  }
  if (type === 'string') {
    if (schema['pattern'] !== undefined) return description !== undefined ? `string (${description})` : `string matching ${str(schema['pattern']) ?? ''}`;
    return 'string';
  }
  if (type === 'array') {
    const items = schema['items'];
    if (Array.isArray(items)) return `array of ${String(items.length)} items`;
    if (isRecord(items)) return `array of ${describeSchema(items)}`;
    return 'array';
  }
  if (type === 'object') return description !== undefined ? `object (${description})` : 'object';
  if (type !== undefined) return type;
  return description ?? 'value';
}

function push(ctx: Ctx, ancestors: readonly AncestorFrame[], segments: readonly Segment[], schema: JsonSchema, keyword: string, message: string, received: unknown, suggestion?: string): void {
  ctx.issues.push({
    segments: [...segments],
    keyword,
    message,
    expected: describeSchema(schema),
    received,
    schema,
    ancestors: [...ancestors],
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}

/** Levenshtein-Abstand für „Meintest du …?“-Vorschläge. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** Findet den ähnlichsten Kandidaten, wenn er nah genug ist. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase();
  const prefix = candidates.filter((c) => c.length >= 3 && (lower.startsWith(c.toLowerCase()) || c.toLowerCase().startsWith(lower)));
  if (prefix.length > 0) return [...prefix].sort((a, b) => Math.abs(a.length - word.length) - Math.abs(b.length - word.length))[0];
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best !== undefined && bestDistance <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function checkType(schema: JsonSchema, value: unknown): boolean {
  const type = str(schema['type']);
  switch (type) {
    case undefined:
      return true;
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Zählt Verstöße eines Werts gegen ein Schema, ohne sie zu melden. */
function countIssues(schema: JsonSchema, value: unknown): number {
  const ctx: Ctx = { issues: [], onNode: () => undefined };
  walk(schema, value, [], [], ctx);
  return ctx.issues.length;
}

/** Wählt bei `anyOf` den Zweig, dessen Fehler gemeldet werden. */
function selectBranch(schema: JsonSchema, branches: readonly JsonSchema[], value: unknown): JsonSchema | undefined {
  // 1. Animations-Schlüssel ($keyframes, $spring …)
  if (isRecord(value)) {
    const dollar = Object.keys(value).find((k) => k.startsWith('$'));
    if (dollar !== undefined) {
      const hit = branches.find((b) => isRecord(b['properties']) && dollar in b['properties']);
      if (hit !== undefined) return hit;
      // Verschachtelte Union (z. B. Paint = AColor | Gradient)
      const nested = branches.find((b) => b[ANIMATABLE_MARK] === true);
      if (nested !== undefined) return nested;
      if (schema[ANIMATABLE_MARK] === true) return undefined;
    }
    // 2. Diskriminator `type`
    const discriminator = value['type'];
    if (typeof discriminator === 'string') {
      const hit = branches.find((b) => {
        const props = b['properties'];
        return isRecord(props) && isRecord(props['type']) && props['type']['const'] === discriminator;
      });
      if (hit !== undefined) return hit;
    }
  }
  // 3. Bei animierbaren Werten ohne `$`-Schlüssel: der Literal-Zweig
  if (schema[ANIMATABLE_MARK] === true && !(isRecord(value) && Object.keys(value).some((k) => k.startsWith('$')))) {
    const literal = branches[0];
    if (literal !== undefined && (checkType(literal, value) || literal['anyOf'] !== undefined)) return literal;
  }
  // 4. Zweige mit passendem Grundtyp, davon der mit den wenigsten Fehlern
  const typed = branches.filter((b) => b['anyOf'] !== undefined || 'const' in b || Array.isArray(b['enum']) || checkType(b, value));
  if (typed.length === 0) return undefined;
  let best: JsonSchema | undefined;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const b of typed) {
    const c = countIssues(b, value);
    if (c < bestCount) {
      bestCount = c;
      best = b;
    }
  }
  return best;
}

function walk(schema: JsonSchema, value: unknown, segments: readonly Segment[], ancestors: readonly AncestorFrame[], ctx: Ctx): void {
  if (schema[NODE_MARK] === true) {
    ctx.onNode(value, segments);
    return;
  }
  if (schema[NODE_ARRAY_MARK] === true) {
    if (!Array.isArray(value)) {
      push(ctx, ancestors, segments, schema, 'type', 'Expected an array of nodes.', value);
      return;
    }
    value.forEach((child, i) => {
      ctx.onNode(child, [...segments, i]);
    });
    return;
  }

  const anyOf = schemaArray(schema['anyOf']);
  if (anyOf.length > 0) {
    const branch = selectBranch(schema, anyOf, value);
    if (branch === undefined) {
      if (isRecord(value) && schema[ANIMATABLE_MARK] === true && Object.keys(value).some((k) => k.startsWith('$'))) {
        const key = Object.keys(value).find((k) => k.startsWith('$')) ?? '';
        const known = ['$keyframes', '$spring', '$expr', '$sampled', '$ref'];
        const hint = closest(key, known);
        push(ctx, ancestors, segments, schema, 'animation', `Unknown animation key "${key}".`, value, hint !== undefined ? `Use "${hint}".` : `Use one of ${known.join(', ')}.`);
        return;
      }
      push(ctx, ancestors, segments, schema, 'anyOf', `Value does not match ${describeSchema(schema)}.`, value);
      return;
    }
    walk(branch, value, segments, [...ancestors, { schema, depth: segments.length }], ctx);
    return;
  }

  if (Array.isArray(schema['enum'])) {
    const options = schema['enum'];
    if (!options.includes(value)) {
      const hint = typeof value === 'string' ? closest(value, options.filter((o): o is string => typeof o === 'string')) : undefined;
      push(ctx, ancestors, segments, schema, 'enum', `Expected ${describeSchema(schema)}.`, value, hint !== undefined ? JSON.stringify(hint) : undefined);
    }
    return;
  }
  if ('const' in schema) {
    if (value !== schema['const']) push(ctx, ancestors, segments, schema, 'const', `Expected ${JSON.stringify(schema['const'])}.`, value);
    return;
  }

  if (!checkType(schema, value)) {
    push(ctx, ancestors, segments, schema, 'type', `Expected ${describeSchema(schema)}.`, value);
    return;
  }

  const type = str(schema['type']);
  if (type === 'string' && typeof value === 'string') {
    const pattern = str(schema['pattern']);
    if (pattern !== undefined && !new RegExp(pattern, 'u').test(value)) {
      push(ctx, ancestors, segments, schema, 'pattern', `Expected ${describeSchema(schema)}.`, value);
    }
    const minLength = num(schema['minLength']);
    if (minLength !== undefined && value.length < minLength) push(ctx, ancestors, segments, schema, 'minLength', `Expected at least ${String(minLength)} characters.`, value);
    const maxLength = num(schema['maxLength']);
    if (maxLength !== undefined && value.length > maxLength) push(ctx, ancestors, segments, schema, 'maxLength', `Expected at most ${String(maxLength)} characters.`, value);
    return;
  }
  if ((type === 'number' || type === 'integer') && typeof value === 'number') {
    const min = num(schema['minimum']);
    const max = num(schema['maximum']);
    const exMin = num(schema['exclusiveMinimum']);
    const exMax = num(schema['exclusiveMaximum']);
    if ((min !== undefined && value < min) || (max !== undefined && value > max) || (exMin !== undefined && value <= exMin) || (exMax !== undefined && value >= exMax)) {
      push(ctx, ancestors, segments, schema, 'range', `Expected ${describeSchema(schema)}.`, value);
    }
    return;
  }
  if (type === 'array' && Array.isArray(value)) {
    const minItems = num(schema['minItems']);
    const maxItems = num(schema['maxItems']);
    if (minItems !== undefined && value.length < minItems) push(ctx, ancestors, segments, schema, 'minItems', `Expected at least ${String(minItems)} items.`, value);
    if (maxItems !== undefined && value.length > maxItems) push(ctx, ancestors, segments, schema, 'maxItems', `Expected at most ${String(maxItems)} items.`, value);
    const items = schema['items'];
    const next = [...ancestors, { schema, depth: segments.length }];
    if (Array.isArray(items)) {
      const tuple = schemaArray(items);
      tuple.forEach((itemSchema, i) => {
        if (i < value.length) walk(itemSchema, value[i], [...segments, i], next, ctx);
      });
      if (schema['additionalItems'] === false && value.length > tuple.length) {
        push(ctx, ancestors, segments, schema, 'maxItems', `Expected exactly ${String(tuple.length)} items.`, value);
      }
    } else if (isRecord(items)) {
      value.forEach((item, i) => {
        walk(items, item, [...segments, i], next, ctx);
      });
    }
    return;
  }
  if (type === 'object' && isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : [];
    const next = [...ancestors, { schema, depth: segments.length }];
    for (const key of required) {
      if (!(key in value) || value[key] === undefined) {
        const propSchema = properties[key];
        const example = isRecord(propSchema) ? exampleOf(propSchema) : undefined;
        push(
          ctx,
          ancestors,
          [...segments, key],
          isRecord(propSchema) ? propSchema : schema,
          'required',
          `Missing required property "${key}".`,
          undefined,
          example !== undefined ? `${key}: ${formatValue(example)}` : undefined,
        );
      }
    }
    const patternProps = isRecord(schema['patternProperties']) ? schema['patternProperties'] : undefined;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const propSchema = properties[key];
      if (isRecord(propSchema)) {
        walk(propSchema, child, [...segments, key], next, ctx);
        continue;
      }
      if (patternProps !== undefined) {
        const match = Object.entries(patternProps).find(([p]) => new RegExp(p, 'u').test(key));
        if (match !== undefined && isRecord(match[1])) {
          walk(match[1], child, [...segments, key], next, ctx);
          continue;
        }
        push(ctx, ancestors, [...segments, key], schema, 'propertyName', `Key "${key}" does not match ${Object.keys(patternProps).join(' or ')}.`, key);
        continue;
      }
      if (schema['additionalProperties'] === false) {
        const hint = closest(key, Object.keys(properties));
        push(
          ctx,
          ancestors,
          [...segments, key],
          schema,
          'additionalProperties',
          `Unknown property "${key}".`,
          child,
          hint !== undefined ? `Did you mean "${hint}"?` : `Remove "${key}". Allowed: ${Object.keys(properties).join(', ')}.`,
        );
      }
    }
  }
}

/**
 * Validiert einen Wert gegen ein Schema und sammelt alle Verstöße.
 *
 * @param onNode Rückruf für eingebettete Nodes (Felder mit `x-node`/`x-node-array`).
 *
 * @example
 * ```ts
 * const issues = validateValue(RectNode, { id: 'a', type: 'rect', width: -1, height: 10 });
 * // issues[0].segments → ['width'], issues[0].expected → 'number >= 0 or an animation …'
 * ```
 */
export function validateValue(schema: object, value: unknown, onNode: NodeVisitor = () => undefined, baseSegments: readonly Segment[] = []): SchemaIssue[] {
  const ctx: Ctx = { issues: [], onNode };
  if (isRecord(schema)) walk(schema, value, baseSegments, [], ctx);
  return ctx.issues;
}

/** Liefert das erste Beispiel eines Schemas, falls vorhanden. */
export function exampleOf(schema: object): unknown {
  if (!isRecord(schema)) return undefined;
  const examples = schema['examples'];
  if (Array.isArray(examples) && examples.length > 0) return examples[0];
  if ('default' in schema) return schema['default'];
  return undefined;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** Formatiert einen Wert wie ein JS-Objektliteral: `{ x: 1.2, y: 1.2 }`. */
export function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${formatValue(v)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'undefined';
  return JSON.stringify(value);
}
