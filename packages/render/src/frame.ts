/**
 * Frame-Render (FR-6, FR-24, FR-65): IR → Evaluated Scene → Frame Plan → Layer → Compositor → Frame Cache.
 */
import {
  OpenVideoError,
  analyzeScene,
  computeBounds,
  contentHash,
  evaluateScene,
  frameKey,
  getNumber,
  isRecord,
  localBox,
  localMatrix,
  multiply,
  planFrame,
  scale as scaleMatrix,
  transformRect,
  unionRect,
  walkEvaluated,
  type AssetResolver,
  type DebugOptions,
  type Diagnostic,
  type EvaluatedNode,
  type EvaluatedScene,
  type LayerPlan,
  type Matrix2D,
  type NodeBounds,
  type Rect,
  type RgbaImage,
} from '@agentic-video/core';
import { hasNodeFilters } from '@agentic-video/compositor';
import { decodeRawFrame, encodeRawFrameAsync } from '@agentic-video/png';
import { MOTION_STATES_CAPABILITY, evaluateMotionStates, type BlenderLayerRequest, type MotionState } from '@agentic-video/renderer-blender';
import type { CompositorNode, RenderEnvironment } from './environment.js';

/** Optionen für {@link renderFrame}. */
export interface RenderFrameOptions {
  readonly compositionId?: string;
  readonly frame: number;
  /** Vorschau-Skalierung (1 = volle Auflösung). */
  readonly scale?: number;
  readonly debug?: DebugOptions;
  /** Frame-Cache nutzen (Standard `true`). */
  readonly useCache?: boolean;
  readonly signal?: { readonly aborted: boolean };
}

/** Ergebnis eines Frame-Renders. */
export interface FrameResult {
  readonly image: RgbaImage;
  readonly key: string;
  readonly cached: boolean;
  readonly scene: EvaluatedScene;
  readonly bounds: readonly NodeBounds[];
  readonly diagnostics: readonly Diagnostic[];
  /** Dauer je Pipeline-Stufe in Millisekunden. */
  readonly timings: Readonly<Record<string, number>>;
  /** Anzahl der gerenderten Layer und Treffer im Layer-Cache. */
  readonly layers: { readonly rendered: number; readonly cached: number };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Hashes aller Assets des Projects (Teil des Frame-Schlüssels). */
export function assetHashes(env: RenderEnvironment, project: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of records(project['assets'])) {
    const id = String(a['id']);
    const record = env.assets.get(id);
    out[id] = record?.hash ?? (typeof a['hash'] === 'string' ? a['hash'] : `unresolved:${String(a['src'])}`);
  }
  for (const f of env.fonts.all()) out[`font:${f.family}:${String(f.weight)}:${f.style}`] = f.hash;
  return out;
}

/** Ausgabegröße eines Frames bei Skalierung. */
export function outputSize(scene: { readonly width: number; readonly height: number }, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(scene.width * scale)), height: Math.max(1, Math.round(scene.height * scale)) };
}

function stripNode(node: EvaluatedNode): unknown {
  return { id: node.id, type: node.type, props: node.props, children: node.children.map(stripNode), mask: node.mask === undefined ? undefined : { ...node.mask, node: stripNode(node.mask.node) }, reveal: node.reveal, time: node.time.localFrame };
}

/**
 * Animierte Rasterbilder (GIF, animiertes WebP, APNG) in `image`-Nodes laufen über den
 * Video-Frame-Pfad: Die Asset-Pipeline normalisiert sie zu einem verlustfreien Video; hier wird
 * die Node zu einer stummen, endlos laufenden `video`-Node mit denselben Maßen, `fit` und `smoothing`.
 * Dadurch ist die Node zeitabhängig (Frame- und Layer-Schlüssel enthalten die lokale Zeit).
 * Ohne animierte Bilder kommt dieselbe Szene zurück.
 *
 * @example
 * ```ts
 * const scene = resolveAnimatedImages(env.assets, evaluateScene(project, 'main', 12));
 * ```
 */
export function resolveAnimatedImages(assets: AssetResolver, scene: EvaluatedScene): EvaluatedScene {
  const animated = (node: EvaluatedNode): boolean => {
    if (node.type !== 'image') return false;
    const asset = node.props['asset'];
    return typeof asset === 'string' && assets.get(asset)?.metadata['animated'] === true;
  };
  const any = (nodes: readonly EvaluatedNode[]): boolean => nodes.some((n) => animated(n) || any(n.children) || (n.mask !== undefined && any([n.mask.node])));
  if (!any(scene.nodes)) return scene;
  const map = (node: EvaluatedNode): EvaluatedNode => {
    const children = node.children.map(map);
    const mask = node.mask === undefined ? undefined : { ...node.mask, node: map(node.mask.node) };
    const base: EvaluatedNode = { ...node, children, ...(mask !== undefined ? { mask } : {}) };
    if (!animated(node)) return base;
    return { ...base, type: 'video', props: { ...node.props, loop: true, muted: true } };
  };
  return { ...scene, nodes: scene.nodes.map(map) };
}

interface PlanContext {
  readonly env: RenderEnvironment;
  readonly scene: EvaluatedScene;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly debug: DebugOptions | undefined;
  readonly project: Readonly<Record<string, unknown>>;
  readonly compositionId: string | undefined;
  readonly counters: { rendered: number; cached: number };
  readonly signal: { readonly aborted: boolean } | undefined;
  /** Laufende Cache-Schreibvorgänge; {@link renderFrame} wartet am Ende auf alle. */
  readonly writes: CacheWrites;
  /** Diagnosen aus dem Zusammensetzen. */
  readonly diagnostics: Diagnostic[];
}

/**
 * Cache-Schreibvorgänge im Hintergrund: Die zlib-Kompression eines Layers (1080p: rund 150 ms)
 * läuft im Thread-Pool, während der Haupt-Thread weitere Layer und den Compositor rechnet.
 */
class CacheWrites {
  readonly #pending: Promise<void>[] = [];
  #error: unknown;
  #failed = false;

  add(image: RgbaImage, put: (bytes: Uint8Array) => Promise<void>): void {
    this.#pending.push(
      encodeRawFrameAsync(image)
        .then(put)
        .catch((error: unknown) => {
          if (!this.#failed) {
            this.#failed = true;
            this.#error = error;
          }
        }),
    );
  }

  /** Wartet auf alle Schreibvorgänge; wirft den ersten Fehler. */
  async flush(): Promise<void> {
    await Promise.all(this.#pending);
    if (this.#failed) throw this.#error;
  }
}

/**
 * Subframe-Zustände für Backends mit Fähigkeit `motion-states` (Blender, Story 17.5): Hat eine Node
 * des Layers `motionBlur: true`, wird die Szene an den Nachbar-Subframes ausgewertet. Ohne solche
 * Nodes oder ohne die Fähigkeit `undefined`.
 */
function motionStatesFor(ctx: PlanContext, capabilities: readonly string[], nodes: readonly EvaluatedNode[]): MotionState[] | undefined {
  if (!capabilities.includes(MOTION_STATES_CAPABILITY) || !nodes.some((n) => n.props['motionBlur'] === true)) return undefined;
  return evaluateMotionStates(
    ctx.project,
    ctx.compositionId,
    ctx.scene.frame,
    nodes.map((n) => n.id),
    undefined,
    { registry: ctx.env.registry },
  );
}

async function renderLayerCached(ctx: PlanContext, backendId: string, nodes: readonly EvaluatedNode[], layerId: string): Promise<RgbaImage> {
  const backend = ctx.env.registry.backends.get(backendId);
  if (backend === undefined) {
    throw new OpenVideoError({
      code: 'OV_BACKEND_MISSING',
      errorClass: 'RendererError',
      problem: `The "${backendId}" backend is not available.`,
      frame: ctx.scene.frame,
      ...(nodes[0] !== undefined ? { nodeId: nodes[0].id } : {}),
      suggestions: [`Run \`openvideo doctor\` to see why the ${backendId} backend is unavailable.`],
    });
  }
  const motionStates = motionStatesFor(ctx, backend.capabilities, nodes);
  const key = contentHash({ backend: backendId, versions: backend.versions(), nodes: nodes.map(stripNode), ...(motionStates !== undefined ? { motion: motionStates.map((m) => ({ offset: m.offset, nodes: m.nodes.map(stripNode) })) } : {}), width: ctx.width, height: ctx.height, scale: ctx.scale, scene: { w: ctx.scene.width, h: ctx.scene.height, seed: ctx.scene.seed, fps: ctx.scene.fps }, debug: ctx.debug ?? null });
  const tier = ctx.env.cache.tier('layer');
  const hit = await tier.get(key);
  if (hit !== undefined) {
    ctx.counters.cached++;
    ctx.env.telemetry.metrics.cacheHit('layer');
    return decodeRawFrame(hit);
  }
  ctx.env.telemetry.metrics.cacheMiss('layer');
  if (ctx.signal?.aborted === true) throw new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] });
  const request: BlenderLayerRequest = {
    layerId,
    scene: ctx.scene,
    nodes,
    width: ctx.width,
    height: ctx.height,
    scale: ctx.scale,
    assets: ctx.env.assets,
    fonts: ctx.env.fonts,
    ...(ctx.debug !== undefined ? { debug: ctx.debug } : {}),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(motionStates !== undefined ? { motionStates } : {}),
  };
  const image = await backend.renderLayer(request);
  if (image.width !== ctx.width || image.height !== ctx.height) {
    throw new OpenVideoError({
      code: 'OV_BACKEND_SIZE',
      errorClass: 'RendererError',
      problem: `The ${backendId} backend returned ${String(image.width)}×${String(image.height)} instead of ${String(ctx.width)}×${String(ctx.height)}.`,
      suggestions: ['This is a renderer bug; please report it with the render manifest.'],
    });
  }
  ctx.counters.rendered++;
  ctx.writes.add(image, (bytes) => tier.put(key, bytes));
  return image;
}

function findNode(nodes: readonly EvaluatedNode[], id: string): EvaluatedNode | undefined {
  let found: EvaluatedNode | undefined;
  walkEvaluated(nodes, (n) => {
    if (found === undefined && n.id === id) found = n;
  });
  return found;
}

async function renderMask(ctx: PlanContext, node: EvaluatedNode): Promise<CompositorNode[]> {
  const scene: EvaluatedScene = { ...ctx.scene, background: 'transparent', nodes: [node] };
  return buildTree(ctx, planFrame(scene, ctx.env.registry, { renderer2d: renderer2dOf(ctx.project) }));
}

function renderer2dOf(project: Readonly<Record<string, unknown>>): string {
  const settings = project['settings'];
  return isRecord(settings) && typeof settings['renderer2d'] === 'string' ? settings['renderer2d'] : 'skia';
}

async function flattenToImage(ctx: PlanContext, tree: CompositorNode[]): Promise<RgbaImage> {
  return Promise.resolve(
    ctx.env.composite({ width: ctx.width, height: ctx.height, scale: ctx.scale, background: 'transparent', workingSpace: 'srgb', layers: tree, frame: ctx.scene.frame, seed: ctx.scene.seed, effects: ctx.env.registry.effects }),
  );
}

/**
 * Eigengröße einer Node für Transform-Ursprung und Box, wie sie das 2D-Backend misst:
 * Text über den Textmesser, Rasterbilder über die Asset-Maße.
 */
function measuredOf(env: RenderEnvironment, node: EvaluatedNode): { width: number; height: number } | undefined {
  switch (node.type) {
    case 'text':
    case 'rich-text': {
      const m = env.measurer?.measure(node);
      return m === undefined ? undefined : { width: m.width, height: m.height };
    }
    case 'image':
    case 'video':
    case 'svg':
    case 'sprite': {
      const asset = node.props['asset'];
      const dims = typeof asset === 'string' ? env.assets.get(asset)?.dimensions : undefined;
      if (dims === undefined) return undefined;
      if (node.type !== 'sprite') return { width: dims.width, height: dims.height };
      return { width: dims.width / Math.max(1, getNumber(node, 'columns', 1)), height: dims.height / Math.max(1, getNumber(node, 'rows', 1)) };
    }
    default:
      return undefined;
  }
}

/** Box für Reveal-Clips: die lokale Box, bei Gruppen ohne Maße die Hülle der Kinder (wie im 2D-Backend). */
function contentBox(env: RenderEnvironment, node: EvaluatedNode): Rect {
  const box = localBox(node, measuredOf(env, node));
  if ((box.width > 0 && box.height > 0) || (node.type !== 'group' && node.type !== 'layer')) return box;
  let union: Rect | undefined;
  for (const child of node.children) {
    const measured = measuredOf(env, child);
    union = unionRect(union, transformRect(localMatrix(child, measured), contentBox(env, child)));
  }
  return union ?? box;
}

async function maskOf(ctx: PlanContext, node: EvaluatedNode): Promise<{ image: RgbaImage; mode: 'alpha' | 'luminance'; invert: boolean } | undefined> {
  if (node.mask === undefined) return undefined;
  // Masken-Node liegt im lokalen Raum der Node (Semantik 1.4); der Compositor transformiert die Maske mit.
  const image = await flattenToImage(ctx, await renderMask(ctx, node.mask.node));
  return { image, mode: node.mask.mode, invert: node.mask.invert };
}

async function buildGroup(ctx: PlanContext, node: EvaluatedNode, children: readonly LayerPlan[]): Promise<CompositorNode> {
  const childTree = await buildTree(ctx, children);
  const mask = await maskOf(ctx, node);
  // filters und shadow der Gruppe wendet der Compositor an (Story 17.11).
  return {
    kind: 'group',
    node,
    children: childTree,
    ...(mask !== undefined ? { mask } : {}),
    ...(node.reveal !== undefined ? { reveal: { reveal: node.reveal, box: contentBox(ctx.env, node) } } : {}),
  };
}

/**
 * Node-Typen, deren Backends `filters` und `shadow` nicht selbst zeichnen (Three.js, Blender).
 * Für sie wendet der Compositor beides an (Story 17.11).
 */
const FILTERLESS_TYPES: ReadonlySet<string> = new Set(['scene3d', 'blender']);

function isolateMatrix(ctx: PlanContext, node: EvaluatedNode): Matrix2D {
  const s = ctx.scale;
  return multiply(scaleMatrix(s, s), multiply(localMatrix(node, measuredOf(ctx.env, node)), scaleMatrix(1 / s, 1 / s)));
}

/** Isolierte Node: Das Backend hat sie transformiert; der Compositor wendet Reveal, Maske und Blend Mode an. */
async function buildIsolate(ctx: PlanContext, node: EvaluatedNode, children: readonly LayerPlan[]): Promise<CompositorNode> {
  // Filter der Node wendet diese Isolierung an, nicht der Kind-Layer.
  const childTree = await buildTree(ctx, children, true);
  const mask = await maskOf(ctx, node);
  return {
    kind: 'isolate',
    node,
    children: childTree,
    matrix: isolateMatrix(ctx, node),
    ...(mask !== undefined ? { mask } : {}),
    ...(node.reveal !== undefined ? { reveal: { reveal: node.reveal, box: contentBox(ctx.env, node) } } : {}),
    ...(FILTERLESS_TYPES.has(node.type) && hasNodeFilters(node.props) ? { applyFilters: true } : {}),
  };
}

async function buildTree(ctx: PlanContext, plan: readonly LayerPlan[], isolated = false): Promise<CompositorNode[]> {
  const out: CompositorNode[] = [];
  for (const layer of plan) {
    if (layer.kind === 'render') {
      const image: CompositorNode = { kind: 'image', image: await renderLayerCached(ctx, layer.backend, layer.nodes, layer.id) };
      const [only, ...rest] = layer.nodes;
      if (!isolated && only !== undefined && rest.length === 0 && FILTERLESS_TYPES.has(only.type) && hasNodeFilters(only.props)) {
        // scene3d/blender mit filters/shadow: Der Compositor zeichnet sie auf dem fertigen Layer (Story 17.11).
        out.push({ kind: 'isolate', node: only, children: [image], matrix: isolateMatrix(ctx, only), applyFilters: true });
        continue;
      }
      out.push(image);
      continue;
    }
    if (layer.mode === 'isolate') {
      out.push(await buildIsolate(ctx, layer.node, layer.children));
      continue;
    }
    const blur = layer.node.props['motionBlur'];
    if (layer.node.type === 'layer' && isRecord(blur) && typeof blur['samples'] === 'number' && typeof blur['shutter'] === 'number' && blur['samples'] >= 2) {
      out.push(await motionBlurGroup(ctx, layer.node, blur['samples'], blur['shutter']));
      continue;
    }
    out.push(await buildGroup(ctx, layer.node, layer.children));
  }
  return out;
}

/**
 * Motion Blur durch zeitliches Supersampling: der Layer wird zu `samples` Unterframes innerhalb
 * von `shutter` (Bruchteil eines Frames, zentriert) gerendert und gemittelt.
 */
async function motionBlurGroup(ctx: PlanContext, node: EvaluatedNode, samples: number, shutter: number): Promise<CompositorNode> {
  const images: RgbaImage[] = [];
  for (let i = 0; i < samples; i++) {
    const offset = (i / (samples - 1) - 0.5) * shutter;
    const sub = offset === 0 ? ctx.scene : resolveAnimatedImages(ctx.env.assets, evaluateScene(ctx.project, ctx.compositionId, ctx.scene.frame + offset, { registry: ctx.env.registry }));
    const subNode = findNode(sub.nodes, node.id);
    if (subNode === undefined) continue;
    const subCtx: PlanContext = { ...ctx, scene: sub };
    const children = planFrame({ ...sub, background: 'transparent', nodes: subNode.children }, ctx.env.registry, { renderer2d: renderer2dOf(ctx.project) });
    const group = await buildGroup(subCtx, { ...subNode, props: { ...subNode.props, motionBlur: undefined } }, children);
    images.push(await flattenToImage(subCtx, [group]));
  }
  return { kind: 'image', image: ctx.env.accumulate(images) };
}

/**
 * Rendert einen einzelnen Frame. Ergebnis und Layer landen im Cache.
 *
 * @example
 * ```ts
 * const { image, diagnostics } = await renderFrame(env, project, { frame: 120, scale: 0.5 });
 * ```
 */
export async function renderFrame(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, options: RenderFrameOptions): Promise<FrameResult> {
  const timings: Record<string, number> = {};
  const time = async <T>(stage: string, fn: () => Promise<T> | T): Promise<T> => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      timings[stage] = (timings[stage] ?? 0) + performance.now() - start;
    }
  };
  const scale = options.scale ?? 1;
  const scene = await time('timelineEvaluator', () => resolveAnimatedImages(env.assets, evaluateScene(project, options.compositionId, options.frame, { registry: env.registry })));
  const size = outputSize(scene, scale);
  const bounds = await time('bounds', () => computeBounds(scene, env.measurer));
  const diagnostics: Diagnostic[] = [...scene.diagnostics, ...analyzeScene(scene, bounds)];
  const key = frameKey(scene, env.versions, assetHashes(env, project), { width: size.width, height: size.height, extra: { scale, debug: options.debug ?? null } });
  const tier = env.cache.tier('frame');
  if (options.useCache !== false) {
    const hit = await time('frameCache', () => tier.get(key));
    if (hit !== undefined) {
      env.telemetry.metrics.cacheHit('frame');
      return { image: decodeRawFrame(hit), key, cached: true, scene, bounds, diagnostics, timings, layers: { rendered: 0, cached: 0 } };
    }
    env.telemetry.metrics.cacheMiss('frame');
  }
  const plan = await time('framePlan', () => planFrame(scene, env.registry, { renderer2d: renderer2dOf(project) }));
  const counters = { rendered: 0, cached: 0 };
  const writes = new CacheWrites();
  const ctx: PlanContext = { env, scene, width: size.width, height: size.height, scale, debug: options.debug, project, compositionId: options.compositionId, counters, signal: options.signal, writes, diagnostics };
  let image: RgbaImage;
  try {
    const tree = await time('renderers', () => buildTree(ctx, plan));
    if (options.debug !== undefined && env.overlays !== undefined && Object.values(options.debug).some((v) => v === true)) {
      const overlays = env.overlays;
      const debug = options.debug;
      tree.push({ kind: 'image', image: await time('debugOverlay', () => overlays.debugOverlay(scene, bounds, debug, { ...size, scale })) });
    }
    image = await time('compositor', () =>
      env.composite({
        width: size.width,
        height: size.height,
        scale,
        background: scene.background,
        workingSpace: scene.colorSpace,
        outputSpace: scene.outputColorSpace ?? 'srgb',
        layers: tree,
        frame: scene.frame,
        seed: scene.seed,
        effects: env.registry.effects,
        ...(env.resolveLut !== undefined ? { resolveLut: (id: string) => env.resolveLut?.(id) } : {}),
      }),
    );
  } catch (error) {
    // Der Render-Fehler hat Vorrang; laufende Schreibvorgänge enden trotzdem, bevor er weiterfliegt.
    await writes.flush().catch(() => undefined);
    throw error;
  }
  if (options.useCache !== false) writes.add(image, (bytes) => tier.put(key, bytes));
  await time('frameCache', () => writes.flush());
  env.telemetry.metrics.recordFrameDuration(Object.values(timings).reduce((a, b) => a + b, 0), { composition: scene.compositionId });
  return { image, key, cached: false, scene, bounds, diagnostics, timings, layers: counters };
}
