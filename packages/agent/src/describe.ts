/**
 * Selbstbeschreibung der Agent API (Story 19.3): `capabilities.get` und `schema.get`.
 * Dieselben Daten liefern der MCP-Server als Resources und `scripts/generate-docs.mjs`
 * als `docs/ai/capabilities.json`.
 */
import Type from 'typebox';
import {
  ASSET_TYPES,
  BLEND_MODES,
  EASINGS,
  EXPR_FUNCTIONS,
  Filter,
  LayerEffect,
  NODE_SCHEMAS,
  OUTPUT_FORMATS,
  OpenVideoError,
  PATCH_OPS,
  PRODUCT_NAME,
  SCHEMA_VERSION,
  TRANSITION_TYPES,
  VIDEO_CODECS,
  buildJsonSchema,
  closest,
  isRecord,
  type Registry,
} from '@agentic-video/core';
import { defineOperation, type OperationDefinition } from './operation.js';
import { PATCH_EXAMPLES, PATCH_SCHEMAS, PatchSchema } from './patch-schema.js';
import { AnyObject, ProjectId, loadProject } from './shared.js';

/** Felder, die jede Node hat und die der Manifest-Auszug weglässt. */
const COMMON_FIELDS = new Set(['id', 'type', 'name', 'comment', 'meta']);

/** `const`-Werte des Feldes `type` aller Zweige einer Union (z. B. Filter-Typen). */
function unionTypes(schema: unknown): string[] {
  if (!isRecord(schema) || !Array.isArray(schema['anyOf'])) return [];
  return schema['anyOf'].flatMap((branch: unknown) => {
    const props = isRecord(branch) ? branch['properties'] : undefined;
    const type = isRecord(props) ? props['type'] : undefined;
    return isRecord(type) && typeof type['const'] === 'string' ? [type['const']] : [];
  });
}

/** JSON-Kopie ohne Funktionen und Symbole (TypeBox-Schemas sind JSON-artig). */
function toJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function nodeTypeSummary(schema: unknown): { description: string; properties: string[]; required: string[] } {
  const s = isRecord(schema) ? schema : {};
  const props = isRecord(s['properties']) ? Object.keys(s['properties']) : [];
  const required = Array.isArray(s['required']) ? s['required'].filter((r): r is string => typeof r === 'string') : [];
  return { description: typeof s['description'] === 'string' ? s['description'] : '', properties: props.filter((k) => !COMMON_FIELDS.has(k)), required: required.filter((k) => k !== 'id' && k !== 'type') };
}

/** Optionen für {@link buildCapabilities}. */
export interface CapabilityOptions {
  /** Backend-Versionen aufnehmen (startet bei manchen Backends nichts; Standard `false`). */
  readonly versions?: boolean;
  /** Gebündelte Schriftfamilien. */
  readonly fonts?: readonly string[];
}

/**
 * Baut das Capability-Manifest aus Registry (Node-Typen, Komponenten, Backends) und Operationen.
 *
 * @example
 * ```ts
 * const manifest = buildCapabilities(env.registry, OPERATIONS);
 * manifest.operations.length; // Zahl der Operationen
 * ```
 */
export function buildCapabilities(registry: Registry, operations: ReadonlyMap<string, OperationDefinition>, options: CapabilityOptions = {}) {
  const nodeSchemas: Readonly<Record<string, unknown>> = { ...NODE_SCHEMAS, ...registry.extraNodeSchemas() };
  return {
    product: PRODUCT_NAME,
    schemaVersion: SCHEMA_VERSION,
    nodeTypes: Object.fromEntries(Object.entries(nodeSchemas).map(([type, s]) => [type, nodeTypeSummary(s)])),
    components: [...registry.components.values()].map((c) => ({ name: c.name, description: c.description, props: toJson(c.propsSchema ?? {}), example: toJson(c.example) })),
    operations: [...operations.values()].map((op) => ({ name: op.name, summary: op.summary, job: op.job === true, example: toJson(op.example.input) })),
    patchOps: [...PATCH_OPS],
    backends: [...registry.backends.values()].map((b) => ({ id: b.id, nodeTypes: [...b.nodeTypes], capabilities: [...b.capabilities], fusable: b.fusable, ...(options.versions === true ? { versions: b.versions() } : {}) })),
    easings: [...Object.keys(EASINGS), 'ease', 'easeIn', 'easeOut', 'easeInOut', 'cubic-bezier(x1,y1,x2,y2)', 'steps(n,start|end)', 'spring(stiffness,damping[,mass])'],
    transitions: [...TRANSITION_TYPES],
    blendModes: [...BLEND_MODES],
    layerEffects: unionTypes(LayerEffect),
    filters: unionTypes(Filter),
    expressionFunctions: Object.keys(EXPR_FUNCTIONS),
    outputFormats: [...OUTPUT_FORMATS],
    videoCodecs: [...VIDEO_CODECS],
    assetTypes: [...ASSET_TYPES],
    ...(options.fonts !== undefined ? { bundledFonts: [...options.fonts] } : {}),
  };
}

function notFound(what: string, name: string, known: readonly string[]): OpenVideoError {
  const guess = closest(name, known);
  return new OpenVideoError({
    code: 'OV_API_UNKNOWN_NAME',
    errorClass: 'ApiError',
    problem: `Unknown ${what} "${name}".`,
    received: JSON.stringify(name),
    suggestions: [...(guess !== undefined ? [`Did you mean "${guess}"?`] : []), `Use one of: ${known.join(', ')}.`],
  });
}

/** Ersetzt `$ref` auf `$defs` durch den Inhalt; Verweise auf Kind-Nodes bleiben (sonst endlos). */
function inlineRefs(value: unknown, defs: Readonly<Record<string, unknown>>, depth = 0): unknown {
  if (depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => inlineRefs(v, defs, depth + 1));
  if (!isRecord(value)) return value;
  const ref = value['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/$defs/') && ref !== '#/$defs/Node') {
    const target = defs[ref.slice('#/$defs/'.length)];
    const { $ref: _ref, ...rest } = value;
    const inner = isRecord(target) ? inlineRefs(target, defs, depth + 1) : undefined;
    return isRecord(inner) ? { ...inner, ...rest } : value;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineRefs(v, defs, depth + 1)]));
}

/**
 * Erzeugt `capabilities.get` und `schema.get`. `operations` liefert das vollständige Register
 * erst beim Aufruf (so kann das Register diese Operationen selbst enthalten).
 *
 * @example
 * ```ts
 * const [capabilitiesGet, schemaGet] = describeOperations(() => OPERATIONS);
 * ```
 */
export function describeOperations(operations: () => ReadonlyMap<string, OperationDefinition>) {
  const capabilitiesGet = defineOperation({
    name: 'capabilities.get',
    summary: 'What this host can do: node types, components (props + example), operations, patch ops, backends, easings, formats. Filter with nodeType or component.',
    input: Type.Object(
      {
        nodeType: Type.Optional(Type.String({ description: 'Only this node type (properties, required fields, backends that render it).' })),
        component: Type.Optional(Type.String({ description: 'Only this component (props schema and example).' })),
        projectId: Type.Optional(ProjectId),
      },
      { additionalProperties: false },
    ),
    output: AnyObject,
    example: { input: { nodeType: 'text' } },
    async handler(input, ctx) {
      const project: Record<string, unknown> = input.projectId !== undefined ? (await loadProject(ctx, input.projectId)).project : { schemaVersion: SCHEMA_VERSION, compositions: [] };
      const dir = input.projectId !== undefined ? ctx.services.workspace.projectDir(input.projectId) : ctx.services.workspace.root;
      return ctx.services.withEnvironment(dir, project, (env): Promise<Record<string, unknown>> => {
        const all = buildCapabilities(env.registry, operations());
        if (input.nodeType !== undefined) {
          const summary = all.nodeTypes[input.nodeType];
          if (summary === undefined) throw notFound('node type', input.nodeType, Object.keys(all.nodeTypes));
          return Promise.resolve({ nodeType: input.nodeType, ...summary, backends: all.backends.filter((b) => b.nodeTypes.includes(input.nodeType ?? '')).map((b) => b.id), schema: 'schema.get { "nodeType": "<type>" } returns the full JSON Schema.' });
        }
        if (input.component !== undefined) {
          const hit = all.components.find((c) => c.name === input.component);
          if (hit === undefined) throw notFound('component', input.component, all.components.map((c) => c.name));
          return Promise.resolve({ component: hit });
        }
        return Promise.resolve({ ...all });
      });
    },
  });

  const schemaGet = defineOperation({
    name: 'schema.get',
    summary: 'JSON Schema of the Composition IR, of one node type, of the patch format, or of an operation input/output.',
    input: Type.Object(
      {
        nodeType: Type.Optional(Type.String({ description: 'Schema of one node type (references resolved; child nodes stay {"$ref": "#/$defs/Node"}).' })),
        name: Type.Optional(Type.Union([Type.Literal('project'), Type.Literal('patch')], { description: '"project" (default): the whole IR. "patch": the typed patch union with one example per op.' })),
        operation: Type.Optional(Type.String({ description: 'Input and output schema of an operation, e.g. "composition.patch".' })),
      },
      { additionalProperties: false },
    ),
    output: AnyObject,
    example: { input: { nodeType: 'rect' } },
    handler(input) {
      if (input.operation !== undefined) {
        const ops = operations();
        const op = ops.get(input.operation);
        if (op === undefined) throw notFound('operation', input.operation, [...ops.keys()]);
        return Promise.resolve({ operation: op.name, summary: op.summary, input: toJson(op.input), output: toJson(op.output), example: toJson(op.example.input) });
      }
      if (input.name === 'patch') {
        return Promise.resolve({ schema: toJson(PatchSchema), ops: [...PATCH_OPS], examples: toJson(PATCH_EXAMPLES), kinds: Object.fromEntries(PATCH_OPS.map((op) => [op, toJson(PATCH_SCHEMAS[op])])) });
      }
      const full = buildJsonSchema();
      if (input.nodeType !== undefined) {
        const defs = isRecord(full['$defs']) ? full['$defs'] : {};
        const key = `Node_${input.nodeType.replace(/-/gu, '_')}`;
        if (!(key in defs)) throw notFound('node type', input.nodeType, Object.keys(NODE_SCHEMAS));
        return Promise.resolve({ nodeType: input.nodeType, schema: inlineRefs(defs[key], defs) });
      }
      return Promise.resolve({ schema: full });
    },
  });
  return [capabilitiesGet, schemaGet] as const;
}
