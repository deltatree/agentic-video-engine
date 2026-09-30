// Story 19.7: ein gültiges JSON-Beispiel je Node-Typ, im JSON Schema und in den Kurzbeschreibungen.
import { describe, expect, it } from 'vitest';
import Type from 'typebox';
import {
  EXAMPLE_ASSETS,
  NODE_EXAMPLES,
  NODE_SCHEMAS,
  NODE_TYPES_3D,
  buildJsonSchema,
  builtinNodeTypeSummaries,
  describePropertyType,
  exampleProject,
  summarizeNodeType,
  validateProject,
  type BuiltinNodeType,
} from '@agentic-video/schema';

const TYPES = Object.keys(NODE_SCHEMAS) as BuiltinNodeType[];

/** Alle Node-IDs eines JSON-Baums (Kinder, Masken). */
function ids(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) ids(v, out);
  else if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    if (typeof rec['id'] === 'string' && typeof rec['type'] === 'string') out.push(rec['id']);
    for (const v of Object.values(rec)) ids(v, out);
  }
  return out;
}

describe('NODE_EXAMPLES (Story 19.7)', () => {
  it('hat genau ein Beispiel je eingebautem Node-Typ (31, inkl. sequence) mit passendem type', () => {
    expect(TYPES).toHaveLength(31);
    expect(Object.keys(NODE_EXAMPLES).sort()).toEqual([...TYPES].sort());
    for (const type of TYPES) expect(NODE_EXAMPLES[type].type).toBe(type);
  });

  it.each(TYPES)('Beispiel "%s" ist gegen Schema und Semantik gültig', (type) => {
    const project = exampleProject(type);
    const result = validateProject(project);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    const all = ids(project.compositions);
    expect(new Set(all).size).toBe(all.length);
  });

  it('bettet 3D-Beispiele in eine scene3d ein und nimmt nur benutzte Assets, Tracks und Compositions mit', () => {
    const mesh = exampleProject('mesh3d');
    const scene = mesh.compositions[0]?.nodes[0];
    expect(scene?.type).toBe('scene3d');
    expect(NODE_TYPES_3D).toContain('mesh3d');
    expect(mesh.assets).toBeUndefined();
    expect(exampleProject('image').assets?.map((a) => a.id)).toEqual(['logo']);
    expect(exampleProject('model3d').assets?.map((a) => a.id)).toEqual(['robot']);
    expect(exampleProject('subtitles').compositions[0]?.tracks?.map((t) => t.id)).toEqual(['captions']);
    expect(exampleProject('composition-ref').compositions.map((c) => c.id)).toEqual(['main', 'intro']);
    expect(exampleProject('rect').compositions.map((c) => c.id)).toEqual(['main']);
    for (const asset of EXAMPLE_ASSETS) expect(asset.license?.name).toBe('CC0-1.0');
  });

  it('liefert unabhängige Kopien: Änderungen am Projekt verändern die Beispiele nicht', () => {
    const project = exampleProject('rect');
    const node = project.compositions[0]?.nodes[0];
    if (node?.type !== 'rect') throw new Error('rect expected');
    node.width = 1;
    expect(NODE_EXAMPLES.rect.width).toBe(400);
    expect(summarizeNodeType('rect', NODE_SCHEMAS.rect).example).toEqual(NODE_EXAMPLES.rect);
  });

  it('steht als examples in jedem Node_<typ> des JSON Schemas', () => {
    const defs = buildJsonSchema()['$defs'] as Record<string, Record<string, unknown>>;
    for (const type of TYPES) {
      const def = defs[`Node_${type.replace(/-/gu, '_')}`];
      expect(def?.['examples'], type).toEqual([NODE_EXAMPLES[type]]);
    }
  });
});

describe('Kurzbeschreibung der Node-Typen mit Property-Typen', () => {
  it('nennt Typen statt nur Namen', () => {
    const rect = builtinNodeTypeSummaries()['rect'];
    expect(rect?.required).toEqual(['width', 'height']);
    expect(rect?.properties).toContain('cornerRadius');
    expect(rect?.propertyTypes['opacity']).toBe('number (0..1, animatable)');
    expect(rect?.propertyTypes['fill']).toBe('color (animatable) | { type, stops, start?, end?, center?, radius?, angle?, units? }');
    expect(rect?.propertyTypes['strokeCap']).toBe('"butt" | "round" | "square"');
    expect(rect?.propertyTypes['scale']).toBe('{ x, y } (animatable)');
    expect(rect?.propertyTypes).not.toHaveProperty('id');
    const summaries = builtinNodeTypeSummaries();
    expect(summaries['sequence']?.propertyTypes['children']).toBe('node[]');
    expect(summaries['sequence']?.propertyTypes['between']).toBe('{ type: "cut" } | { type, duration, ease? }');
    expect(summaries['image']?.propertyTypes['asset']).toBe('id');
    expect(summaries['particles']?.propertyTypes['count']).toBe('integer (1..100000)');
    expect(summaries['particles']?.propertyTypes['emitDuration']).toBe('time');
    expect(summaries['polygon']?.propertyTypes['points']).toBe('([number, number])[] (animatable)');
    expect(summaries['shader']?.propertyTypes['uniforms']).toBe('Record<string, (number | number[]) (animatable)>');
    expect(summaries['text']?.propertyTypes['textAnimation']).toBe('{ unit, start?, stagger?, duration?, ease?, from, order?, starts? }');
    expect(summaries['mesh3d']?.propertyTypes['position']).toBe('[number, number, number] (animatable)');
    for (const [type, s] of Object.entries(summaries)) expect(Object.keys(s.propertyTypes), type).toEqual(s.properties);
  });

  it('beschreibt Randfälle kompakt', () => {
    expect(describePropertyType(undefined)).toBe('unknown');
    expect(describePropertyType(Type.Boolean())).toBe('boolean');
    expect(describePropertyType(Type.Number({ exclusiveMinimum: 0 }))).toBe('number (> 0)');
    expect(describePropertyType(Type.Number({ maximum: 5 }))).toBe('number (<= 5)');
    expect(describePropertyType(Type.Object({}))).toBe('object');
    expect(describePropertyType(Type.Unknown())).toBe('unknown');
  });

  it('übernimmt für Plugin-Node-Typen das erste examples ihres Schemas', () => {
    const schema = Type.Object({ id: Type.String(), type: Type.Literal('plugin-badge'), label: Type.String() }, { description: 'Badge from a plugin.', examples: [{ id: 'b', type: 'plugin-badge', label: 'Hi' }] });
    const summary = summarizeNodeType('plugin-badge', schema);
    expect(summary).toEqual({ description: 'Badge from a plugin.', properties: ['label'], propertyTypes: { label: 'string' }, required: ['label'], example: { id: 'b', type: 'plugin-badge', label: 'Hi' } });
    expect(summarizeNodeType('bare', {})).toEqual({ description: '', properties: [], propertyTypes: {}, required: [] });
  });
});
