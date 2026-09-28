/**
 * Übersetzt einen Element-Baum eines Frames in Node-Entwürfe der IR.
 * Hier leben die Aliase (`font`, `rotationX/Y/Z`, `src`), die automatische
 * Asset-Deklaration, stabile IDs und das Verschieben referenzierter Kameras.
 */
import { NODE_TYPES_3D, OpenVideoError, isRecord, type AssetType, type BuiltinNodeType } from '@agentic-video/core';
import { flattenChildren, isElement, type SdkElement, type SourceLocation } from './element.js';

/** Entwurf einer Node für einen Frame. */
export interface Draft {
  id: string | undefined;
  readonly type: BuiltinNodeType;
  /** Properties ohne `id`, `type`, `children`, `mask` (JSON-Daten). */
  readonly props: Record<string, unknown>;
  children: Draft[];
  readonly container: boolean;
  readonly mask?: { readonly draft: Draft; readonly rest: Record<string, unknown> };
  readonly source?: SourceLocation;
}

/** Ergebnis der Übersetzung eines Frames. */
export interface FrameScene {
  readonly nodes: Draft[];
  readonly background: unknown;
  readonly tracks: Record<string, unknown>[];
  readonly markers: Record<string, unknown>[];
}

function sdkError(code: string, problem: string, suggestions: readonly string[], source?: SourceLocation): OpenVideoError {
  return new OpenVideoError({
    code,
    errorClass: 'SdkError',
    problem,
    suggestions,
    ...(source !== undefined ? { details: { file: source.file, line: source.line, column: source.column } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const EXTENSION_TYPES: Readonly<Record<string, AssetType>> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  glb: 'model', gltf: 'model', obj: 'model', fbx: 'model', usdz: 'model',
  svg: 'svg', srt: 'subtitle', vtt: 'subtitle', ass: 'subtitle', ssa: 'subtitle',
  cube: 'lut', hdr: 'hdri', exr: 'hdri', html: 'html', htm: 'html', lottie: 'lottie',
};

/**
 * Sammelt automatisch deklarierte Assets. Gleiche `src` ergibt dieselbe ID.
 * ID = Dateiname ohne Endung; Typ = aus der Endung, sonst der Standard der Komponente.
 *
 * @example
 * ```ts
 * const reg = new AssetRegistry([]);
 * reg.register('./assets/product.glb', 'model'); // "product"
 * ```
 */
export class AssetRegistry {
  private readonly bySrc = new Map<string, string>();
  private readonly ids = new Set<string>();
  /** Neu deklarierte Assets in Reihenfolge der Registrierung. */
  readonly declared: Record<string, unknown>[] = [];

  constructor(existing: readonly Readonly<Record<string, unknown>>[]) {
    for (const a of existing) {
      if (typeof a['id'] === 'string') this.ids.add(a['id']);
      if (typeof a['id'] === 'string' && typeof a['src'] === 'string') this.bySrc.set(a['src'], a['id']);
    }
  }

  /** Liefert die Asset-ID für `src` und deklariert das Asset bei Bedarf. */
  register(src: string, fallback: AssetType): string {
    const known = this.bySrc.get(src);
    if (known !== undefined) return known;
    const file = src.split(/[/\\]/u).pop() ?? src;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : '';
    let base = stem.replace(/[^A-Za-z0-9_-]/gu, '-');
    if (!/^[A-Za-z]/u.test(base)) base = `asset-${base}`;
    let id = base;
    for (let n = 2; this.ids.has(id); n++) id = `${base}-${String(n)}`;
    this.ids.add(id);
    this.bySrc.set(src, id);
    this.declared.push({ id, type: EXTENSION_TYPES[ext] ?? fallback, src });
    return id;
  }
}

// ---------------------------------------------------------------------------
// Element-Komponenten
// ---------------------------------------------------------------------------

interface NodeSpec {
  readonly node: BuiltinNodeType;
  readonly asset?: AssetType;
  readonly fixed?: Readonly<Record<string, unknown>>;
  readonly geometry?: { readonly type: string; readonly keys: readonly string[] };
}

const NODE_SPECS: Readonly<Record<string, NodeSpec>> = {
  Group: { node: 'group' },
  Layer: { node: 'layer' },
  Rect: { node: 'rect' },
  RoundedRect: { node: 'rect' },
  Circle: { node: 'ellipse' },
  Ellipse: { node: 'ellipse' },
  Line: { node: 'line' },
  Polyline: { node: 'polyline' },
  Polygon: { node: 'polygon' },
  Path: { node: 'path' },
  Text: { node: 'text' },
  RichText: { node: 'rich-text' },
  Image: { node: 'image', asset: 'image' },
  Video: { node: 'video', asset: 'video' },
  Sprite: { node: 'sprite', asset: 'image' },
  SpriteSheet: { node: 'sprite', asset: 'image' },
  Lottie: { node: 'lottie', asset: 'lottie' },
  Svg: { node: 'svg', asset: 'svg' },
  Shader: { node: 'shader' },
  Particles: { node: 'particles' },
  Html: { node: 'html' },
  Subtitles: { node: 'subtitles' },
  CompositionRef: { node: 'composition-ref' },
  Component: { node: 'component' },
  ThreeScene: { node: 'scene3d' },
  BlenderScene: { node: 'blender' },
  Camera3D: { node: 'camera3d' },
  AmbientLight: { node: 'light3d', fixed: { kind: 'ambient' } },
  DirectionalLight: { node: 'light3d', fixed: { kind: 'directional' } },
  PointLight: { node: 'light3d', fixed: { kind: 'point' } },
  SpotLight: { node: 'light3d', fixed: { kind: 'spot' } },
  HemisphereLight: { node: 'light3d', fixed: { kind: 'hemisphere' } },
  Mesh: { node: 'mesh3d' },
  Box: { node: 'mesh3d', geometry: { type: 'box', keys: ['width', 'height', 'depth'] } },
  Sphere: { node: 'mesh3d', geometry: { type: 'sphere', keys: ['radius', 'segments'] } },
  Plane: { node: 'mesh3d', geometry: { type: 'plane', keys: ['width', 'height'] } },
  Cylinder: { node: 'mesh3d', geometry: { type: 'cylinder', keys: ['radiusTop', 'radiusBottom', 'height', 'segments'] } },
  Cone: { node: 'mesh3d', geometry: { type: 'cone', keys: ['radius', 'height', 'segments'] } },
  Torus: { node: 'mesh3d', geometry: { type: 'torus', keys: ['radius', 'tube'] } },
  TorusKnot: { node: 'mesh3d', geometry: { type: 'torus-knot', keys: ['radius', 'tube', 'p', 'q'] } },
  Capsule: { node: 'mesh3d', geometry: { type: 'capsule', keys: ['radius', 'length'] } },
  Model: { node: 'model3d', asset: 'model' },
  Instances: { node: 'instances3d' },
  Particles3D: { node: 'particles3d' },
  Group3D: { node: 'group3d' },
};

/** Name der Element-Komponente je IR-Typ (für das Rückschreiben neuer Nodes). */
export const COMPONENT_FOR_NODE_TYPE: Readonly<Record<string, string>> = {
  group: 'Group', layer: 'Layer', rect: 'Rect', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon', path: 'Path',
  text: 'Text', 'rich-text': 'RichText', image: 'Image', video: 'Video', sprite: 'Sprite', lottie: 'Lottie', svg: 'Svg', shader: 'Shader',
  particles: 'Particles', html: 'Html', subtitles: 'Subtitles', 'composition-ref': 'CompositionRef', component: 'Component',
  scene3d: 'ThreeScene', blender: 'BlenderScene', camera3d: 'Camera3D', mesh3d: 'Mesh', model3d: 'Model', instances3d: 'Instances',
  particles3d: 'Particles3D', group3d: 'Group3D',
};

/** Komponente für ein Licht je `kind`. */
export const LIGHT_COMPONENTS: Readonly<Record<string, string>> = {
  ambient: 'AmbientLight', directional: 'DirectionalLight', point: 'PointLight', spot: 'SpotLight', hemisphere: 'HemisphereLight',
};

const CONTAINERS: ReadonlySet<string> = new Set(['group', 'layer', 'component', 'scene3d', 'blender', 'group3d']);
const FONT_NODES: ReadonlySet<string> = new Set(['text', 'rich-text', 'subtitles']);
const COMPONENT_NODE_KEYS: ReadonlySet<string> = new Set([
  'name', 'comment', 'visible', 'locked', 'timing', 'transition', 'renderer', 'meta',
  'x', 'y', 'rotation', 'scale', 'skew', 'origin', 'opacity', 'blendMode', 'filters', 'shadow', 'motionPath', 'component', 'props',
]);
const SUBTITLE_TRACK_KEYS: ReadonlySet<string> = new Set(['src', 'cues', 'language', 'fromAudio', 'track']);

// ---------------------------------------------------------------------------
// JSON-Prüfung
// ---------------------------------------------------------------------------

/** Kurze Darstellung eines Werts für Fehlermeldungen. */
function show(value: unknown): string {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? typeof value : JSON.stringify(value);
}

/** Prüft und kopiert einen Property-Wert als JSON. Funktionen und Elemente sind nicht erlaubt. */
function jsonValue(value: unknown, where: string, source: SourceLocation | undefined): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw sdkError('OV_SDK_INVALID_PROP', `Property "${where}" is ${String(value)}; only finite numbers are allowed.`, ['Check the computation for a division by zero.'], source);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v: unknown, i) => {
      if (v === undefined) throw sdkError('OV_SDK_INVALID_PROP', `Property "${where}[${String(i)}]" is undefined.`, ['Remove the empty entry.'], source);
      return jsonValue(v, `${where}[${String(i)}]`, source);
    });
  }
  if (isElement(value)) throw sdkError('OV_SDK_INVALID_PROP', `Property "${where}" contains a JSX element.`, ['Pass elements as children, or use mask={{ node: <Rect … /> }}.'], source);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = jsonValue(v, `${where}.${k}`, source);
    }
    return out;
  }
  const kind = typeof value;
  throw sdkError('OV_SDK_INVALID_PROP', `Property "${where}" is a ${kind}; the IR only stores JSON data.`, kind === 'function' ? ['Use scene: ({ frame }) => … and compute the value per frame.', 'Use animate(), keyframes() or spring() for animations.'] : ['Use a number, string, boolean, array or object.'], source);
}

// ---------------------------------------------------------------------------
// Übersetzung
// ---------------------------------------------------------------------------

/** Zustand der Übersetzung eines Frames. */
export class FrameConverter {
  readonly tracks: Record<string, unknown>[] = [];
  readonly markers: Record<string, unknown>[] = [];
  private subtitleTracks = 0;

  constructor(
    private readonly assets: AssetRegistry,
    private readonly size: { readonly width: number; readonly height: number },
  ) {}

  /** Übersetzt die Rückgabe einer Szene (Scene-Element, Element oder Liste). */
  convertScene(root: unknown): FrameScene {
    let background: unknown;
    let children: unknown = root;
    if (isElement(root) && root.type === 'Scene') {
      for (const key of Object.keys(root.props)) {
        if (key !== 'background' && key !== 'children' && key !== 'key') {
          throw sdkError('OV_SDK_INVALID_PROP', `Scene has no property "${key}".`, ['Scene only takes background and children.', 'Put transforms on a <Group> inside the Scene.'], root.source);
        }
      }
      background = root.props['background'];
      children = root.props['children'];
    }
    const nodes = this.convertChildren(children, 'scene', true);
    assignIds(nodes, null);
    moveReferencedCameras(nodes);
    return { nodes, background, tracks: this.tracks, markers: this.markers };
  }

  private convertChildren(children: unknown, where: string, allowNodes: boolean, source?: SourceLocation): Draft[] {
    const out: Draft[] = [];
    for (const child of flattenChildren(children)) {
      if (!isElement(child)) {
        const hint = typeof child === 'string' || typeof child === 'number' ? ['Use <Text text="…" /> for text.'] : ['Only JSX elements can be children.'];
        throw sdkError('OV_SDK_INVALID_CHILD', `Invalid child in ${where}: ${show(child)}.`, hint, source);
      }
      const drafts = this.convertElement(child);
      if (drafts.length > 0 && !allowNodes) {
        throw sdkError('OV_SDK_INVALID_CHILD', `${where} cannot have child nodes.`, ['Wrap the elements in a <Group>.'], child.source);
      }
      out.push(...drafts);
    }
    return out;
  }

  private convertElement(el: SdkElement): Draft[] {
    switch (el.type) {
      case 'Fragment':
        return this.convertChildren(el.props['children'], 'Fragment', true, el.source);
      case 'Scene':
        throw sdkError('OV_SDK_INVALID_CHILD', 'Scene must be the root element of a scene.', ['Use <Group> for nested structure.'], el.source);
      case 'Marker':
        this.liftMarker(el);
        return [];
      case 'AudioTrack':
        this.liftAudioTrack(el);
        return [];
      case 'AudioClip':
        throw sdkError('OV_SDK_INVALID_CHILD', 'AudioClip must be a child of AudioTrack.', ['<AudioTrack><AudioClip src="./music.mp3" start="0s" /></AudioTrack>'], el.source);
      case 'SubtitleTrack':
        return [this.subtitleTrack(el)];
      case 'Component':
        return [this.componentDraft(el)];
      default: {
        const spec = NODE_SPECS[el.type];
        if (spec === undefined) {
          throw sdkError('OV_SDK_UNKNOWN_ELEMENT', `Unknown element type "${el.type}".`, ['Use an element component exported by @agentic-video/sdk.', 'Use component("Name") for library components.'], el.source);
        }
        return [this.nodeDraft(el, spec)];
      }
    }
  }

  private split(el: SdkElement): { id: string | undefined; rest: Record<string, unknown> } {
    const rest: Record<string, unknown> = {};
    let id: string | undefined;
    for (const [key, value] of Object.entries(el.props)) {
      if (key === 'key' || value === undefined) continue;
      if (key === 'id') {
        if (typeof value !== 'string') throw sdkError('OV_SDK_INVALID_PROP', `id must be a string, got ${show(value)}.`, ['id="headline"'], el.source);
        id = value;
        continue;
      }
      rest[key] = value;
    }
    return { id, rest };
  }

  private nodeDraft(el: SdkElement, spec: NodeSpec, override?: { readonly id?: string; readonly rest?: Record<string, unknown> }): Draft {
    const parts = this.split(el);
    const id = override?.id ?? parts.id;
    const rest = override?.rest ?? parts.rest;
    const children = rest['children'];
    const mask = rest['mask'];
    delete rest['children'];
    delete rest['mask'];
    this.applyAliases(el, spec, rest);

    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...rest, ...(spec.fixed ?? {}) })) props[key] = jsonValue(value, key, el.source);
    if (spec.geometry !== undefined) {
      // Geometrie-Felder stehen nach den übrigen Props, damit die IR lesbar bleibt.
      const geometry = props['geometry'];
      delete props['geometry'];
      props['geometry'] = geometry;
    }

    const container = CONTAINERS.has(spec.node);
    const childDrafts = this.convertChildren(children, el.type, container, el.source);
    let maskDraft: Draft['mask'];
    if (mask !== undefined) {
      if (!isRecord(mask) || !isElement(mask['node'])) throw sdkError('OV_SDK_INVALID_PROP', 'mask needs a node element.', ['mask={{ node: <Rect width={100} height={100} /> }}'], el.source);
      const maskNodes = this.convertElement(mask['node']);
      const only = maskNodes[0];
      if (only === undefined || maskNodes.length !== 1) throw sdkError('OV_SDK_INVALID_PROP', 'mask.node must produce exactly one node.', ['Wrap several shapes in a <Group>.'], el.source);
      const maskRest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(mask)) if (k !== 'node' && v !== undefined) maskRest[k] = jsonValue(v, `mask.${k}`, el.source);
      maskDraft = { draft: only, rest: maskRest };
    }
    return {
      id,
      type: spec.node,
      props,
      children: childDrafts,
      container,
      ...(maskDraft !== undefined ? { mask: maskDraft } : {}),
      ...(el.source !== undefined ? { source: el.source } : {}),
    };
  }

  private applyAliases(el: SdkElement, spec: NodeSpec, rest: Record<string, unknown>): void {
    const src = rest['src'];
    if (spec.asset !== undefined && src !== undefined) {
      if (typeof src !== 'string') throw sdkError('OV_SDK_INVALID_PROP', 'src must be a string path.', ['src="./assets/logo.png"'], el.source);
      delete rest['src'];
      rest['asset'] = this.assets.register(src, spec.asset);
    }
    if (FONT_NODES.has(spec.node) && rest['font'] !== undefined) {
      if (rest['fontFamily'] !== undefined) throw sdkError('OV_SDK_INVALID_PROP', 'Use either font or fontFamily, not both.', ['fontFamily="Inter"'], el.source);
      rest['fontFamily'] = rest['font'];
      delete rest['font'];
    }
    if (NODE_TYPES_3D.includes(spec.node)) this.rotationAlias(el, rest);
    if (el.type === 'Circle' && rest['radius'] !== undefined) {
      const r = rest['radius'];
      if (typeof r !== 'number') throw sdkError('OV_SDK_INVALID_PROP', 'Circle radius must be a number.', ['Compute the radius per frame: scene: ({ frame }) => <Circle radius={10 + frame} />', 'Use <Ellipse> with animated width and height.'], el.source);
      delete rest['radius'];
      rest['width'] = 2 * r;
      rest['height'] = 2 * r;
    }
    if (el.type === 'RoundedRect' && rest['radius'] !== undefined) {
      rest['cornerRadius'] = rest['radius'];
      delete rest['radius'];
    }
    if (spec.geometry !== undefined) {
      const geometry: Record<string, unknown> = { type: spec.geometry.type };
      for (const key of spec.geometry.keys) {
        if (rest[key] === undefined) continue;
        geometry[key] = rest[key];
        Reflect.deleteProperty(rest, key);
      }
      rest['geometry'] = geometry;
    }
    if ((spec.node === 'scene3d' || spec.node === 'blender') && rest['width'] === undefined && rest['height'] === undefined) {
      rest['width'] = this.size.width;
      rest['height'] = this.size.height;
    }
  }

  private rotationAlias(el: SdkElement, rest: Record<string, unknown>): void {
    const axes = ['rotationX', 'rotationY', 'rotationZ'] as const;
    if (!axes.some((a) => rest[a] !== undefined)) return;
    const base = rest['rotation'] ?? [0, 0, 0];
    if (!Array.isArray(base) || base.length !== 3) {
      throw sdkError('OV_SDK_INVALID_PROP', 'rotationX/Y/Z cannot be combined with an animated rotation.', ['Use rotation={[x, y, z]} only, or rotationX/Y/Z only.'], el.source);
    }
    const rotation = base.map((v: unknown) => v);
    axes.forEach((axis, i) => {
      const v = rest[axis];
      if (v === undefined) return;
      if (typeof v !== 'number') throw sdkError('OV_SDK_INVALID_PROP', `${axis} must be a number (degrees).`, [`scene: ({ time }) => <Model ${axis}={time * 45} />`], el.source);
      rotation[i] = v;
      Reflect.deleteProperty(rest, axis);
    });
    rest['rotation'] = rotation;
  }

  private subtitleTrack(el: SdkElement): Draft {
    const { id, rest } = this.split(el);
    const trackFields: Record<string, unknown> = {};
    const nodeRest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) (SUBTITLE_TRACK_KEYS.has(k) ? trackFields : nodeRest)[k] = v;
    let assetId: string | undefined;
    const src = trackFields['src'];
    if (src !== undefined) {
      if (typeof src !== 'string') throw sdkError('OV_SDK_INVALID_PROP', 'src must be a string path.', ['src="./audio/voiceover.srt"'], el.source);
      assetId = this.assets.register(src, 'subtitle');
    }
    this.subtitleTracks += 1;
    const explicit = trackFields['track'];
    const trackId = typeof explicit === 'string' ? explicit : (assetId ?? `subtitle-track-${String(this.subtitleTracks)}`);
    const track: Record<string, unknown> = { id: trackId, kind: 'subtitle' };
    if (assetId !== undefined) track['asset'] = assetId;
    for (const key of ['cues', 'language', 'fromAudio']) if (trackFields[key] !== undefined) track[key] = jsonValue(trackFields[key], key, el.source);
    this.tracks.push(track);
    nodeRest['track'] = trackId;
    return this.nodeDraft(el, { node: 'subtitles' }, { ...(id !== undefined ? { id } : {}), rest: nodeRest });
  }

  /** Node-Felder bleiben an der Node; alle anderen Props wandern nach `props`. */
  private componentDraft(el: SdkElement): Draft {
    const { id, rest } = this.split(el);
    const nodeRest: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) (COMPONENT_NODE_KEYS.has(k) || k === 'children' || k === 'mask' ? nodeRest : extra)[k] = v;
    if (Object.keys(extra).length > 0) {
      const explicit = nodeRest['props'];
      nodeRest['props'] = { ...(isRecord(explicit) ? explicit : {}), ...extra };
    }
    return this.nodeDraft(el, { node: 'component' }, { ...(id !== undefined ? { id } : {}), rest: nodeRest });
  }

  private liftMarker(el: SdkElement): void {
    const { id, rest } = this.split(el);
    const marker: Record<string, unknown> = { id: id ?? `marker-${String(this.markers.length + 1)}` };
    for (const [k, v] of Object.entries(rest)) marker[k] = jsonValue(v, k, el.source);
    this.markers.push(marker);
  }

  private liftAudioTrack(el: SdkElement): void {
    const { id, rest } = this.split(el);
    const trackId = id ?? `audio-${String(this.tracks.filter((t) => t['kind'] === 'audio').length + 1)}`;
    const track: Record<string, unknown> = { id: trackId, kind: 'audio' };
    const clips: Record<string, unknown>[] = [];
    for (const child of flattenChildren(rest['children'])) {
      if (!isElement(child) || child.type !== 'AudioClip') throw sdkError('OV_SDK_INVALID_CHILD', 'AudioTrack children must be AudioClip elements.', ['<AudioClip src="./music.mp3" start="0s" />'], el.source);
      const clip = this.split(child);
      const out: Record<string, unknown> = { id: clip.id ?? `${trackId}-clip-${String(clips.length + 1)}` };
      const src = clip.rest['src'];
      if (src !== undefined) {
        if (typeof src !== 'string') throw sdkError('OV_SDK_INVALID_PROP', 'src must be a string path.', ['src="./audio/music.mp3"'], child.source);
        out['source'] = this.assets.register(src, 'audio');
      }
      for (const [k, v] of Object.entries(clip.rest)) if (k !== 'src') out[k] = jsonValue(v, k, child.source);
      clips.push(out);
    }
    for (const [k, v] of Object.entries(rest)) if (k !== 'children') track[k] = jsonValue(v, k, el.source);
    track['clips'] = clips;
    this.tracks.push(track);
  }
}

/**
 * Vergibt IDs an Nodes ohne `id`: `<typ>-<n>` auf oberster Ebene, sonst
 * `<eltern-id>-<typ>-<n>`. `n` zählt Geschwister desselben Typs ab 1 (z. B. `text-2`).
 */
function assignIds(nodes: readonly Draft[], parentId: string | null): void {
  const counters = new Map<string, number>();
  for (const d of nodes) {
    const n = (counters.get(d.type) ?? 0) + 1;
    counters.set(d.type, n);
    d.id ??= parentId === null ? `${d.type}-${String(n)}` : `${parentId}-${d.type}-${String(n)}`;
    if (d.mask !== undefined) d.mask.draft.id ??= `${d.id}-mask`;
    assignIds(d.children, d.id);
    if (d.mask !== undefined) assignIds(d.mask.draft.children, d.mask.draft.id ?? d.id);
  }
}

function contains(list: readonly Draft[], pred: (d: Draft) => boolean): boolean {
  return list.some((d) => pred(d) || contains(d.children, pred));
}

/**
 * Verschiebt eine `camera3d`, die außerhalb liegt, aber per `camera="id"` von
 * einer 3D-Szene referenziert wird, als erstes Kind in diese Szene.
 */
function moveReferencedCameras(roots: Draft[]): void {
  const scenes: Draft[] = [];
  const collect = (list: readonly Draft[]): void => {
    for (const d of list) {
      if ((d.type === 'scene3d' || d.type === 'blender') && typeof d.props['camera'] === 'string') scenes.push(d);
      collect(d.children);
    }
  };
  collect(roots);
  for (const scene of scenes) {
    const cameraId = scene.props['camera'];
    if (contains(scene.children, (d) => d.type === 'camera3d' && d.id === cameraId)) continue;
    const take = (list: Draft[], inside3d: boolean): Draft | undefined => {
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        if (d === undefined) continue;
        if (!inside3d && d.type === 'camera3d' && d.id === cameraId) {
          list.splice(i, 1);
          return d;
        }
        const found = take(d.children, inside3d || d.type === 'scene3d' || d.type === 'blender' || d.type === 'group3d');
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const camera = take(roots, false);
    if (camera !== undefined) scene.children = [camera, ...scene.children];
  }
}

/**
 * Setzt Properties einer Node inklusive Maske und `meta.source` zusammen (ohne Kinder).
 *
 * @example
 * ```ts
 * nodeProps(draft); // { fontSize: 92, meta: { source: { file, line, column } } }
 * ```
 */
export function nodeProps(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { ...d.props };
  if (d.mask !== undefined) out['mask'] = { ...d.mask.rest, node: finalizeDraft(d.mask.draft) };
  if (d.source !== undefined) {
    const meta = isRecord(out['meta']) ? out['meta'] : {};
    out['meta'] = { ...meta, source: { file: d.source.file, line: d.source.line, column: d.source.column } };
  }
  return out;
}

/**
 * Macht aus einem Entwurf eine fertige IR-Node (rekursiv).
 *
 * @example
 * ```ts
 * finalizeDraft(draft); // { id: 'text-1', type: 'text', text: 'Hi' }
 * ```
 */
export function finalizeDraft(d: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { id: d.id, type: d.type, ...nodeProps(d) };
  if (d.container && d.children.length > 0) out['children'] = d.children.map(finalizeDraft);
  return out;
}
