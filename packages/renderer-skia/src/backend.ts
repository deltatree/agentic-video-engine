/**
 * Das Skia-Backend (id `skia`): implementiert `RenderBackend` auf CanvasKit.
 */
import type { CanvasKit, Image, RuntimeEffect, SkottieAnimation } from 'canvaskit-wasm';
import {
  OpenVideoError,
  computeBounds,
  getNumber,
  isRecord,
  toSeconds,
  type AssetRecord,
  type BackendCheck,
  type Diagnostic,
  type EvaluatedNode,
  type FontResolver,
  type LayerRequest,
  type RenderBackend,
  type RgbaImage,
  type TimeValue,
} from '@agentic-video/core';
import { drawDebugOverlay } from './debug.js';
import { drawNode, localSeconds, walkNodes, type DrawContext, type FrameResources } from './draw.js';
import { imageFromRgba, makeSurface, rgbaFromSurface } from './image.js';
import { Scope, nullable } from './scope.js';
import { parseSvg, type SvgDocument } from './svg.js';
import { TextEngine, createSkiaTextMeasurer } from './text.js';

/** Node-Typen, die das Skia-Backend direkt rendert. */
export const SKIA_NODE_TYPES: readonly string[] = ['group', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'rich-text', 'image', 'video', 'svg', 'sprite', 'lottie', 'shader', 'particles'];

/** Benannte Fähigkeiten des Skia-Backends. */
export const SKIA_CAPABILITIES: readonly string[] = [
  'skia.text.shaping',
  'skia.text.variable-fonts',
  'skia.text.emoji',
  'skia.text.bidi',
  'skia.text.path',
  'skia.text.animation',
  'skia.gradients',
  'skia.filters',
  'skia.blend.all',
  'skia.mask',
  'skia.svg',
  'skia.lottie',
  'skia.sksl',
  'skia.particles',
  'skia.video',
];

/** Version von CanvasKit, gegen die dieses Paket gebaut ist. */
export const CANVASKIT_VERSION = '0.42.0';

/** Optionen für {@link createSkiaBackend}. */
export interface SkiaBackendOptions {
  /** Initialisiertes CanvasKit (im Browser selbst laden, in Node mit `loadCanvasKitNode()`). */
  readonly canvasKit: CanvasKit;
  readonly fonts: FontResolver;
  /** Standardschrift (`settings.defaultFont`), sonst `Inter`. */
  readonly defaultFont?: string;
}

function missingAsset(assetId: string, node: EvaluatedNode): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_ASSET_MISSING',
    errorClass: 'AssetError',
    problem: `Asset "${assetId}" is not known to the asset resolver.`,
    nodeId: node.id,
    pointer: `${node.pointer}/asset`,
    details: { asset: assetId },
    suggestions: [`Add { id: "${assetId}", type: …, src: … } to project.assets.`, 'Check the spelling of the asset id.'],
  });
}

function diag(code: string, severity: Diagnostic['severity'], problem: string, suggestions: string[], extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity, errorClass: 'SkiaRendererError', problem, suggestions, ...extra };
}

/**
 * Erzeugt das Skia-Backend. Es ist isomorph (Node und Browser) und deterministisch:
 * gleiche Eingabe ergibt bitgleiche Pixel.
 *
 * @example
 * ```ts
 * const ck = await loadCanvasKitNode();
 * const fonts = await loadFontSet({ fonts: project.fonts });
 * const skia = createSkiaBackend({ canvasKit: ck, fonts });
 * const image = await skia.renderLayer(request);
 * ```
 */
export function createSkiaBackend(options: SkiaBackendOptions): RenderBackend {
  const ck = options.canvasKit;
  const engines = new Map<FontResolver, TextEngine>();
  const images = new Map<string, Image>();
  const animations = new Map<string, SkottieAnimation>();
  const svgCache = new Map<string, SvgDocument>();
  const effects = new Map<string, RuntimeEffect | string>();

  const engineFor = (fonts: FontResolver): TextEngine => {
    let e = engines.get(fonts);
    if (e === undefined) {
      e = new TextEngine(ck, fonts, options.defaultFont);
      engines.set(fonts, e);
    }
    return e;
  };

  /** Kompiliert SkSL einmal; Fehler als Text. */
  const compile = (sksl: string): RuntimeEffect | string => {
    const cached = effects.get(sksl);
    if (cached !== undefined) return cached;
    let message = 'unknown error';
    const effect = nullable(ck.RuntimeEffect.Make(sksl, (err) => { message = err; }));
    const result = effect ?? message;
    effects.set(sksl, result);
    return result;
  };

  const effectFor = (sksl: string, node: EvaluatedNode): RuntimeEffect => {
    const result = compile(sksl);
    if (typeof result === 'string') {
      throw new OpenVideoError({
        code: 'OV_SKIA_SHADER_INVALID',
        errorClass: 'SkiaRendererError',
        problem: 'The SkSL shader does not compile.',
        nodeId: node.id,
        pointer: `${node.pointer}/sksl`,
        details: { compiler: result.slice(0, 500) },
        suggestions: ['Fix the SkSL source; the entry point is `half4 main(float2 coord)`.', 'Declare uniforms as `uniform float time; uniform float2 resolution;`.'],
      });
    }
    return result;
  };

  const record = (req: LayerRequest, node: EvaluatedNode): AssetRecord => {
    const id = node.props['asset'];
    const rec = typeof id === 'string' ? req.assets.get(id) : undefined;
    if (rec === undefined) throw missingAsset(String(id), node);
    return rec;
  };

  const loadImage = async (req: LayerRequest, node: EvaluatedNode): Promise<Image> => {
    const rec = record(req, node);
    const key = `${rec.id}@${rec.hash}`;
    const hit = images.get(key);
    if (hit !== undefined) return hit;
    const img = nullable(ck.MakeImageFromEncoded(await req.assets.bytes(rec.id)));
    if (img === null) {
      throw new OpenVideoError({ code: 'OV_IMAGE_DECODE', errorClass: 'ImageError', problem: `Asset "${rec.id}" cannot be decoded as an image.`, nodeId: node.id, details: { asset: rec.id, path: rec.path }, suggestions: ['Use PNG, JPEG, WebP or GIF.', 'Re-import the asset.'] });
    }
    images.set(key, img);
    return img;
  };

  const loadLottie = async (req: LayerRequest, node: EvaluatedNode): Promise<SkottieAnimation> => {
    const rec = record(req, node);
    const key = `${rec.id}@${rec.hash}`;
    const hit = animations.get(key);
    if (hit !== undefined) return hit;
    const json = new TextDecoder().decode(await req.assets.bytes(rec.id));
    const anim = nullable(ck.MakeAnimation(json));
    if (anim === null) {
      throw new OpenVideoError({ code: 'OV_LOTTIE_INVALID', errorClass: 'SkiaRendererError', problem: `Asset "${rec.id}" is not a valid Lottie animation.`, nodeId: node.id, details: { asset: rec.id }, suggestions: ['Export the animation again as Lottie JSON (bodymovin).'] });
    }
    animations.set(key, anim);
    return anim;
  };

  const loadSvg = async (req: LayerRequest, node: EvaluatedNode): Promise<SvgDocument | undefined> => {
    const markup = node.props['markup'];
    let key: string;
    let text: string | undefined;
    if (typeof markup === 'string') {
      key = `markup:${markup}`;
      text = markup;
    } else if (node.props['asset'] !== undefined) {
      const rec = record(req, node);
      key = `asset:${rec.id}@${rec.hash}`;
      if (!svgCache.has(key)) text = new TextDecoder().decode(await req.assets.bytes(rec.id));
    } else {
      return undefined;
    }
    let doc = svgCache.get(key);
    if (doc === undefined && text !== undefined) {
      doc = parseSvg(text);
      svgCache.set(key, doc);
    }
    return doc;
  };

  const videoSeconds = (req: LayerRequest, node: EvaluatedNode, rec: AssetRecord): number => {
    const fps = req.scene.fps;
    const start = node.props['startFrom'];
    const startFrom = typeof start === 'number' || typeof start === 'string' ? toSeconds(start satisfies TimeValue, { fps }) : 0;
    let t = startFrom + localSeconds(node, fps) * getNumber(node, 'playbackRate', 1);
    const duration = rec.duration;
    if (duration !== undefined && duration > 0) {
      if (node.props['loop'] === true) t = ((t % duration) + duration) % duration;
      else t = Math.min(Math.max(t, 0), duration);
    }
    return Math.max(0, t);
  };

  /** Lädt alle Assets eines Layers vorab (asynchron), damit das Zeichnen synchron bleibt. */
  const prepare = async (req: LayerRequest, scope: Scope): Promise<FrameResources> => {
    const res = { images: new Map<string, Image>(), videoFrames: new Map<EvaluatedNode, Image>(), lottie: new Map<string, SkottieAnimation>(), svgs: new Map<EvaluatedNode, SvgDocument>() };
    const nodes: EvaluatedNode[] = [];
    walkNodes(req.nodes, (n) => nodes.push(n));
    for (const node of nodes) {
      switch (node.type) {
        case 'image':
        case 'sprite':
          res.images.set(String(node.props['asset']), await loadImage(req, node));
          break;
        case 'lottie':
          res.lottie.set(String(node.props['asset']), await loadLottie(req, node));
          break;
        case 'svg': {
          const doc = await loadSvg(req, node);
          if (doc !== undefined) res.svgs.set(node, doc);
          break;
        }
        case 'video': {
          const rec = record(req, node);
          const frame: RgbaImage = await req.assets.videoFrame(rec.id, videoSeconds(req, node, rec));
          res.videoFrames.set(node, scope.add(imageFromRgba(ck, frame)));
          break;
        }
        default:
          break;
      }
    }
    return res;
  };

  const check = (node: Readonly<Record<string, unknown>>): BackendCheck => {
    const type = typeof node['type'] === 'string' ? node['type'] : '';
    const nodeId = typeof node['id'] === 'string' ? node['id'] : undefined;
    const at = nodeId !== undefined ? { nodeId } : {};
    const diagnostics: Diagnostic[] = [];
    if (!SKIA_NODE_TYPES.includes(type)) {
      diagnostics.push(diag('OV_SKIA_UNSUPPORTED', 'error', `The Skia renderer cannot draw nodes of type "${type}".`, ['Remove `renderer: "skia"` so the default backend for this type is used.', 'Use a supported 2D node type.'], at));
      return { supported: false, diagnostics };
    }
    if (type === 'shader') {
      const sksl = node['sksl'];
      if (typeof sksl !== 'string') {
        const hasGlsl = typeof node['glsl'] === 'string';
        diagnostics.push(
          diag('OV_SKIA_UNSUPPORTED', 'error', hasGlsl ? 'The shader has only GLSL source; Skia needs SkSL.' : 'The shader has no SkSL source.', ['Add an `sksl` source with `half4 main(float2 coord)`.', 'Set `renderer: "pixi"` to render the GLSL source with PixiJS.'], { ...at, path: 'sksl' }),
        );
        return { supported: false, diagnostics };
      }
      const compiled = compile(sksl);
      if (typeof compiled === 'string') {
        diagnostics.push(diag('OV_SKIA_SHADER_INVALID', 'error', 'The SkSL shader does not compile.', ['Fix the SkSL source; the entry point is `half4 main(float2 coord)`.'], { ...at, path: 'sksl', details: { compiler: compiled.slice(0, 500) } }));
        return { supported: false, diagnostics };
      }
    }
    if (type === 'svg' && typeof node['markup'] === 'string') {
      const doc = parseSvg(node['markup']);
      if (doc.unsupported.length > 0) {
        diagnostics.push(
          diag('OV_SVG_UNSUPPORTED', 'warning', `SVG elements are not supported and are skipped: ${doc.unsupported.join(', ')}.`, ['Convert these elements to paths, e.g. with `svgo --config` or by flattening in the design tool.', 'Render the SVG as an image asset instead.'], { ...at, path: 'markup', details: { elements: doc.unsupported.join(',') } }),
        );
      }
    }
    if (type === 'text' || type === 'rich-text') {
      const families = new Set<string>();
      if (typeof node['fontFamily'] === 'string') families.add(node['fontFamily']);
      const spans = node['spans'];
      if (Array.isArray(spans)) for (const s of spans) if (isRecord(s) && typeof s['fontFamily'] === 'string') families.add(s['fontFamily']);
      const fallback = engineFor(options.fonts).defaultFamily;
      for (const f of families) {
        if (!options.fonts.has(f)) {
          diagnostics.push(diag('OV_FONT_MISSING', 'warning', `Font family "${f}" is not loaded; "${fallback}" is used instead.`, [`Add { "family": "${f}", "src": "fonts/${f.replace(/\s+/gu, '')}.ttf" } to project.fonts.`, `Use fontFamily "${fallback}".`], { ...at, path: 'fontFamily', received: JSON.stringify(f) }));
        }
      }
    }
    return { supported: true, diagnostics };
  };

  return {
    id: 'skia',
    nodeTypes: SKIA_NODE_TYPES,
    capabilities: SKIA_CAPABILITIES,
    fusable: true,
    versions: () => ({ 'canvaskit-wasm': CANVASKIT_VERSION }),
    check,
    async renderLayer(req: LayerRequest): Promise<RgbaImage> {
      const scope = new Scope();
      try {
        const text = engineFor(req.fonts);
        const resources = await prepare(req, scope);
        if (req.signal?.aborted === true) throw new OpenVideoError({ code: 'OV_RENDER_ABORTED', errorClass: 'SkiaRendererError', problem: 'Rendering was aborted.', suggestions: ['Start the render again.'] });
        const surface = scope.add(makeSurface(ck, req.width, req.height));
        const canvas = surface.getCanvas();
        canvas.clear(ck.TRANSPARENT);
        canvas.scale(req.scale, req.scale);
        const ctx: DrawContext = { ck, scope, text, scene: req.scene, resources, effect: effectFor, signal: req.signal, layouts: new Map() };
        for (const node of req.nodes) drawNode(canvas, node, ctx);
        const debug = req.debug;
        if (debug !== undefined && Object.values(debug).some((v) => v === true)) {
          const measurer = createSkiaTextMeasurer(ck, req.fonts, options.defaultFont);
          try {
            const bounds = computeBounds({ ...req.scene, nodes: req.nodes }, measurer);
            drawDebugOverlay(ck, canvas, text, { ...req.scene, nodes: req.nodes }, bounds, debug, scope);
          } finally {
            measurer.dispose();
          }
        }
        return rgbaFromSurface(ck, surface);
      } finally {
        scope.dispose();
      }
    },
    dispose(): Promise<void> {
      for (const e of engines.values()) e.dispose();
      engines.clear();
      for (const img of images.values()) img.delete();
      images.clear();
      for (const a of animations.values()) a.delete();
      animations.clear();
      for (const e of effects.values()) if (typeof e !== 'string') e.delete();
      effects.clear();
      svgCache.clear();
      return Promise.resolve();
    },
  };
}
