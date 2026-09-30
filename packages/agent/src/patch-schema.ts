/**
 * Typisiertes Patch-Schema der Agent API (Story 19.1).
 *
 * Jede Patch-Art aus `@agentic-video/core` (`PATCH_OPS`) ist ein eigener Zweig einer
 * Union mit dem Diskriminator `op`. MCP-Clients und die HTTP-API sehen so die genauen
 * Felder je Patch-Art, statt sie raten zu müssen. Die Prüfung wählt den Zweig über `op`
 * und meldet genau einen Fehler mit Pfad (`patches[3].nodeId`), `expected`, `received`
 * und einem Beispiel.
 */
import Type, { type TLiteral, type TObject, type TProperties } from 'typebox';
import { PATCH_OPS, closest, isRecord, validateValue, type Diagnostic, type Patch, type Segment } from '@agentic-video/core';

/** Name einer Patch-Art. */
export type PatchOp = (typeof PATCH_OPS)[number];

const NodeIdField = Type.String({ minLength: 1, description: 'Node id (scene.tree and composition.get list them).' });
const CompositionIdField = Type.Optional(Type.String({ minLength: 1, description: 'Composition id; only needed when the node id exists in several compositions.' }));
const PropertyField = Type.String({ minLength: 1, description: 'Property path, e.g. "fontSize", "fill" or "scale.x".' });
const ValueField = Type.Unknown({ description: 'New JSON value (number, string, object, animation like {"$keyframes": [...]}). null deletes the property unless keepNull is true.' });
const KeepNullField = Type.Optional(Type.Boolean({ description: 'true stores the JSON value null instead of deleting the property.' }));
const IndexField = Type.Optional(Type.Integer({ minimum: 0, description: 'Position in the parent (0 = first, drawn first). Absent = append at the end (drawn on top).' }));
const ParentIdField = Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Parent node id (group, layer …), or null for the top level of the composition. Absent = top level.' }));
const TimeField = Type.Union([Type.Number(), Type.String()], { description: 'Time: frames (48) or text ("2s", "500ms", "00:00:02:00", "marker:intro+10f").' });
const JsonObject = Type.Record(Type.String(), Type.Unknown());

/**
 * Beispiele je Patch-Art. Der letzte Eintrag ist das Beispiel der Patch-Art; davor stehen
 * Patches, die es braucht (z. B. ein Keyframe vor `removeKeyframe`). Alle Listen laufen
 * gegen ein Projekt mit der Composition `main` und den Text-Nodes `headline` und `f1`
 * (Doc-Test in `packages/render/test/docs.test.ts`).
 *
 * @example
 * ```ts
 * const [example] = PATCH_EXAMPLES.setProperty; // { op: 'setProperty', nodeId: 'headline', … }
 * ```
 */
export const PATCH_EXAMPLES: { readonly [K in PatchOp]: readonly Patch[] } = {
  setProperty: [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 }],
  addNode: [{ op: 'addNode', parentId: null, node: { id: 'badge', type: 'rect', x: 96, y: 96, width: 240, height: 64, cornerRadius: 12, fill: '#FF5A1F' } }],
  removeNode: [{ op: 'removeNode', nodeId: 'f1' }],
  moveNode: [{ op: 'moveNode', nodeId: 'headline', parentId: null, index: 1 }],
  addKeyframe: [{ op: 'addKeyframe', nodeId: 'headline', property: 'opacity', keyframe: { t: '1s', v: 1, ease: 'easeOutCubic' } }],
  removeKeyframe: [
    { op: 'addKeyframe', nodeId: 'headline', property: 'opacity', keyframe: { t: '1s', v: 1 } },
    { op: 'removeKeyframe', nodeId: 'headline', property: 'opacity', t: '1s' },
  ],
  replaceAsset: [
    { op: 'addAsset', asset: { id: 'music', type: 'audio', src: 'assets/music.wav' } },
    { op: 'replaceAsset', assetId: 'music', src: 'assets/music-v2.wav' },
  ],
  addAsset: [{ op: 'addAsset', asset: { id: 'music', type: 'audio', src: 'assets/music.wav' } }],
  removeAsset: [
    { op: 'addAsset', asset: { id: 'music', type: 'audio', src: 'assets/music.wav' } },
    { op: 'removeAsset', assetId: 'music' },
  ],
  setCompositionProperty: [{ op: 'setCompositionProperty', compositionId: 'main', property: 'background', value: '#101218' }],
  setProjectProperty: [{ op: 'setProjectProperty', property: 'metadata.title', value: 'Launch video' }],
};

/** Das Beispiel einer Patch-Art (letzter Eintrag in {@link PATCH_EXAMPLES}). */
function exampleOf(op: PatchOp): Patch | undefined {
  const list = PATCH_EXAMPLES[op];
  return list[list.length - 1];
}

function branch<O extends PatchOp, F extends TProperties>(op: O, description: string, fields: F): TObject<{ op: TLiteral<O> } & F> {
  const example = exampleOf(op);
  return Type.Object({ op: Type.Literal(op), ...fields }, { additionalProperties: false, title: op, description, ...(example !== undefined ? { examples: [example] } : {}) });
}

/** Schemas je Patch-Art (Schlüssel = `op`). */
export const PATCH_SCHEMAS = {
  setProperty: branch('setProperty', 'Set (or delete with null) one property of a node.', { nodeId: NodeIdField, property: PropertyField, value: ValueField, keepNull: KeepNullField, compositionId: CompositionIdField }),
  addNode: branch('addNode', 'Insert a new node (with children) under a parent or at the top level.', { parentId: ParentIdField, node: JsonObject, index: IndexField, compositionId: CompositionIdField }),
  removeNode: branch('removeNode', 'Remove a node and its children.', { nodeId: NodeIdField, compositionId: CompositionIdField }),
  moveNode: branch('moveNode', 'Move a node to another parent or position (z-order).', { nodeId: NodeIdField, parentId: ParentIdField, index: IndexField, compositionId: CompositionIdField }),
  addKeyframe: branch('addKeyframe', 'Add or replace a keyframe of a property; a static value becomes {"$keyframes": [...]}.', {
    nodeId: NodeIdField,
    property: PropertyField,
    keyframe: Type.Object({ t: TimeField, v: Type.Unknown({ description: 'Value at time t.' }), ease: Type.Optional(Type.String({ description: 'Easing of the segment that ends at this keyframe, e.g. "easeOutCubic".' })) }, { additionalProperties: false }),
    compositionId: CompositionIdField,
  }),
  removeKeyframe: branch('removeKeyframe', 'Remove the keyframe at time t.', { nodeId: NodeIdField, property: PropertyField, t: TimeField, compositionId: CompositionIdField }),
  replaceAsset: branch('replaceAsset', 'Point an asset to another file (all nodes using it change).', { assetId: Type.String({ minLength: 1 }), src: Type.String({ minLength: 1 }), type: Type.Optional(Type.String()), hash: Type.Optional(Type.String()) }),
  addAsset: branch('addAsset', 'Declare a new asset ({ id, type, src }); asset.import also copies the file.', { asset: JsonObject }),
  removeAsset: branch('removeAsset', 'Remove an asset declaration.', { assetId: Type.String({ minLength: 1 }) }),
  setCompositionProperty: branch('setCompositionProperty', 'Set a property of a composition (background, duration, markers …).', { compositionId: Type.String({ minLength: 1 }), property: PropertyField, value: ValueField, keepNull: KeepNullField }),
  setProjectProperty: branch('setProjectProperty', 'Set a project property (metadata, settings.theme …).', { property: PropertyField, value: ValueField, keepNull: KeepNullField }),
} as const;

/**
 * Union aller Patch-Arten mit Diskriminator `op` (JSON Schema `anyOf` plus `discriminator`).
 *
 * @example
 * ```ts
 * const input = Type.Object({ patches: Type.Array(PatchSchema) });
 * ```
 */
export const PatchSchema = Type.Union(
  [
    PATCH_SCHEMAS.setProperty,
    PATCH_SCHEMAS.addNode,
    PATCH_SCHEMAS.removeNode,
    PATCH_SCHEMAS.moveNode,
    PATCH_SCHEMAS.addKeyframe,
    PATCH_SCHEMAS.removeKeyframe,
    PATCH_SCHEMAS.replaceAsset,
    PATCH_SCHEMAS.addAsset,
    PATCH_SCHEMAS.removeAsset,
    PATCH_SCHEMAS.setCompositionProperty,
    PATCH_SCHEMAS.setProjectProperty,
  ],
  { description: `One semantic patch; "op" selects the kind: ${PATCH_OPS.join(' | ')}.`, discriminator: { propertyName: 'op' } },
);

/** Formatiert Pfadsegmente als `patches[3].keyframe.t`. */
export function formatSegments(segments: readonly Segment[]): string {
  let out = '';
  for (const s of segments) out += typeof s === 'number' ? `[${String(s)}]` : out === '' ? s : `.${s}`;
  return out;
}

function received(value: unknown): string {
  if (value === undefined) return 'undefined (missing)';
  const text = JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function isPatchOp(value: unknown): value is PatchOp {
  return PATCH_OPS.some((op) => op === value);
}

function patchDiagnostic(problem: string, path: string, expected: string, got: unknown, suggestions: readonly string[]): Diagnostic {
  return { code: 'OV_PATCH_INVALID', severity: 'error', errorClass: 'PatchError', problem, path, expected, received: received(got), suggestions };
}

/**
 * Prüft eine Patch-Liste gegen {@link PATCH_SCHEMAS} und liefert den ersten Fehler als Diagnose
 * (Pfad mit Index, `expected`, `received`, Did-you-mean für `op`, Beispiel) oder `undefined`.
 *
 * @example
 * ```ts
 * checkPatchList([{ op: 'setPropety', nodeId: 'a', property: 'x', value: 1 }], 'patches');
 * // { code: 'OV_PATCH_INVALID', path: 'patches[0].op', suggestions: ['Did you mean "setProperty"?', …] }
 * ```
 */
export function checkPatchList(patches: unknown, base: string): Diagnostic | undefined {
  if (!Array.isArray(patches)) return patchDiagnostic(`"${base}" must be an array of patches.`, base, 'array of patch objects', patches, [`Example: ${JSON.stringify(PATCH_EXAMPLES.setProperty)}`]);
  for (let i = 0; i < patches.length; i++) {
    const p: unknown = patches[i];
    const at = `${base}[${String(i)}]`;
    if (!isRecord(p)) return patchDiagnostic(`${at} must be a patch object.`, at, 'object with "op"', p, [`Example: ${JSON.stringify(exampleOf('setProperty'))}`]);
    const op = p['op'];
    if (!isPatchOp(op)) {
      const guess = typeof op === 'string' ? closest(op, PATCH_OPS) : undefined;
      const hint = isPatchOp(guess) ? [`Did you mean "${guess}"? Example: ${JSON.stringify(exampleOf(guess))}`] : [];
      return patchDiagnostic(op === undefined ? `${at} has no "op".` : `${at} has the unknown op ${received(op)}.`, `${at}.op`, `one of ${PATCH_OPS.join(', ')}`, op, [...hint, `Use one of: ${PATCH_OPS.join(', ')}.`]);
    }
    const issues = validateValue(PATCH_SCHEMAS[op], p);
    const first = issues[0];
    if (first !== undefined) {
      const path = first.segments.length > 0 ? `${at}.${formatSegments(first.segments)}` : at;
      const example = exampleOf(op);
      return patchDiagnostic(`${path} (${op}): ${first.message}`, path, first.expected, first.received, [
        ...(first.suggestion !== undefined ? [first.suggestion] : []),
        `Example ${op} patch: ${JSON.stringify(example)}`,
      ]);
    }
  }
  return undefined;
}

/**
 * Wandelt geprüfte Patch-Objekte in `Patch`-Werte aus `core` um. Fehlt `parentId` bei
 * `addNode`/`moveNode`, gilt `null` (oberste Ebene). Rufe vorher {@link checkPatchList} auf.
 *
 * @example
 * ```ts
 * const patches = toCorePatches([{ op: 'addNode', node: { id: 'a', type: 'rect' } }]); // parentId: null
 * ```
 */
export function toCorePatches(list: readonly unknown[]): Patch[] {
  const out: Patch[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const p = raw;
    const s = (k: string): string => {
      const v = p[k];
      return typeof v === 'string' ? v : '';
    };
    const comp = typeof p['compositionId'] === 'string' ? { compositionId: p['compositionId'] } : {};
    const index = typeof p['index'] === 'number' ? { index: p['index'] } : {};
    const keepNull = p['keepNull'] === true ? { keepNull: true } : {};
    const parentId = typeof p['parentId'] === 'string' ? p['parentId'] : null;
    const obj = (k: string): Readonly<Record<string, unknown>> => {
      const v = p[k];
      return isRecord(v) ? v : {};
    };
    const time = (v: unknown): number | string => (typeof v === 'number' || typeof v === 'string' ? v : 0);
    switch (p['op']) {
      case 'setProperty':
        out.push({ op: 'setProperty', nodeId: s('nodeId'), property: s('property'), value: p['value'], ...keepNull, ...comp });
        break;
      case 'addNode':
        out.push({ op: 'addNode', parentId, node: obj('node'), ...index, ...comp });
        break;
      case 'removeNode':
        out.push({ op: 'removeNode', nodeId: s('nodeId'), ...comp });
        break;
      case 'moveNode':
        out.push({ op: 'moveNode', nodeId: s('nodeId'), parentId, ...index, ...comp });
        break;
      case 'addKeyframe': {
        const k = obj('keyframe');
        out.push({ op: 'addKeyframe', nodeId: s('nodeId'), property: s('property'), keyframe: { t: time(k['t']), v: k['v'], ...(typeof k['ease'] === 'string' ? { ease: k['ease'] } : {}) }, ...comp });
        break;
      }
      case 'removeKeyframe':
        out.push({ op: 'removeKeyframe', nodeId: s('nodeId'), property: s('property'), t: time(p['t']), ...comp });
        break;
      case 'replaceAsset':
        out.push({ op: 'replaceAsset', assetId: s('assetId'), src: s('src'), ...(typeof p['type'] === 'string' ? { type: p['type'] } : {}), ...(typeof p['hash'] === 'string' ? { hash: p['hash'] } : {}) });
        break;
      case 'addAsset':
        out.push({ op: 'addAsset', asset: obj('asset') });
        break;
      case 'removeAsset':
        out.push({ op: 'removeAsset', assetId: s('assetId') });
        break;
      case 'setCompositionProperty':
        out.push({ op: 'setCompositionProperty', compositionId: s('compositionId'), property: s('property'), value: p['value'], ...keepNull });
        break;
      case 'setProjectProperty':
        out.push({ op: 'setProjectProperty', property: s('property'), value: p['value'], ...keepNull });
        break;
      default:
        break;
    }
  }
  return out;
}
