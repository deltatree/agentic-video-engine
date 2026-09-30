/**
 * Beispiele und Kurzbeschreibung je Node-Typ (Story 19.7).
 *
 * Jeder eingebaute Node-Typ hat genau ein kleines, gültiges JSON-Beispiel ({@link NODE_EXAMPLES}).
 * Die Beispiele stehen im Capability-Manifest (`capabilities.get`, `docs/ai/capabilities.json`),
 * im JSON Schema (`examples` je `Node_<typ>`) und in `docs/reference/node-semantics.md`.
 * {@link exampleProject} bettet ein Beispiel in ein vollständiges Projekt ein (mit den Assets,
 * Untertitel-Tracks und Compositions, auf die es verweist); ein Test validiert und rendert jedes.
 *
 * Die Beispiele liegen bewusst nicht als `examples` im TypeBox-Schema der Node: Der Validator nutzt
 * `examples` für Vorschläge in Diagnosen, und eine ganze Node als Vorschlag wäre dort irreführend.
 */
import { ANIMATABLE_MARK, COLOR_PATTERN, EASING_PATTERN, ID_PATTERN, TIME_STRING_PATTERN } from './primitives.js';
import { NODE_ARRAY_MARK, NODE_MARK, NODE_SCHEMAS, NODE_TYPES_3D, type BuiltinNodeType, type IrNode, type NodeOf } from './nodes.js';
import type { Asset, SubtitleTrack } from './project.js';
import type { IrComposition, IrProject } from './types.js';
import { SCHEMA_VERSION } from './version.js';

/** Register der Beispiele: genau eines je eingebautem Node-Typ, typgeprüft gegen das Schema. */
export type NodeExamples = { readonly [K in BuiltinNodeType]: NodeOf<K> };

/** Kamera und Licht, die mehrere 3D-Beispiele teilen. */
const camera = (): NodeOf<'camera3d'> => ({ id: 'cam', type: 'camera3d', position: [0, 1.5, 5], target: [0, 0, 0], fov: 45 });
const keyLight = (): NodeOf<'light3d'> => ({ id: 'key', type: 'light3d', kind: 'directional', position: [3, 5, 4], intensity: 2.5, castShadow: true });

/** Erzeugt die Beispiele jedes Mal neu, damit Aufrufer sie gefahrlos verändern dürfen. */
function createExamples(): NodeExamples {
  return {
    group: {
      id: 'badge',
      type: 'group',
      x: 220,
      y: 148,
      children: [
        { id: 'badge-bg', type: 'rect', width: 200, height: 64, cornerRadius: 32, fill: '#FF5A1F' },
        { id: 'badge-label', type: 'text', text: 'NEW', y: 12, width: 200, textAlign: 'center', fontSize: 32, fontWeight: 700, fill: '#FFFFFF' },
      ],
    },
    layer: {
      id: 'glow-layer',
      type: 'layer',
      blendMode: 'screen',
      effects: [{ type: 'glow', radius: 16, intensity: 0.8 }],
      children: [{ id: 'orb', type: 'ellipse', x: 220, y: 80, width: 200, height: 200, fill: '#4F8CFF' }],
    },
    'composition-ref': { id: 'intro-ref', type: 'composition-ref', composition: 'intro', timing: { from: 0, duration: '2s', speed: 1 } },
    sequence: {
      id: 'slides',
      type: 'sequence',
      between: { type: 'fade', duration: '0.5s' },
      children: [
        { id: 'slide-1', type: 'rect', width: 640, height: 360, fill: '#1B2A4A', timing: { duration: '1.25s' } },
        { id: 'slide-2', type: 'rect', width: 640, height: 360, fill: '#FF5A1F', timing: { duration: '1.25s' } },
      ],
    },
    component: { id: 'name-tag', type: 'component', component: 'LowerThird', props: { name: 'Ada Lovelace', role: 'Engineer' }, x: 40, y: 250 },
    rect: {
      id: 'card',
      type: 'rect',
      x: 120,
      y: 80,
      width: 400,
      height: 200,
      cornerRadius: 24,
      fill: { type: 'linear', stops: [{ offset: 0, color: '#FF5A1F' }, { offset: 1, color: '#8A2BE2' }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      stroke: '#FFFFFF',
      strokeWidth: 4,
    },
    ellipse: { id: 'dot', type: 'ellipse', x: { $keyframes: [{ t: 0, v: 40 }, { t: '1s', v: 520, ease: 'easeInOutCubic' }] }, y: 140, width: 80, height: 80, fill: '#FF5A1F' },
    line: {
      id: 'underline',
      type: 'line',
      from: { x: 80, y: 180 },
      to: { x: 560, y: 180 },
      stroke: '#FFFFFF',
      strokeWidth: 8,
      strokeCap: 'round',
      trimEnd: { $keyframes: [{ t: 0, v: 0 }, { t: '1s', v: 1, ease: 'easeOutCubic' }] },
    },
    polyline: { id: 'trend', type: 'polyline', points: [[40, 300], [200, 220], [360, 260], [600, 80]], stroke: '#4F8CFF', strokeWidth: 6, strokeJoin: 'round' },
    polygon: { id: 'triangle', type: 'polygon', points: [[320, 60], [520, 300], [120, 300]], fill: '#FFC857' },
    path: { id: 'check', type: 'path', d: 'M 200 180 L 280 260 L 440 100', stroke: '#3DDC97', strokeWidth: 16, strokeCap: 'round', strokeJoin: 'round' },
    text: {
      id: 'headline',
      type: 'text',
      text: 'Hello OpenVideo',
      x: 40,
      y: 140,
      width: 560,
      textAlign: 'center',
      fontSize: 56,
      fontWeight: 700,
      fill: '#F5F7FF',
      textAnimation: { unit: 'char', stagger: 2, duration: 12, from: { opacity: 0, y: 20 } },
    },
    'rich-text': {
      id: 'tagline',
      type: 'rich-text',
      x: 40,
      y: 150,
      width: 560,
      textAlign: 'center',
      fontSize: 44,
      fill: '#F5F7FF',
      spans: [{ text: 'Video as ' }, { text: 'code', fill: '#FF5A1F', fontWeight: 800 }],
    },
    image: { id: 'logo-image', type: 'image', asset: 'logo', x: 220, y: 80, width: 200, height: 200, fit: 'contain' },
    video: { id: 'clip-video', type: 'video', asset: 'clip', width: 640, height: 360, fit: 'cover', muted: true },
    svg: {
      id: 'star',
      type: 'svg',
      x: 270,
      y: 130,
      width: 100,
      height: 100,
      markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z" fill="#FFC857"/></svg>',
    },
    sprite: { id: 'walker', type: 'sprite', asset: 'walk-sheet', columns: 4, rows: 1, frameRate: 8, loop: true, x: 270, y: 130, width: 100, height: 100 },
    lottie: { id: 'spinner-anim', type: 'lottie', asset: 'spinner', x: 220, y: 80, width: 200, height: 200, loop: true },
    shader: {
      id: 'plasma',
      type: 'shader',
      width: 640,
      height: 360,
      sksl: 'uniform float time;\nuniform float2 resolution;\nhalf4 main(float2 coord) {\n  float2 uv = coord / resolution;\n  return half4(half(uv.x), half(uv.y), half(0.5 + 0.5 * sin(time * 3.0)), 1.0);\n}',
    },
    particles: {
      id: 'sparks',
      type: 'particles',
      width: 640,
      height: 360,
      count: 200,
      seed: 7,
      emitter: { x: 320, y: 180, radius: 10, shape: 'circle' },
      lifetime: { min: 0.5, max: 1.5 },
      speed: { min: 60, max: 180 },
      angle: { min: 0, max: 360 },
      size: { start: 6, end: 1 },
      color: { start: '#FFC857', end: '#FF5A1F' },
    },
    html: {
      id: 'html-card',
      type: 'html',
      x: 120,
      y: 80,
      width: 400,
      height: 200,
      html: '<div class="card">Hello from HTML</div>',
      css: '.card { font: 600 40px sans-serif; color: #FFFFFF; padding: 72px 40px; }',
      background: '#1B2A4A',
    },
    subtitles: { id: 'captions-view', type: 'subtitles', track: 'captions', fontSize: 36, style: 'karaoke', color: '#FFFFFF', highlightColor: '#FFC857', position: 'bottom' },
    scene3d: {
      id: 'stage',
      type: 'scene3d',
      width: 640,
      height: 360,
      camera: 'cam',
      background: '#0B0D12',
      children: [camera(), keyLight(), { id: 'cube', type: 'mesh3d', geometry: { type: 'box' }, material: { color: '#FF5A1F', roughness: 0.4 }, rotation: [20, 35, 0] }],
    },
    blender: {
      id: 'hero-shot',
      type: 'blender',
      width: 640,
      height: 360,
      engine: 'eevee',
      samples: 16,
      camera: 'cam',
      children: [camera(), keyLight(), { id: 'ball', type: 'mesh3d', geometry: { type: 'sphere', radius: 1 }, material: { color: '#4F8CFF', metalness: 0.2, roughness: 0.3 } }],
    },
    camera3d: camera(),
    light3d: keyLight(),
    mesh3d: {
      id: 'spinning-cube',
      type: 'mesh3d',
      geometry: { type: 'box', width: 1, height: 1, depth: 1 },
      material: { color: '#FF5A1F', roughness: 0.4 },
      rotation: { $keyframes: [{ t: 0, v: [0, 0, 0] }, { t: '2s', v: [0, 180, 0] }] },
    },
    model3d: { id: 'robot-model', type: 'model3d', asset: 'robot', position: [0, -1, 0], scale: [1, 1, 1] },
    instances3d: {
      id: 'dot-field',
      type: 'instances3d',
      geometry: { type: 'sphere', radius: 0.08 },
      material: { color: '#4F8CFF' },
      count: 100,
      seed: 3,
      layout: { type: 'grid', columns: 10, spacing: 0.3 },
      position: [-1.35, -1.35, 0],
    },
    particles3d: {
      id: 'dust',
      type: 'particles3d',
      count: 500,
      seed: 1,
      emitter: { shape: 'sphere', size: 2 },
      lifetime: { min: 1, max: 3 },
      speed: { min: 0.1, max: 0.5 },
      size: { start: 0.05, end: 0 },
      color: { start: '#FFFFFF', end: '#4F8CFF' },
      additive: true,
    },
    group3d: {
      id: 'rig',
      type: 'group3d',
      rotation: { $keyframes: [{ t: 0, v: [0, 0, 0] }, { t: '2s', v: [0, 90, 0] }] },
      children: [
        { id: 'rig-left', type: 'mesh3d', geometry: { type: 'sphere', radius: 0.4 }, position: [-1, 0, 0], material: { color: '#FF5A1F' } },
        { id: 'rig-right', type: 'mesh3d', geometry: { type: 'sphere', radius: 0.4 }, position: [1, 0, 0], material: { color: '#4F8CFF' } },
      ],
    },
  };
}

/**
 * Ein Beispiel je Node-Typ. Koordinaten passen in eine Composition von 640 × 360 Pixeln.
 * Verweise: Assets aus {@link EXAMPLE_ASSETS}, der Untertitel-Track {@link exampleSubtitleTrack}
 * und die Composition {@link exampleIntroComposition}.
 *
 * @example
 * ```ts
 * NODE_EXAMPLES.rect; // { id: 'card', type: 'rect', width: 400, height: 200, … }
 * ```
 */
export const NODE_EXAMPLES: NodeExamples = createExamples();

/**
 * Assets, auf die die Beispiele verweisen (Pfade relativ zum Projekt). Die Dateien erzeugt der Test
 * bzw. das Beispielprojekt selbst; sie sind eigene, synthetische Inhalte (CC0-1.0).
 */
export const EXAMPLE_ASSETS: readonly Asset[] = [
  { id: 'logo', type: 'image', src: 'assets/logo.png', license: { name: 'CC0-1.0', attribution: 'Synthetic test image generated by OpenVideo' } },
  { id: 'clip', type: 'video', src: 'assets/clip.mp4', license: { name: 'CC0-1.0', attribution: 'Synthetic test pattern generated with FFmpeg lavfi' } },
  { id: 'walk-sheet', type: 'image', src: 'assets/walk-sheet.png', license: { name: 'CC0-1.0', attribution: 'Synthetic sprite sheet generated by OpenVideo' } },
  { id: 'spinner', type: 'lottie', src: 'assets/spinner.json', license: { name: 'CC0-1.0', attribution: 'Minimal Lottie written by OpenVideo' } },
  { id: 'robot', type: 'model', src: 'assets/robot.glb', license: { name: 'CC0-1.0', attribution: 'Placeholder path; supply your own glTF' } },
];

/**
 * Untertitel-Track für das Beispiel `subtitles` (mit Wortzeiten für Karaoke), jedes Mal neu erzeugt.
 *
 * @example
 * ```ts
 * exampleSubtitleTrack().id; // 'captions'
 * ```
 */
export function exampleSubtitleTrack(): SubtitleTrack {
  return {
    id: 'captions',
    kind: 'subtitle',
    cues: [
      {
        start: 0,
        end: '2s',
        text: 'Hello from OpenVideo',
        words: [
          { text: 'Hello', start: 0, end: '0.6s' },
          { text: 'from', start: '0.6s', end: '1.1s' },
          { text: 'OpenVideo', start: '1.1s', end: '2s' },
        ],
      },
    ],
  };
}

/**
 * Verschachtelte Composition `intro` für das Beispiel `composition-ref`, jedes Mal neu erzeugt.
 *
 * @example
 * ```ts
 * exampleIntroComposition().id; // 'intro'
 * ```
 */
export function exampleIntroComposition(): IrComposition {
  return {
    id: 'intro',
    width: 640,
    height: 360,
    fps: 30,
    duration: '2s',
    background: '#1B2A4A',
    nodes: [{ id: 'intro-title', type: 'text', text: 'Intro', x: 40, y: 140, width: 560, textAlign: 'center', fontSize: 64, fontWeight: 800, fill: '#FFFFFF' }],
  };
}

/** Node-Typen, deren Beispiel ein Browser (Chromium/Three.js) oder Blender rendert statt Skia. */
export const EXAMPLE_TYPES_NOT_2D: readonly BuiltinNodeType[] = ['html', 'scene3d', 'blender', ...NODE_TYPES_3D];

/** Sammelt alle String-Werte unter `key` in einem JSON-Baum. */
function valuesOf(value: unknown, key: string, out: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) valuesOf(v, key, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && typeof v === 'string') out.add(v);
      else valuesOf(v, key, out);
    }
  }
  return out;
}

function isBuiltinType(type: string): type is BuiltinNodeType {
  return Object.hasOwn(NODE_SCHEMAS, type);
}

/**
 * Bettet das Beispiel eines Node-Typs in ein vollständiges, gültiges Projekt ein: Composition `main`
 * (640 × 360, 30 fps, 2 s) mit genau dieser Node. 3D-Nodes stehen in einer `scene3d` mit Kamera;
 * Assets, der Untertitel-Track und die Composition `intro` kommen nur mit, wenn das Beispiel sie nutzt.
 *
 * @example
 * ```ts
 * const project = exampleProject('image');
 * project.assets; // [{ id: 'logo', type: 'image', src: 'assets/logo.png', … }]
 * validateProject(project).ok; // true
 * ```
 */
export function exampleProject(type: BuiltinNodeType): IrProject {
  const example: IrNode = createExamples()[type];
  const nodes: IrNode[] = [];
  if (NODE_TYPES_3D.includes(type)) {
    const children: IrNode[] = type === 'camera3d' ? [example] : [camera(), ...(type === 'light3d' ? [] : [keyLight()]), example];
    nodes.push({ id: 'example-scene', type: 'scene3d', width: 640, height: 360, camera: 'cam', background: '#0B0D12', children });
  } else nodes.push(example);
  const used = valuesOf(nodes, 'asset', new Set());
  const tracks = valuesOf(nodes, 'track', new Set());
  const track = exampleSubtitleTrack();
  const intro = exampleIntroComposition();
  const refs = valuesOf(nodes, 'composition', new Set());
  const main: IrComposition = {
    id: 'main',
    width: 640,
    height: 360,
    fps: 30,
    duration: '2s',
    background: '#0B0D12',
    ...(tracks.has(track.id) ? { tracks: [track] } : {}),
    nodes,
  };
  const assets = EXAMPLE_ASSETS.filter((a) => used.has(a.id)).map((a) => ({ ...a, ...(a.license !== undefined ? { license: { ...a.license } } : {}) }));
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: { title: `Example: ${type}` },
    compositions: [main, ...(refs.has(intro.id) ? [intro] : [])],
    ...(assets.length > 0 ? { assets } : {}),
  };
}

// ---------------------------------------------------------------------------
// Property-Typen für Manifest und Doku
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Klammert zusammengesetzte Typen, bevor `[]` angehängt wird. */
function wrap(text: string): string {
  return text.includes(' ') ? `(${text})` : text;
}

/**
 * Kurze, lesbare Typangabe eines Property-Schemas, z. B. `number (0..1, animatable)`, `color`,
 * `time`, `{ x, y } (animatable)`, `"butt" | "round" | "square"` oder `node[]`.
 * Objekte nennen nur ihre Felder (optionale mit `?`); Details liefert `schema.get`.
 *
 * @example
 * ```ts
 * describePropertyType(NODE_SCHEMAS.rect.properties.opacity); // 'number (0..1, animatable)'
 * ```
 */
export function describePropertyType(schema: unknown): string {
  if (!isObject(schema)) return 'unknown';
  if (schema[NODE_MARK] === true) return 'node';
  if (schema[NODE_ARRAY_MARK] === true) return 'node[]';
  const anyOf = Array.isArray(schema['anyOf']) ? schema['anyOf'] : undefined;
  if (schema[ANIMATABLE_MARK] === true && anyOf !== undefined) {
    const base = describePropertyType(anyOf[0]);
    if (base.includes(' | ')) return `(${base}) (animatable)`;
    return base.endsWith(')') ? `${base.slice(0, -1)}, animatable)` : `${base} (animatable)`;
  }
  if ('const' in schema) return JSON.stringify(schema['const']);
  if (Array.isArray(schema['enum'])) return schema['enum'].map((v) => JSON.stringify(v)).join(' | ');
  if (anyOf !== undefined) {
    const parts = [...new Set(anyOf.map(describePropertyType))];
    if (parts.includes('time')) return 'time';
    return parts.join(' | ');
  }
  const type = schema['type'];
  if (type === 'string') {
    const pattern = schema['pattern'];
    if (pattern === COLOR_PATTERN) return 'color';
    if (pattern === ID_PATTERN) return 'id';
    if (pattern === EASING_PATTERN) return 'easing';
    if (pattern === TIME_STRING_PATTERN) return 'time';
    return 'string';
  }
  if (type === 'number' || type === 'integer') {
    const min = typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined;
    const max = typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined;
    const exMin = typeof schema['exclusiveMinimum'] === 'number' ? schema['exclusiveMinimum'] : undefined;
    const range = min !== undefined && max !== undefined ? `${String(min)}..${String(max)}` : min !== undefined ? `>= ${String(min)}` : exMin !== undefined ? `> ${String(exMin)}` : max !== undefined ? `<= ${String(max)}` : undefined;
    return range !== undefined ? `${type} (${range})` : type;
  }
  if (type === 'array') {
    const items = schema['items'];
    if (Array.isArray(items)) return `[${items.map(describePropertyType).join(', ')}]`;
    return `${wrap(describePropertyType(items))}[]`;
  }
  if (type === 'object') {
    const pattern = schema['patternProperties'];
    if (isObject(pattern)) {
      const inner = Object.values(pattern)[0];
      return `Record<string, ${describePropertyType(inner)}>`;
    }
    const props = isObject(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    const keys = Object.keys(props).map((k) => {
      const p = props[k];
      if (k === 'type' && isObject(p) && 'const' in p) return `type: ${JSON.stringify(p['const'])}`;
      return required.includes(k) ? k : `${k}?`;
    });
    return keys.length === 0 ? 'object' : `{ ${keys.join(', ')} }`;
  }
  if (type === 'boolean' || type === 'null') return type;
  return 'unknown';
}

/** Felder, die jede Node hat und die Manifest und Doku weglassen. */
const COMMON_FIELDS = new Set(['id', 'type', 'name', 'comment', 'meta']);

/** Kurzbeschreibung eines Node-Typs für Manifest und Doku. */
export interface NodeTypeSummary {
  readonly description: string;
  /** Property-Namen ohne die gemeinsamen Felder `id`, `type`, `name`, `comment`, `meta`. */
  readonly properties: string[];
  /** Kurze Typangabe je Property (siehe {@link describePropertyType}). */
  readonly propertyTypes: Record<string, string>;
  /** Pflichtfelder außer `id` und `type`. */
  readonly required: string[];
  /** Gültiges JSON-Beispiel (eingebaute Typen: {@link NODE_EXAMPLES}; Plugins: erstes `examples` ihres Schemas). */
  readonly example?: unknown;
}

/**
 * Fasst ein Node-Schema zusammen: Beschreibung, Properties mit Typ, Pflichtfelder und Beispiel.
 * Dieselbe Funktion speist `capabilities.get` und `scripts/generate-docs.mjs`.
 *
 * @example
 * ```ts
 * const rect = summarizeNodeType('rect', NODE_SCHEMAS.rect);
 * rect.required; // ['width', 'height']
 * rect.example;  // NODE_EXAMPLES.rect
 * ```
 */
export function summarizeNodeType(type: string, schema: unknown): NodeTypeSummary {
  const s = isObject(schema) ? schema : {};
  const props = isObject(s['properties']) ? s['properties'] : {};
  const names = Object.keys(props).filter((k) => !COMMON_FIELDS.has(k));
  const required = Array.isArray(s['required']) ? s['required'].filter((r): r is string => typeof r === 'string' && r !== 'id' && r !== 'type') : [];
  const builtin: unknown = isBuiltinType(type) ? createExamples()[type] : undefined;
  const examples = s['examples'];
  const example: unknown = builtin ?? (Array.isArray(examples) ? examples[0] : undefined);
  return {
    description: typeof s['description'] === 'string' ? s['description'] : '',
    properties: names,
    propertyTypes: Object.fromEntries(names.map((k) => [k, describePropertyType(props[k])])),
    required,
    ...(example !== undefined ? { example } : {}),
  };
}

/**
 * Kurzbeschreibungen aller eingebauten Node-Typen in Registerreihenfolge.
 *
 * @example
 * ```ts
 * Object.keys(builtinNodeTypeSummaries()).length; // 31
 * ```
 */
export function builtinNodeTypeSummaries(): Record<string, NodeTypeSummary> {
  return Object.fromEntries(Object.entries(NODE_SCHEMAS).map(([type, schema]) => [type, summarizeNodeType(type, schema)]));
}
