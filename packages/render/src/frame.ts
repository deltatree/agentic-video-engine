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
  isRecord,
  planFrame,
  walkEvaluated,
  type DebugOptions,
  type Diagnostic,
  type EvaluatedNode,
  type EvaluatedScene,
  type LayerPlan,
  type NodeBounds,
  type RgbaImage,
} from '@agentic-video/core';
import { decodeRawFrame, encodeRawFrame } from '@agentic-video/png';
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
  const key = contentHash({ backend: backendId, versions: backend.versions(), nodes: nodes.map(stripNode), width: ctx.width, height: ctx.height, scale: ctx.scale, scene: { w: ctx.scene.width, h: ctx.scene.height, seed: ctx.scene.seed, fps: ctx.scene.fps }, debug: ctx.debug ?? null });
  const tier = ctx.env.cache.tier('layer');
  const hit = await tier.get(key);
  if (hit !== undefined) {
    ctx.counters.cached++;
    ctx.env.telemetry.metrics.cacheHit('layer');
    return decodeRawFrame(hit);
  }
  ctx.env.telemetry.metrics.cacheMiss('layer');
  if (ctx.signal?.aborted === true) throw new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] });
  const image = await backend.renderLayer({
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
  });
  if (image.width !== ctx.width || image.height !== ctx.height) {
    throw new OpenVideoError({
      code: 'OV_BACKEND_SIZE',
      errorClass: 'RendererError',
      problem: `The ${backendId} backend returned ${String(image.width)}×${String(image.height)} instead of ${String(ctx.width)}×${String(ctx.height)}.`,
      suggestions: ['This is a renderer bug; please report it with the render manifest.'],
    });
  }
  ctx.counters.rendered++;
  await tier.put(key, encodeRawFrame(image));
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
  const scene: EvaluatedScene = { ...ctx.scene, nodes: [node] };
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

async function buildGroup(ctx: PlanContext, node: EvaluatedNode, children: readonly LayerPlan[]): Promise<CompositorNode> {
  const childTree = await buildTree(ctx, children);
  let mask: { image: RgbaImage; mode: 'alpha' | 'luminance'; invert: boolean } | undefined;
  if (node.mask !== undefined) {
    // Masken-Node liegt im lokalen Raum der Gruppe (Semantik 1.4); der Compositor transformiert die Maske mit.
    const maskImage = await flattenToImage(ctx, await renderMask(ctx, node.mask.node));
    mask = { image: maskImage, mode: node.mask.mode, invert: node.mask.invert };
  }
  return { kind: 'group', node, children: childTree, ...(mask !== undefined ? { mask } : {}) };
}

async function buildTree(ctx: PlanContext, plan: readonly LayerPlan[]): Promise<CompositorNode[]> {
  const out: CompositorNode[] = [];
  for (const layer of plan) {
    if (layer.kind === 'render') {
      out.push({ kind: 'image', image: await renderLayerCached(ctx, layer.backend, layer.nodes, layer.id) });
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
    const sub = offset === 0 ? ctx.scene : evaluateScene(ctx.project, ctx.compositionId, ctx.scene.frame + offset, { registry: ctx.env.registry });
    const subNode = findNode(sub.nodes, node.id);
    if (subNode === undefined) continue;
    const subCtx: PlanContext = { ...ctx, scene: sub };
    const children = planFrame({ ...sub, nodes: subNode.children }, ctx.env.registry, { renderer2d: renderer2dOf(ctx.project) });
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
  const scene = await time('timelineEvaluator', () => evaluateScene(project, options.compositionId, options.frame, { registry: env.registry }));
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
  const ctx: PlanContext = { env, scene, width: size.width, height: size.height, scale, debug: options.debug, project, compositionId: options.compositionId, counters, signal: options.signal };
  const tree = await time('renderers', () => buildTree(ctx, plan));
  if (options.debug !== undefined && env.overlays !== undefined && Object.values(options.debug).some((v) => v === true)) {
    const overlays = env.overlays;
    const debug = options.debug;
    tree.push({ kind: 'image', image: await time('debugOverlay', () => overlays.debugOverlay(scene, bounds, debug, { ...size, scale })) });
  }
  const settings = isRecord(project['settings']) ? project['settings'] : {};
  const outputSpace = settings['outputColorSpace'] === 'rec709' ? 'rec709' : 'srgb';
  const image = await time('compositor', () =>
    env.composite({
      width: size.width,
      height: size.height,
      scale,
      background: scene.background,
      workingSpace: scene.colorSpace,
      outputSpace,
      layers: tree,
      frame: scene.frame,
      seed: scene.seed,
      effects: env.registry.effects,
      ...(env.resolveLut !== undefined ? { resolveLut: (id: string) => env.resolveLut?.(id) } : {}),
    }),
  );
  if (options.useCache !== false) await time('frameCache', () => tier.put(key, encodeRawFrame(image)));
  env.telemetry.metrics.recordFrameDuration(Object.values(timings).reduce((a, b) => a + b, 0), { composition: scene.compositionId });
  return { image, key, cached: false, scene, bounds, diagnostics, timings, layers: counters };
}
