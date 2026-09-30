/**
 * `ThreeLayerRenderer`: rendert eine `scene3d`-Node in ein Canvas (FR-38..FR-42).
 * Läuft nur im Browser (Chromium-Render-Host oder Studio).
 */
import { OpenVideoError } from '@agentic-video/core';
import { ThreeAssets } from './assets.js';
import { requiresWebGL2 } from './check.js';
import { buildScene, outputSize, wantsAntialias, type ThreeLayerInput } from './scene.js';
import { WebGLBackend } from './webgl.js';
import { WebGPUBackend, webgpuAvailable } from './webgpu.js';

/** Gewünschtes Backend. `auto` bevorzugt WebGPU und fällt auf WebGL2 zurück. */
export type ThreeBackendPreference = 'auto' | 'webgpu' | 'webgl2';

type Backend = WebGLBackend | WebGPUBackend;

/**
 * Rendert `scene3d`-Nodes mit Three.js.
 *
 * - Zeit kommt nur aus der Eingabe (`frame`, `time`, lokale Zeiten der Nodes); es gibt keine Uhr
 *   und kein `requestAnimationFrame`. Die Szene wird pro Aufruf neu aufgebaut, daher hängt
 *   Frame n nie von Frame n−1 ab.
 * - Backend: Node-Property `backend`, sonst `preferredBackend` des Konstruktors. `auto` nutzt
 *   WebGPU, außer die Szene braucht WebGL2 (GLSL-Shader) oder WebGPU fehlt.
 * - Bildtexturen werden gegen das GPU-Maximum geprüft (`OV_THREE_TEXTURE_TOO_LARGE`); mit
 *   `textureDownscale` (Node) bzw. `downscaleTextures` (Option) werden sie verkleinert.
 * - Ergebnis: ein neues 2D-Canvas `width·scale × height·scale`, transparent ohne `background`.
 *   Die Pixel im Canvas sind wie bei jedem 2D-Canvas vormultipliziert gespeichert.
 *
 * @example
 * ```ts
 * const renderer = new ThreeLayerRenderer({ preferredBackend: 'auto' });
 * const canvas = await renderer.render({ node, width: 640, height: 360, scale: 1, frame: 12, time: 0.4, fps: 30, seed: 1, assetUrl: (id) => `/assets/${id}` });
 * ```
 */
export class ThreeLayerRenderer {
  private readonly preferred: ThreeBackendPreference;
  private readonly assets = new ThreeAssets();
  private readonly backends = new Map<string, Promise<Backend>>();
  private webgpuOk: Promise<boolean> | undefined;
  private active: 'webgpu' | 'webgl2' | undefined;

  private readonly downscaleTextures: boolean;
  private readonly maxTextureSize: number | undefined;

  /**
   * @param options.preferredBackend Standard-Backend (`auto`).
   * @param options.downscaleTextures Zu große Bildtexturen verkleinern statt `OV_THREE_TEXTURE_TOO_LARGE`
   *   zu werfen (Standard `false`; die Node-Property `textureDownscale` hat Vorrang).
   * @param options.maxTextureSize Obergrenze der Texturkante zusätzlich zum GPU-Maximum, z. B. um
   *   Speicher zu begrenzen.
   */
  constructor(options?: { preferredBackend?: ThreeBackendPreference; downscaleTextures?: boolean; maxTextureSize?: number }) {
    this.preferred = options?.preferredBackend ?? 'auto';
    this.downscaleTextures = options?.downscaleTextures ?? false;
    this.maxTextureSize = options?.maxTextureSize;
  }

  /** Backend des letzten Renderaufrufs, vorher `undefined`. */
  get activeBackend(): 'webgpu' | 'webgl2' | undefined {
    return this.active;
  }

  /** Rendert einen Frame der Szene. */
  async render(input: ThreeLayerInput): Promise<HTMLCanvasElement> {
    if (input.node.type !== 'scene3d') {
      throw new OpenVideoError({
        code: 'OV_THREE_NODE_TYPE',
        errorClass: 'ThreeRendererError',
        problem: `The Three.js renderer renders only "scene3d" nodes, not "${input.node.type}".`,
        nodeId: input.node.id,
        suggestions: ['Pass the scene3d node itself as input.node.'],
      });
    }
    const kind = await this.chooseBackend(input);
    const antialias = wantsAntialias(input.node);
    const backend = await this.backend(kind, antialias);
    const prop = input.node.props['textureDownscale'];
    const gpuMax = backend.maxTextureSize;
    const textureLimit = { maxSize: this.maxTextureSize === undefined ? gpuMax : Math.min(gpuMax, this.maxTextureSize), downscale: typeof prop === 'boolean' ? prop : this.downscaleTextures };
    const built = await buildScene(input, this.assets, (preset) => backend.presetEnvironment(preset), textureLimit);
    const { width, height } = outputSize(input);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new OpenVideoError({ code: 'OV_THREE_CANVAS', errorClass: 'ThreeRendererError', problem: 'Could not create a 2D canvas context for the output.', suggestions: ['Reduce the output size.'] });
    }
    try {
      await backend.render(built, width, height, ctx);
    } finally {
      for (const d of built.disposables) d.dispose();
    }
    this.active = kind;
    return canvas;
  }

  private async chooseBackend(input: ThreeLayerInput): Promise<'webgpu' | 'webgl2'> {
    const prop = input.node.props['backend'];
    const wanted: ThreeBackendPreference = prop === 'webgpu' || prop === 'webgl2' ? prop : prop === 'auto' ? 'auto' : this.preferred;
    if (wanted === 'webgl2') return 'webgl2';
    if (wanted === 'webgpu') {
      if (requiresWebGL2({ children: input.node.children.map(toRaw) })) {
        throw new OpenVideoError({
          code: 'OV_THREE_BACKEND_FEATURE',
          errorClass: 'ThreeRendererError',
          problem: 'GLSL shader materials need the WebGL2 backend; the WebGPU backend cannot compile GLSL.',
          nodeId: input.node.id,
          suggestions: ['Set backend: "webgl2" or "auto" on the scene3d node.'],
        });
      }
      return 'webgpu';
    }
    if (requiresWebGL2({ children: input.node.children.map(toRaw) })) return 'webgl2';
    this.webgpuOk ??= webgpuAvailable();
    return (await this.webgpuOk) ? 'webgpu' : 'webgl2';
  }

  private backend(kind: 'webgpu' | 'webgl2', antialias: boolean): Promise<Backend> {
    const key = `${kind}:${String(antialias)}`;
    let p = this.backends.get(key);
    if (p === undefined) {
      p = kind === 'webgpu' ? WebGPUBackend.create(antialias) : Promise.resolve(new WebGLBackend(antialias));
      // Ein fehlgeschlagener Start soll beim nächsten Aufruf neu versucht werden.
      p.catch(() => this.backends.delete(key));
      this.backends.set(key, p);
    }
    return p;
  }

  /** Gibt alle GPU-Ressourcen und zwischengespeicherten Assets frei. */
  dispose(): void {
    const backends = [...this.backends.values()];
    this.backends.clear();
    for (const p of backends) {
      p.then(
        (b) => {
          b.dispose();
        },
        () => undefined,
      );
    }
    void this.assets.dispose();
  }
}

/** Ausgewertete Node als rohe Struktur für die reinen Prüffunktionen. */
function toRaw(node: ThreeLayerInput['node']): Record<string, unknown> {
  return { ...node.props, id: node.id, type: node.type, children: node.children.map(toRaw) };
}
