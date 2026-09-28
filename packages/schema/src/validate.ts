/**
 * Validierung eines ganzen Projects: Schema plus semantische Regeln (FR-2, FR-4).
 */
import type { TObject } from 'typebox';
import type { Diagnostic } from './diagnostics.js';
import { NODE_SCHEMAS, NODE_TYPES_3D, NODE_TYPES_3D_CONTAINER } from './nodes.js';
import { Project } from './project.js';
import { SCHEMA_VERSION } from './version.js';
import { closest, exampleOf, formatValue, jsonTypeOf, validateValue, type SchemaIssue, type Segment } from './validator.js';

/** Optionen für {@link validateProject}. */
export interface ValidateOptions {
  /** Zusätzliche Node-Schemas aus Plugins, nach Node-Typ. */
  readonly extraNodeSchemas?: Readonly<Record<string, TObject>>;
  /** Bekannte Komponenten-Namen. Ohne Angabe wird `component` nicht geprüft. */
  readonly components?: readonly string[];
}

/** Ergebnis einer Validierung. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NODE_ARRAY_KEYS = new Set(['nodes', 'children']);

/** Wandelt IR-Segmente in einen lesbaren Pfad um: `composition.hero.nodes.logo.scale.x`. */
export function friendlyPath(root: unknown, segments: readonly Segment[]): string {
  let parts: string[] = [];
  let compositionPrefix: string[] = [];
  let current: unknown = root;
  let expect: 'composition' | 'node' | undefined;
  let previous: Segment | undefined;
  for (const seg of segments) {
    const next: unknown = Array.isArray(current) && typeof seg === 'number' ? current[seg] : isRecord(current) && typeof seg === 'string' ? current[seg] : undefined;
    const id = isRecord(next) && typeof next['id'] === 'string' ? next['id'] : undefined;
    if (typeof seg === 'number') {
      if (expect === 'composition' && id !== undefined) {
        compositionPrefix = ['composition', id];
        parts = [...compositionPrefix];
      } else if (expect === 'node' && id !== undefined) {
        parts = [...compositionPrefix, 'nodes', id];
      } else {
        parts.push(id ?? String(seg));
      }
      expect = undefined;
    } else if (seg === 'compositions' && previous === undefined) {
      expect = 'composition';
    } else if (NODE_ARRAY_KEYS.has(seg)) {
      expect = 'node';
    } else if (seg === 'node' && previous === 'mask' && id !== undefined) {
      parts = [...compositionPrefix, 'nodes', id];
    } else {
      parts.push(seg);
      expect = undefined;
    }
    previous = seg;
    current = next;
  }
  return parts.length === 0 ? 'project' : parts.join('.');
}

/** Wandelt Segmente in einen JSON Pointer um. */
export function toPointer(segments: readonly Segment[]): string {
  return segments.length === 0 ? '' : `/${segments.map((s) => String(s).replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/')}`;
}

function suggestionFor(issue: SchemaIssue): string | undefined {
  if (issue.suggestion !== undefined) return issue.suggestion;
  const frames = [{ schema: issue.schema, depth: issue.segments.length }, ...[...issue.ancestors].reverse()];
  for (const frame of frames) {
    const example = exampleOf(frame.schema);
    if (example === undefined) continue;
    const key = issue.segments[frame.depth - 1];
    if (typeof key === 'string') return `${key}: ${formatValue(example)}`;
    return formatValue(example);
  }
  return undefined;
}

function nodeIdAt(root: unknown, segments: readonly Segment[]): { nodeId?: string; compositionId?: string } {
  let current: unknown = root;
  let nodeId: string | undefined;
  let compositionId: string | undefined;
  let parentKey: Segment | undefined;
  for (const seg of segments) {
    current = Array.isArray(current) && typeof seg === 'number' ? current[seg] : isRecord(current) && typeof seg === 'string' ? current[seg] : undefined;
    if (isRecord(current) && typeof current['id'] === 'string') {
      if (parentKey === 'compositions') compositionId = current['id'];
      if (typeof current['type'] === 'string' && (parentKey !== undefined && (NODE_ARRAY_KEYS.has(String(parentKey)) || parentKey === 'node'))) nodeId = current['id'];
    }
    if (typeof seg === 'string') parentKey = seg;
  }
  return { ...(nodeId !== undefined ? { nodeId } : {}), ...(compositionId !== undefined ? { compositionId } : {}) };
}

function issueToDiagnostic(root: unknown, issue: SchemaIssue): Diagnostic {
  const suggestion = suggestionFor(issue);
  const where = nodeIdAt(root, issue.segments);
  return {
    code: issue.keyword === 'required' ? 'OV_SCHEMA_REQUIRED' : issue.keyword === 'additionalProperties' ? 'OV_SCHEMA_UNKNOWN_PROPERTY' : 'OV_SCHEMA_INVALID',
    severity: 'error',
    errorClass: 'ValidationError',
    problem: issue.message,
    path: friendlyPath(root, issue.segments),
    pointer: toPointer(issue.segments),
    ...where,
    expected: issue.keyword === 'required' ? `property "${String(issue.segments[issue.segments.length - 1])}"` : issue.keyword === 'additionalProperties' ? 'no unknown properties' : issue.expected,
    ...(issue.received !== undefined ? { received: JSON.stringify(issue.received) } : {}),
    suggestions: suggestion !== undefined ? [suggestion] : [],
  };
}

interface NodeRef {
  readonly node: Record<string, unknown>;
  readonly segments: readonly Segment[];
  readonly parentType: string | undefined;
}

/**
 * Validiert ein Project vollständig gegen Schema und semantische Regeln.
 *
 * @example
 * ```ts
 * const result = validateProject(JSON.parse(text));
 * if (!result.ok) for (const d of result.diagnostics) console.error(formatDiagnostic(d));
 * ```
 */
export function validateProject(project: unknown, options: ValidateOptions = {}): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const nodeSchemas: Readonly<Record<string, object>> = { ...NODE_SCHEMAS, ...(options.extraNodeSchemas ?? {}) };

  if (!isRecord(project)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'OV_SCHEMA_INVALID',
          severity: 'error',
          errorClass: 'ValidationError',
          problem: 'A project must be a JSON object.',
          path: 'project',
          expected: 'object',
          received: jsonTypeOf(project),
          suggestions: [`{ schemaVersion: "${SCHEMA_VERSION}", compositions: [] }`],
        },
      ],
    };
  }

  const version = project['schemaVersion'];
  if (typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    const major = Number(version.split('.')[0]);
    const current = Number(SCHEMA_VERSION.split('.')[0]);
    if (major !== current) {
      diagnostics.push({
        code: 'OV_SCHEMA_VERSION',
        severity: 'error',
        errorClass: 'ValidationError',
        problem: `Schema version ${version} is not compatible with ${SCHEMA_VERSION}.`,
        path: 'schemaVersion',
        expected: `${String(current)}.x.x`,
        received: JSON.stringify(version),
        suggestions: ['Run `openvideo migrate <file>` to upgrade the project.'],
      });
    }
  }

  const nodes: NodeRef[] = [];
  const visitNode = (value: unknown, segments: readonly Segment[], parentType: string | undefined): void => {
    if (!isRecord(value)) {
      diagnostics.push(issueToDiagnostic(project, { segments, keyword: 'type', message: 'Expected a node object.', expected: 'node object', received: value, schema: {}, ancestors: [] }));
      return;
    }
    const type = value['type'];
    if (typeof type !== 'string') {
      diagnostics.push(
        issueToDiagnostic(project, {
          segments: [...segments, 'type'],
          keyword: 'required',
          message: 'Missing node "type".',
          expected: 'node type',
          received: undefined,
          schema: {},
          ancestors: [],
          suggestion: 'type: "rect"',
        }),
      );
      return;
    }
    const schema = nodeSchemas[type];
    if (schema === undefined) {
      const hint = closest(type, Object.keys(nodeSchemas));
      diagnostics.push(
        issueToDiagnostic(project, {
          segments: [...segments, 'type'],
          keyword: 'enum',
          message: `Unknown node type "${type}".`,
          expected: 'a registered node type',
          received: type,
          schema: {},
          ancestors: [],
          suggestion: hint !== undefined ? `type: "${hint}"` : `Use one of: ${Object.keys(nodeSchemas).join(', ')}.`,
        }),
      );
      return;
    }
    nodes.push({ node: value, segments, parentType });
    const issues = validateValue(schema, value, (child, childSegments) => {
      visitNode(child, childSegments, type);
    }, segments);
    for (const issue of issues) diagnostics.push(issueToDiagnostic(project, issue));
  };

  const issues = validateValue(Project, project, (child, segments) => {
    visitNode(child, segments, undefined);
  });
  for (const issue of issues) diagnostics.push(issueToDiagnostic(project, issue));

  diagnostics.push(...semanticChecks(project, nodes, options));
  return { ok: diagnostics.every((d) => d.severity !== 'error'), diagnostics };
}

function semantic(project: unknown, segments: readonly Segment[], code: string, problem: string, suggestions: readonly string[], severity: 'error' | 'warning' = 'error'): Diagnostic {
  return {
    code,
    severity,
    errorClass: 'ValidationError',
    problem,
    path: friendlyPath(project, segments),
    pointer: toPointer(segments),
    ...nodeIdAt(project, segments),
    suggestions,
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const ASSET_TYPES_FOR_NODE: Readonly<Record<string, readonly string[]>> = {
  image: ['image'],
  video: ['video'],
  svg: ['svg'],
  sprite: ['image'],
  lottie: ['lottie'],
  model3d: ['model'],
};

function semanticChecks(project: Record<string, unknown>, nodes: readonly NodeRef[], options: ValidateOptions): Diagnostic[] {
  const out: Diagnostic[] = [];
  const compositions = records(project['compositions']);
  const assets = records(project['assets']);
  const audioSources = records(project['audio']);
  const assetTypes = new Map(assets.map((a) => [String(a['id']), String(a['type'])]));

  const checkUnique = (items: readonly Record<string, unknown>[], base: readonly Segment[], what: string): void => {
    const seen = new Map<string, number>();
    items.forEach((item, i) => {
      const id = item['id'];
      if (typeof id !== 'string') return;
      const first = seen.get(id);
      if (first !== undefined) {
        out.push(semantic(project, [...base, i, 'id'], 'OV_SCHEMA_DUPLICATE_ID', `Duplicate ${what} id "${id}" (first at ${friendlyPath(project, [...base, first])}).`, [`id: "${id}-2"`]));
      } else {
        seen.set(id, i);
      }
    });
  };
  checkUnique(compositions, ['compositions'], 'composition');
  checkUnique(assets, ['assets'], 'asset');
  checkUnique(audioSources, ['audio'], 'audio source');
  checkUnique(records(project['renderProfiles']), ['renderProfiles'], 'render profile');

  // Node-IDs sind je Composition eindeutig (FR-2).
  const compositionIds = new Set(compositions.map((c) => String(c['id'])));
  const byComposition = new Map<number, Map<string, readonly Segment[]>>();
  for (const ref of nodes) {
    const compIndex = ref.segments[1];
    if (typeof compIndex !== 'number') continue;
    const seen = byComposition.get(compIndex) ?? new Map<string, readonly Segment[]>();
    byComposition.set(compIndex, seen);
    const id = String(ref.node['id']);
    const first = seen.get(id);
    if (first !== undefined) {
      out.push(
        semantic(project, [...ref.segments, 'id'], 'OV_SCHEMA_DUPLICATE_ID', `Duplicate node id "${id}". Both ${toPointer(first)} and ${toPointer(ref.segments)} use it.`, [
          `id: "${id}-2"`,
        ]),
      );
    } else {
      seen.set(id, ref.segments);
    }
  }

  for (const ref of nodes) {
    const type = String(ref.node['type']);
    // Asset-Verweise
    const assetId = ref.node['asset'];
    const allowed = ASSET_TYPES_FOR_NODE[type];
    if (typeof assetId === 'string' && allowed !== undefined) {
      const assetType = assetTypes.get(assetId);
      if (assetType === undefined) {
        const hint = closest(assetId, [...assetTypes.keys()]);
        out.push(semantic(project, [...ref.segments, 'asset'], 'OV_ASSET_UNKNOWN', `Asset "${assetId}" is not declared in project.assets.`, [hint !== undefined ? `asset: "${hint}"` : `Add { id: "${assetId}", type: "${allowed[0] ?? 'image'}", src: "./assets/…" } to project.assets.`]));
      } else if (!allowed.includes(assetType)) {
        out.push(semantic(project, [...ref.segments, 'asset'], 'OV_ASSET_TYPE', `Asset "${assetId}" has type "${assetType}", but a ${type} node needs ${allowed.join(' or ')}.`, [`Use an asset of type ${allowed.join(' or ')}.`]));
      }
    }
    // 3D-Nodes nur in 3D-Containern und umgekehrt
    const is3d = NODE_TYPES_3D.some((t) => t === type);
    const parentIs3d = ref.parentType !== undefined && NODE_TYPES_3D_CONTAINER.some((t) => t === ref.parentType);
    if (is3d && !parentIs3d) {
      out.push(semantic(project, ref.segments, 'OV_SCHEMA_PLACEMENT', `A ${type} node must be inside a scene3d, blender or group3d node.`, ['Move the node into the children of a scene3d node.']));
    }
    if (!is3d && parentIs3d) {
      out.push(semantic(project, ref.segments, 'OV_SCHEMA_PLACEMENT', `A ${type} node cannot be inside a 3D scene.`, ['Place 2D nodes outside of scene3d, or use an html/layer node on top.']));
    }
    // Kamera-Verweis
    if ((type === 'scene3d' || type === 'blender') && typeof ref.node['camera'] === 'string') {
      const cameraId = ref.node['camera'];
      const found = collectDescendants(ref.node).some((n) => n['id'] === cameraId && n['type'] === 'camera3d');
      if (!found) out.push(semantic(project, [...ref.segments, 'camera'], 'OV_SCHEMA_CAMERA', `Camera "${cameraId}" is not a camera3d inside this scene.`, ['Add a camera3d child with this id, or remove `camera` to use the first camera.']));
    }
    // Verschachtelte Compositions
    if (type === 'composition-ref') {
      const target = String(ref.node['composition']);
      if (!compositionIds.has(target)) {
        out.push(semantic(project, [...ref.segments, 'composition'], 'OV_SCHEMA_COMPOSITION', `Composition "${target}" does not exist.`, [closest(target, [...compositionIds]) ?? 'Create the composition first.']));
      }
    }
    if (type === 'component' && options.components !== undefined) {
      const name = String(ref.node['component']);
      if (!options.components.includes(name)) {
        const hint = closest(name, options.components);
        out.push(semantic(project, [...ref.segments, 'component'], 'OV_COMPONENT_UNKNOWN', `Unknown component "${name}".`, [hint !== undefined ? `component: "${hint}"` : `Use one of: ${options.components.join(', ')}.`]));
      }
    }
    if (type === 'svg' && ref.node['asset'] === undefined && ref.node['markup'] === undefined) {
      out.push(semantic(project, ref.segments, 'OV_SCHEMA_REQUIRED', 'An svg node needs `asset` or `markup`.', ['markup: "<svg …>…</svg>"']));
    }
    if (type === 'shader' && ref.node['sksl'] === undefined && ref.node['glsl'] === undefined) {
      out.push(semantic(project, ref.segments, 'OV_SCHEMA_REQUIRED', 'A shader node needs `sksl` or `glsl`.', ['sksl: "half4 main(float2 p) { return half4(1); }"']));
    }
  }

  // Zyklen zwischen Compositions
  const edges = new Map<string, Set<string>>();
  for (const ref of nodes) {
    if (ref.node['type'] !== 'composition-ref') continue;
    const compIndex = ref.segments[1];
    const from = typeof compIndex === 'number' ? compositions[compIndex]?.['id'] : undefined;
    if (typeof from !== 'string') continue;
    const set = edges.get(from) ?? new Set<string>();
    set.add(String(ref.node['composition']));
    edges.set(from, set);
  }
  const cycle = findCycle(edges);
  if (cycle !== undefined) {
    out.push(semantic(project, ['compositions'], 'OV_SCHEMA_CYCLE', `Compositions reference each other in a cycle: ${cycle.join(' → ')}.`, ['Remove one composition-ref from the cycle.']));
  }

  // Tracks und Audio-Quellen
  compositions.forEach((comp, ci) => {
    const tracks = records(comp['tracks']);
    checkUnique(tracks, ['compositions', ci, 'tracks'], 'track');
    checkUnique(records(comp['markers']), ['compositions', ci, 'markers'], 'marker');
    const markerIds = new Set(records(comp['markers']).map((m) => String(m['id'])));
    const trackIds = new Map(tracks.map((t) => [String(t['id']), String(t['kind'])]));
    const sourceIds = new Set([...audioSources.map((a) => String(a['id'])), ...assets.filter((a) => a['type'] === 'audio' || a['type'] === 'video').map((a) => String(a['id']))]);
    tracks.forEach((track, ti) => {
      if (track['kind'] === 'audio') {
        records(track['clips']).forEach((clip, k) => {
          const source = String(clip['source']);
          if (!sourceIds.has(source)) {
            out.push(semantic(project, ['compositions', ci, 'tracks', ti, 'clips', k, 'source'], 'OV_AUDIO_SOURCE', `Audio source "${source}" is not declared in project.audio or as an audio/video asset.`, [closest(source, [...sourceIds]) ?? 'Declare the source in project.audio.']));
          }
        });
        const ducking = track['ducking'];
        if (isRecord(ducking) && !trackIds.has(String(ducking['by']))) {
          out.push(semantic(project, ['compositions', ci, 'tracks', ti, 'ducking', 'by'], 'OV_AUDIO_TRACK', `Ducking track "${String(ducking['by'])}" does not exist.`, ['Reference an existing audio track id.']));
        }
      }
      if (track['kind'] === 'subtitle' && track['asset'] === undefined && track['cues'] === undefined && track['fromAudio'] === undefined) {
        out.push(semantic(project, ['compositions', ci, 'tracks', ti], 'OV_SUBTITLE_SOURCE', 'A subtitle track needs `asset`, `cues` or `fromAudio`.', ['cues: [{ start: "0s", end: "2s", text: "Hello" }]']));
      }
    });
    for (const ref of nodes) {
      if (ref.segments[1] !== ci) continue;
      if (ref.node['type'] === 'subtitles') {
        const trackId = String(ref.node['track']);
        if (trackIds.get(trackId) !== 'subtitle') {
          out.push(semantic(project, [...ref.segments, 'track'], 'OV_SUBTITLE_TRACK', `Track "${trackId}" is not a subtitle track of this composition.`, ['Add a track { id, kind: "subtitle", … }.']));
        }
      }
    }
    // Marker-Verweise in Zeitwerten
    visitStrings(comp, ['compositions', ci], (value, segments) => {
      const match = /^marker:([A-Za-z][A-Za-z0-9_.-]*?)([+-][0-9].*)?$/u.exec(value);
      if (match?.[1] !== undefined && !markerIds.has(match[1])) {
        out.push(semantic(project, segments, 'OV_TIME_MARKER', `Marker "${match[1]}" does not exist in this composition.`, [closest(match[1], [...markerIds]) ?? 'Add the marker to composition.markers.']));
      }
    });
  });

  // Theme-Verweise
  const settings = isRecord(project['settings']) ? project['settings'] : {};
  const theme = isRecord(settings['theme']) ? settings['theme'] : {};
  visitRefs(project, [], (ref, segments) => {
    const [, group, ...rest] = ref.split('.');
    const groupValue = group !== undefined ? theme[group] : undefined;
    const name = rest.join('.');
    if (!isRecord(groupValue) || !(name in groupValue)) {
      const names = isRecord(groupValue) ? Object.keys(groupValue) : [];
      const hint = closest(name, names);
      out.push(semantic(project, segments, 'OV_THEME_REF', `Theme token "${ref}" is not defined in settings.theme.`, [hint !== undefined ? `{ "$ref": "theme.${group ?? ''}.${hint}" }` : `Define settings.theme.${group ?? ''}.${name}.`]));
    }
  });
  return out;
}

function collectDescendants(node: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const stack = records(node['children']);
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    out.push(n);
    stack.push(...records(n['children']));
  }
  return out;
}

function findCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const pathStack: string[] = [];
  const dfs = (n: string): string[] | undefined => {
    state.set(n, 'visiting');
    pathStack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (state.get(m) === 'visiting') return [...pathStack.slice(pathStack.indexOf(m)), m];
      if (state.get(m) === undefined) {
        const found = dfs(m);
        if (found !== undefined) return found;
      }
    }
    pathStack.pop();
    state.set(n, 'done');
    return undefined;
  };
  for (const n of edges.keys()) {
    if (state.get(n) === undefined) {
      const found = dfs(n);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function visitStrings(value: unknown, segments: readonly Segment[], fn: (value: string, segments: readonly Segment[]) => void): void {
  if (typeof value === 'string') {
    fn(value, segments);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      visitStrings(v, [...segments, i], fn);
    });
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'html' || k === 'css' || k === 'text' || k === 'markup' || k === 'sksl' || k === 'glsl' || k === '$expr') continue;
      visitStrings(v, [...segments, k], fn);
    }
  }
}

function visitRefs(value: unknown, segments: readonly Segment[], fn: (ref: string, segments: readonly Segment[]) => void): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      visitRefs(v, [...segments, i], fn);
    });
  } else if (isRecord(value)) {
    const ref = value['$ref'];
    if (typeof ref === 'string' && Object.keys(value).length === 1 && ref.startsWith('theme.')) {
      fn(ref, segments);
      return;
    }
    for (const [k, v] of Object.entries(value)) visitRefs(v, [...segments, k], fn);
  }
}
