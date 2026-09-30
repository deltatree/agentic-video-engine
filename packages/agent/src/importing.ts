/**
 * Operation `project.import` (Story 19.5): SVG, Lottie, glTF, HTML, Anime.js-Timelines und
 * Motion-Canvas-Szenen in ein bestehendes Projekt übernehmen. Jeder Informationsverlust
 * erscheint als Diagnose `OV_IMPORT_LOSSY` (Warnung) im Ergebnis.
 *
 * Anime.js und Motion Canvas sind Code-Bibliotheken. Die Operation nimmt darum eine
 * deklarative JSON-Form an und führt sie mit `@agentic-video/anime` bzw.
 * `@agentic-video/motion-canvas-adapter` aus – ohne fremden Code auszuführen.
 */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative } from 'node:path';
import Type from 'typebox';
import { createTimeline, type AnimationParams, type TimelineOptions } from '@agentic-video/anime';
import { OpenVideoError, applyPatches, contentHash, findComposition, isRecord, type Diagnostic, type Patch } from '@agentic-video/core';
import { importGltf, importHtml, importLottie, importSvg, type ImportedAsset, type JsonNode } from '@agentic-video/importers';
import * as mc from '@agentic-video/motion-canvas-adapter';
import { checkProject } from '@agentic-video/render';
import { defineOperation } from './operation.js';
import { AnyObject, CompositionId, Diagnostics, ProjectId, loadProject, plainDiagnostics, tsxProjectError, validateOptionsOf, withEnv } from './shared.js';
import { isSourceEntry, safeJoin, safeRealPath } from './workspace.js';

/** Unterstützte Importformate. */
export const IMPORT_FORMATS = ['svg', 'lottie', 'gltf', 'html', 'anime', 'motion-canvas'] as const;
/** Ein Importformat. */
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

function importError(code: string, problem: string, suggestions: readonly string[]): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'ImportError', problem, suggestions });
}

/**
 * Erkennt das Format an der Dateiendung.
 *
 * @example
 * ```ts
 * formatFromPath('assets/logo.svg'); // 'svg'
 * ```
 */
export function formatFromPath(path: string): ImportFormat | undefined {
  switch (extname(path).toLowerCase()) {
    case '.svg':
      return 'svg';
    case '.gltf':
    case '.glb':
      return 'gltf';
    case '.html':
    case '.htm':
      return 'html';
    case '.json':
    case '.lottie':
      return 'lottie';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Anime.js (deklarativ)
// ---------------------------------------------------------------------------

/**
 * Baut eine Anime.js-Timeline aus JSON: `{ defaults?, entries: [{ targets, params, position? } | { label, position? }] }`.
 * Funktionswerte und Callbacks gibt es in JSON nicht; alles andere entspricht `createTimeline().add()`.
 */
function animeTimeline(content: unknown, prefix: string | undefined) {
  if (!isRecord(content) || !Array.isArray(content['entries'])) {
    throw importError('OV_IMPORT_INPUT', 'An anime import needs { "entries": [ { "targets": "headline", "params": { … }, "position": … } ] }.', [
      '{ "defaults": { "duration": 600, "ease": "outCubic" }, "entries": [ { "targets": "headline", "params": { "opacity": [0, 1], "y": [40, 0] } } ] }',
    ]);
  }
  const options: TimelineOptions = isRecord(content['defaults']) ? { defaults: pickDefaults(content['defaults']) } : {};
  const loop = content['loop'];
  const alternate = content['alternate'];
  const timeline = createTimeline({ ...options, ...(typeof loop === 'number' || typeof loop === 'boolean' ? { loop } : {}), ...(typeof alternate === 'boolean' ? { alternate } : {}) });
  content['entries'].forEach((entry, i) => {
    if (!isRecord(entry)) throw importError('OV_IMPORT_INPUT', `entries[${String(i)}] is not an object.`, ['{ "targets": "headline", "params": { "opacity": [0, 1] } }']);
    const position = typeof entry['position'] === 'number' || typeof entry['position'] === 'string' ? entry['position'] : undefined;
    if (typeof entry['label'] === 'string') {
      timeline.label(entry['label'], position);
      return;
    }
    const targets = entry['targets'];
    const list = typeof targets === 'string' ? targets : Array.isArray(targets) && targets.every((t) => typeof t === 'string') ? targets.filter((t): t is string => typeof t === 'string') : undefined;
    if (list === undefined || !isRecord(entry['params'])) {
      throw importError('OV_IMPORT_INPUT', `entries[${String(i)}] needs "targets" (node id or list) and "params" (object).`, ['{ "targets": ["a", "b"], "params": { "x": 100, "duration": 500 } }']);
    }
    const params: AnimationParams = { ...entry['params'] };
    timeline.add(typeof list === 'string' ? prefixTarget(list, prefix) : list.map((t) => prefixTarget(t, prefix)), params, position);
  });
  return timeline;
}

/**
 * Ziel-ID einer Anime-Animation mit `idPrefix` (Review m4): `title` → `logo-title`, sofern das Ziel
 * nicht schon mit dem Präfix beginnt. So passt eine Timeline zu Nodes eines früheren Imports mit gleichem Präfix.
 */
function prefixTarget(target: string, prefix: string | undefined): string {
  if (prefix === undefined || target === prefix || target.startsWith(`${prefix}-`)) return target;
  return `${prefix}-${target}`;
}

/** Setzt `idPrefix` vor die IDs importierter Nodes (auch Kinder und Masken) und ihre Asset-Verweise. */
function prefixNodes(nodes: readonly JsonNode[], prefix: string, assets: ReadonlyMap<string, string>): JsonNode[] {
  const visit = (node: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...node };
    if (typeof node['id'] === 'string') out['id'] = prefixTarget(node['id'], prefix);
    const asset = node['asset'];
    if (typeof asset === 'string') out['asset'] = assets.get(asset) ?? asset;
    if (Array.isArray(node['children'])) out['children'] = node['children'].filter(isRecord).map(visit);
    const mask = node['mask'];
    if (isRecord(mask) && isRecord(mask['node'])) out['mask'] = { ...mask, node: visit(mask['node']) };
    return out;
  };
  return nodes.map(visit);
}

function pickDefaults(d: Readonly<Record<string, unknown>>): NonNullable<TimelineOptions['defaults']> {
  return {
    ...(typeof d['duration'] === 'number' ? { duration: d['duration'] } : {}),
    ...(typeof d['delay'] === 'number' ? { delay: d['delay'] } : {}),
    ...(typeof d['ease'] === 'string' ? { ease: d['ease'] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Motion Canvas (deklarativ)
// ---------------------------------------------------------------------------

const EASE_NAMES = [
  'linear',
  'easeInSine',
  'easeOutSine',
  'easeInOutSine',
  'easeInQuad',
  'easeOutQuad',
  'easeInOutQuad',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeInQuart',
  'easeOutQuart',
  'easeInOutQuart',
  'easeInQuint',
  'easeOutQuint',
  'easeInOutQuint',
  'easeInExpo',
  'easeOutExpo',
  'easeInOutExpo',
  'easeInCirc',
  'easeOutCirc',
  'easeInOutCirc',
  'easeInBack',
  'easeOutBack',
  'easeInOutBack',
  'easeInElastic',
  'easeOutElastic',
  'easeInOutElastic',
  'easeInBounce',
  'easeOutBounce',
  'easeInOutBounce',
] as const;
const EASES: ReadonlyMap<string, mc.TimingFunction> = new Map(EASE_NAMES.map((n) => [n, mc[n]]));

/** Größte Verschachtelungstiefe von Schritten (Schutz vor sehr tiefen Eingaben). */
const MAX_STEP_DEPTH = 32;

interface McContext {
  readonly nodes: Map<string, mc.Node>;
  readonly diagnostics: Diagnostic[];
}

function mcLossy(path: string, problem: string, suggestion: string): Diagnostic {
  return { code: 'OV_IMPORT_LOSSY', severity: 'warning', errorClass: 'MotionCanvasAdapterError', problem, path, suggestions: [suggestion] };
}

function makeMcNode(spec: unknown, path: string, ctx: McContext): mc.Node {
  if (!isRecord(spec) || typeof spec['type'] !== 'string') throw importError('OV_IMPORT_INPUT', `${path} needs "type" (Rect, Circle, Txt, Line, Img or Node).`, ['{ "type": "Rect", "key": "box", "props": { "width": 200, "height": 100, "fill": "#e13238" } }']);
  const props: Record<string, unknown> = isRecord(spec['props']) ? { ...spec['props'] } : {};
  const key = typeof spec['key'] === 'string' ? spec['key'] : undefined;
  const withKey = key !== undefined ? { ...props, key } : props;
  let node: mc.Node;
  switch (spec['type']) {
    case 'Rect':
      node = new mc.Rect(withKey);
      break;
    case 'Circle':
      node = new mc.Circle(withKey);
      break;
    case 'Txt':
      node = new mc.Txt(withKey);
      break;
    case 'Line':
      node = new mc.Line(withKey);
      break;
    case 'Img':
      node = new mc.Img(withKey);
      break;
    case 'Node':
      node = new mc.Node(withKey);
      break;
    default:
      throw importError('OV_IMPORT_INPUT', `${path}.type "${spec['type']}" is not supported.`, ['Use Rect, Circle, Txt, Line, Img or Node.']);
  }
  if (key !== undefined) ctx.nodes.set(key, node);
  const children = spec['children'];
  if (Array.isArray(children)) children.forEach((c, i) => node.add(makeMcNode(c, `${path}.children[${String(i)}]`, ctx)));
  return node;
}

function vectorOf(value: unknown): mc.PossibleVector2 | undefined {
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return [value[0], value[1]];
  if (isRecord(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number') return { x: value['x'], y: value['y'] };
  return undefined;
}

type Tween = (duration: number, timing: mc.TimingFunction | undefined) => mc.ThreadGenerator;
type Setter = () => void;

/** Signal einer Property als Tween- und Setz-Funktion, oder `undefined`, wenn Wert oder Property nicht passen. */
function signalOf(node: mc.Node, prop: string, value: unknown): { tween: Tween; set: Setter } | undefined {
  const num = (sig: mc.Signal<number, number>) =>
    typeof value === 'number'
      ? {
          tween: (d: number, t: mc.TimingFunction | undefined) => sig(value, d, t),
          set: () => {
            sig(value);
          },
        }
      : undefined;
  const vec = (sig: mc.Signal<mc.PossibleVector2, mc.Vector2>) => {
    const v = vectorOf(value);
    return v === undefined
      ? undefined
      : {
          tween: (d: number, t: mc.TimingFunction | undefined) => sig(v, d, t),
          set: () => {
            sig(v);
          },
        };
  };
  const text = (sig: mc.Signal<string, string | undefined> | mc.Signal<string, string>) =>
    typeof value === 'string'
      ? {
          tween: (d: number, t: mc.TimingFunction | undefined) => sig(value, d, t),
          set: () => {
            sig(value);
          },
        }
      : undefined;
  switch (prop) {
    case 'x':
      return num(node.x);
    case 'y':
      return num(node.y);
    case 'rotation':
      return num(node.rotation);
    case 'opacity':
      return num(node.opacity);
    case 'scale':
      return vec(node.scale);
    case 'position':
      return vec(node.position);
    default:
      break;
  }
  if (node instanceof mc.Shape) {
    if (prop === 'fill') return text(node.fill);
    if (prop === 'stroke') return text(node.stroke);
    if (prop === 'lineWidth') return num(node.lineWidth);
  }
  if (node instanceof mc.SizedShape) {
    if (prop === 'width') return num(node.width);
    if (prop === 'height') return num(node.height);
    if (prop === 'size') return vec(node.size);
  }
  if (node instanceof mc.Rect && prop === 'radius') return num(node.radius);
  if (node instanceof mc.Txt) {
    if (prop === 'text') return text(node.text);
    if (prop === 'fontSize') return num(node.fontSize);
    if (prop === 'fontWeight') return num(node.fontWeight);
  }
  if (node instanceof mc.Line) {
    if (prop === 'start') return num(node.start);
    if (prop === 'end') return num(node.end);
  }
  return undefined;
}

function* nothing(): mc.ThreadGenerator {
  // Leerer Task ohne Dauer: ersetzt einen verworfenen Schritt.
  yield* mc.waitFor(0);
}

function* setTask(set: Setter): mc.ThreadGenerator {
  set();
  yield* mc.waitFor(0);
}

/** Übersetzt einen JSON-Schritt in einen Motion-Canvas-Task. */
function stepTask(step: unknown, path: string, ctx: McContext, depth: number): mc.ThreadGenerator {
  if (depth > MAX_STEP_DEPTH) throw importError('OV_IMPORT_INPUT', `${path} is nested deeper than ${String(MAX_STEP_DEPTH)} levels.`, ['Flatten the timeline with "chain" and "all".']);
  if (!isRecord(step)) throw importError('OV_IMPORT_INPUT', `${path} is not a step object.`, ['{ "tween": { "node": "box", "property": "x", "to": 300, "duration": 1 } }']);
  const list = (key: string): mc.ThreadGenerator[] => {
    const v = step[key];
    if (!Array.isArray(v)) throw importError('OV_IMPORT_INPUT', `${path}.${key} must be an array of steps.`, [`{ "${key}": [ { "waitFor": 0.5 } ] }`]);
    return v.map((s, i) => stepTask(s, `${path}.${key}[${String(i)}]`, ctx, depth + 1));
  };
  if ('all' in step) return mc.all(...list('all'));
  if ('any' in step) return mc.any(...list('any'));
  if ('chain' in step) return mc.chain(...list('chain'));
  if (typeof step['waitFor'] === 'number') return mc.waitFor(step['waitFor']);
  if (typeof step['waitUntil'] === 'string') return mc.waitUntil(step['waitUntil']);
  const tween = isRecord(step['tween']) ? step['tween'] : isRecord(step['set']) ? step['set'] : undefined;
  if (tween === undefined) {
    throw importError('OV_IMPORT_INPUT', `${path} has no known step (tween, set, all, any, chain, waitFor, waitUntil).`, ['{ "tween": { "node": "box", "property": "x", "to": 300, "duration": 1, "ease": "easeInOutCubic" } }']);
  }
  const key = tween['node'];
  const prop = tween['property'];
  const node = typeof key === 'string' ? ctx.nodes.get(key) : undefined;
  if (node === undefined || typeof prop !== 'string') {
    const known = [...ctx.nodes.keys()];
    throw importError('OV_IMPORT_INPUT', `${path} refers to the unknown node ${JSON.stringify(key)}.`, [`Give the node a "key" and use it here. Known keys: ${known.join(', ') || '(none)'}.`]);
  }
  const signal = signalOf(node, prop, tween['to']);
  if (signal === undefined) {
    ctx.diagnostics.push(mcLossy(`${path}.property`, `Property "${prop}" with value ${JSON.stringify(tween['to'])} cannot be animated on ${node.kind}; the step was skipped.`, 'Use x, y, position, rotation, scale, opacity, fill, stroke, lineWidth, width, height, size, radius, text, fontSize, fontWeight, start or end.'));
    return nothing();
  }
  if ('set' in step) return setTask(signal.set);
  const duration = typeof tween['duration'] === 'number' ? tween['duration'] : 1;
  const easeName = tween['ease'];
  const timing = typeof easeName === 'string' ? EASES.get(easeName) : undefined;
  if (typeof easeName === 'string' && timing === undefined) {
    ctx.diagnostics.push(mcLossy(`${path}.ease`, `Easing "${easeName}" is unknown; easeInOutCubic is used.`, `Use one of: ${EASE_NAMES.join(', ')}.`));
  }
  return signal.tween(duration, timing);
}

/**
 * Baut Motion-Canvas-Szenen aus JSON:
 * `{ scenes: [{ name, nodes: [{ type, key, props, children }], timeline: [steps] }], events? }`.
 */
function motionCanvasProject(content: unknown, size: { width: number; height: number; fps: number }): { project: Record<string, unknown>; diagnostics: Diagnostic[] } {
  if (!isRecord(content) || !Array.isArray(content['scenes'])) {
    throw importError('OV_IMPORT_INPUT', 'A motion-canvas import needs { "scenes": [ { "name", "nodes", "timeline" } ] }.', [
      '{ "scenes": [ { "name": "intro", "nodes": [ { "type": "Rect", "key": "box", "props": { "size": 120, "fill": "#e13238" } } ], "timeline": [ { "tween": { "node": "box", "property": "x", "to": 300, "duration": 1 } } ] } ] }',
    ]);
  }
  const diagnostics: Diagnostic[] = [];
  const scenes = content['scenes'].map((raw, i) => {
    const path = `scenes[${String(i)}]`;
    if (!isRecord(raw)) throw importError('OV_IMPORT_INPUT', `${path} is not an object.`, ['{ "name": "intro", "nodes": [], "timeline": [] }']);
    const name = typeof raw['name'] === 'string' ? raw['name'] : `scene-${String(i + 1)}`;
    const nodeSpecs = Array.isArray(raw['nodes']) ? raw['nodes'] : [];
    const steps = Array.isArray(raw['timeline']) ? raw['timeline'] : [];
    return mc.makeScene(name, function* (view) {
      const ctx: McContext = { nodes: new Map(), diagnostics };
      nodeSpecs.forEach((spec, n) => view.add(makeMcNode(spec, `${path}.nodes[${String(n)}]`, ctx)));
      for (const [s, step] of steps.entries()) yield* stepTask(step, `${path}.timeline[${String(s)}]`, ctx, 0);
    });
  });
  const events: Record<string, number> = {};
  if (isRecord(content['events'])) for (const [k, v] of Object.entries(content['events'])) if (typeof v === 'number') events[k] = v;
  const r = mc.toProject(scenes, { ...size, events });
  return { project: r.project, diagnostics: [...diagnostics, ...r.diagnostics] };
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

const ImportInput = Type.Object(
  {
    projectId: ProjectId,
    format: Type.Optional(Type.Union([Type.Literal('svg'), Type.Literal('lottie'), Type.Literal('gltf'), Type.Literal('html'), Type.Literal('anime'), Type.Literal('motion-canvas')], { description: `One of ${IMPORT_FORMATS.join(', ')}; default from the file extension of "path".` })),
    path: Type.Optional(Type.String({ description: 'File inside the project directory, e.g. "assets/logo.svg".' })),
    content: Type.Optional(Type.Unknown({ description: 'Inline source: SVG/HTML text, Lottie/glTF JSON, or the JSON form of an anime timeline / motion-canvas scenes.' })),
    base64: Type.Optional(Type.String({ description: 'Binary source (e.g. .glb) as base64.' })),
    css: Type.Optional(Type.String({ description: 'Extra CSS for html imports.' })),
    compositionId: CompositionId,
    parentId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Parent node for the imported nodes; null/absent = top level.' })),
    idPrefix: Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,40}$', description: 'Prefix of the new node and asset ids; for anime, the prefix of the target node ids (e.g. the idPrefix of an earlier SVG import).' })),
    lottieMode: Type.Optional(Type.Union([Type.Literal('native'), Type.Literal('embed')], { description: 'native: convert to IR shapes (may be lossy); embed: one lottie node (lossless). Default native.' })),
    dryRun: Type.Optional(Type.Boolean({ description: 'Return the result and diagnostics without saving.' })),
  },
  { additionalProperties: false },
);

async function sourceText(dir: string, input: { path?: string | undefined; content?: unknown; base64?: string | undefined }): Promise<{ text?: string; bytes?: Uint8Array; json?: unknown }> {
  if (input.path !== undefined) {
    const bytes = new Uint8Array(await readFile(await safeRealPath(dir, input.path)));
    return { bytes, text: new TextDecoder().decode(bytes) };
  }
  if (input.base64 !== undefined) return { bytes: new Uint8Array(Buffer.from(input.base64, 'base64')) };
  if (typeof input.content === 'string') return { text: input.content };
  if (input.content !== undefined) return { json: input.content };
  throw importError('OV_IMPORT_INPUT', 'project.import needs "path", "content" or "base64".', ['{ "projectId": "demo", "path": "assets/logo.svg" }', '{ "projectId": "demo", "format": "svg", "content": "<svg …>…</svg>" }']);
}

function parseJsonText(text: string, what: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw importError('OV_IMPORT_INPUT', `The ${what} source is not valid JSON.`, ['Pass the JSON object as "content", or a .json file as "path".']);
    throw error;
  }
}

/** Führt den Import aus und liefert Patches, neue Dateien und Diagnosen. */
async function runImport(format: ImportFormat, dir: string, input: Readonly<Record<string, unknown>> & { path?: string | undefined; content?: unknown; base64?: string | undefined; css?: string | undefined; idPrefix?: string | undefined; lottieMode?: 'native' | 'embed' | undefined; parentId?: string | null | undefined; compositionId?: string | undefined }, project: Readonly<Record<string, unknown>>) {
  const src = await sourceText(dir, input);
  const comp = findComposition(project, input.compositionId);
  const compositionId = String(comp['id']);
  const size = { width: Number(comp['width']), height: Number(comp['height']), fps: Number(comp['fps']) };
  const prefix = input.idPrefix;
  let nodes: JsonNode[] = [];
  let assets: ImportedAsset[] = [];
  const diagnostics: Diagnostic[] = [];
  const patches: Patch[] = [];
  /** Deklarierte (nicht kopierte) Assets, z. B. Bilder aus Motion-Canvas-Img-Knoten. */
  const declared: string[] = [];
  const textOf = (what: string): string => {
    if (src.text !== undefined) return src.text;
    throw importError('OV_IMPORT_INPUT', `The ${what} import needs text (content as string or a file path).`, ['Pass "content": "<…>" or "path".']);
  };
  const jsonOf = (what: string): unknown => (src.json !== undefined ? src.json : parseJsonText(textOf(what), what));
  switch (format) {
    case 'svg': {
      const r = importSvg(textOf('svg'), prefix !== undefined ? { idPrefix: prefix } : {});
      ({ nodes, assets } = r);
      diagnostics.push(...r.diagnostics);
      break;
    }
    case 'html': {
      const r = importHtml(textOf('html'), input.css, { ...(prefix !== undefined ? { id: prefix } : {}), width: size.width, height: size.height });
      ({ nodes, assets } = r);
      diagnostics.push(...r.diagnostics);
      break;
    }
    case 'lottie': {
      const data = jsonOf('lottie');
      if (!isRecord(data)) throw importError('OV_IMPORT_INPUT', 'The Lottie source is not a JSON object.', ['Pass the Lottie JSON (with "layers") as "content" or "path".']);
      const r = importLottie(data, { mode: input.lottieMode ?? 'native', ...(prefix !== undefined ? { idPrefix: prefix } : {}) });
      ({ nodes, assets } = r);
      diagnostics.push(...r.diagnostics);
      break;
    }
    case 'gltf': {
      const data = src.bytes ?? (src.json !== undefined && isRecord(src.json) ? src.json : textOf('gltf'));
      const r = importGltf(data, { assetId: prefix ?? 'model', width: size.width, height: size.height });
      ({ nodes, assets } = r);
      diagnostics.push(...r.diagnostics);
      break;
    }
    case 'anime': {
      const timeline = animeTimeline(jsonOf('anime'), prefix);
      const compiled = timeline.compile(project);
      patches.push(...compiled.patches);
      diagnostics.push(...compiled.diagnostics);
      break;
    }
    case 'motion-canvas': {
      const r = motionCanvasProject(jsonOf('motion-canvas'), size);
      diagnostics.push(...r.diagnostics);
      const first = Array.isArray(r.project['compositions']) ? r.project['compositions'].find(isRecord) : undefined;
      const mcAssets = Array.isArray(r.project['assets']) ? r.project['assets'].filter(isRecord) : [];
      const renamed = new Map(mcAssets.map((a) => [String(a['id']), prefix !== undefined ? prefixTarget(String(a['id']), prefix) : String(a['id'])]));
      const mcNodes = first !== undefined && Array.isArray(first['nodes']) ? first['nodes'].filter(isRecord) : [];
      nodes = prefix !== undefined ? prefixNodes(mcNodes, prefix, renamed) : mcNodes;
      const markers: unknown[] = first !== undefined && Array.isArray(first['markers']) ? Array.from<unknown>(first['markers']) : [];
      if (markers.length > 0) {
        const existing: unknown[] = Array.isArray(comp['markers']) ? Array.from<unknown>(comp['markers']) : [];
        patches.push({ op: 'setCompositionProperty', compositionId, property: 'markers', value: [...existing, ...markers] });
      }
      // Bilder aus Img-Knoten sind Pfade im Projekt; sie werden deklariert, nicht kopiert.
      for (const a of mcAssets) {
        const id = renamed.get(String(a['id'])) ?? String(a['id']);
        declared.push(id);
        patches.push({ op: 'addAsset', asset: { ...a, id } });
      }
      break;
    }
  }
  for (const a of assets) patches.push({ op: 'addAsset', asset: { ...a.asset } });
  const parentId = input.parentId ?? null;
  for (const node of nodes) patches.push({ op: 'addNode', parentId, node, compositionId });
  return { patches, files: assets.map((a) => ({ src: a.asset.src, bytes: a.bytes })), nodeIds: nodes.map((n) => String(n['id'])), assetIds: [...assets.map((a) => a.asset.id), ...declared], diagnostics };
}

/**
 * `project.import`: übernimmt SVG, Lottie, glTF, HTML, Anime.js-Timelines oder Motion-Canvas-Szenen.
 *
 * @example
 * ```ts
 * await invokeOperation(OPERATIONS, 'project.import', { projectId: 'demo', path: 'assets/logo.svg', idPrefix: 'logo' }, ctx);
 * ```
 */
export const projectImport = defineOperation({
  name: 'project.import',
  summary: 'Import SVG, Lottie, glTF, HTML, an anime.js timeline or Motion Canvas scenes into a project; lossy conversions are reported as OV_IMPORT_LOSSY warnings.',
  input: ImportInput,
  output: Type.Object({ ok: Type.Boolean(), nodes: Type.Array(Type.String()), assets: Type.Array(Type.String()), patches: Type.Integer(), inverse: Type.Array(AnyObject), diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', path: 'assets/logo.svg', idPrefix: 'logo' } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    if (isSourceEntry(loaded.entry)) throw tsxProjectError();
    const format = input.format ?? (input.path !== undefined ? formatFromPath(input.path) : undefined);
    if (format === undefined) throw importError('OV_IMPORT_FORMAT', 'The import format is unknown.', [`Pass "format": one of ${IMPORT_FORMATS.join(', ')}.`]);
    const r = await runImport(format, loaded.dir, input, loaded.project);
    return withEnv(ctx, loaded, async (env) => {
      const result = applyPatches(loaded.project, r.patches, { validateOptions: validateOptionsOf(env.registry) });
      const inverse = result.inverse.map((p) => ({ ...p }));
      const base = { nodes: r.nodeIds, assets: r.assetIds, patches: r.patches.length };
      if (!result.ok) return { ok: false, ...base, inverse: [], diagnostics: plainDiagnostics([...r.diagnostics, ...result.diagnostics]) };
      if (input.dryRun === true) return { ok: true, ...base, inverse, diagnostics: plainDiagnostics(r.diagnostics) };
      // Dateien erst nach erfolgreicher Prüfung schreiben; eine andere Datei gleichen Namens wird nie überschrieben,
      // und keinem vorhandenen Symlink wird gefolgt (Review m4).
      const pending: { file: string; bytes: Uint8Array; src: string }[] = [];
      for (const f of r.files) {
        const file = safeJoin(loaded.dir, f.src);
        const existing = await lstat(file).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) {
          throw importError('OV_IMPORT_FILE_EXISTS', `${f.src} already exists and is not a regular file; nothing was imported.`, ['Remove the link, or pass another "idPrefix" so the new assets get their own files.']);
        }
        if (existing !== undefined) {
          if (contentHash(new Uint8Array(await readFile(file))) !== contentHash(f.bytes)) {
            throw importError('OV_IMPORT_FILE_EXISTS', `The file ${f.src} already exists with other content; nothing was imported.`, ['Pass another "idPrefix" so the new assets get their own files.']);
          }
          continue;
        }
        pending.push({ file, bytes: f.bytes, src: f.src });
      }
      const root = await realpath(loaded.dir);
      for (const f of pending) {
        await mkdir(dirname(f.file), { recursive: true });
        // Auch ein Ordner auf dem Weg darf nicht per Symlink aus dem Projekt führen.
        const parent = relative(root, await realpath(dirname(f.file)));
        if (parent.startsWith('..') || isAbsolute(parent)) throw importError('OV_PATH_OUTSIDE', `${f.src} would be written outside the project directory.`, ['Remove symbolic links inside the assets folder.']);
        // `wx`: exklusiv anlegen, folgt keinem (auch keinem später entstandenen) Symlink.
        await writeFile(f.file, f.bytes, { flag: 'wx' });
      }
      await ctx.services.workspace.save(input.projectId, result.project);
      const checks = checkProject(env, result.project).filter((d) => d.severity !== 'info');
      return { ok: true, ...base, inverse, diagnostics: plainDiagnostics([...r.diagnostics, ...checks]) };
    });
  },
});
