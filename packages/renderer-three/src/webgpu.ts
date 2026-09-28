/**
 * WebGPU-Backend: `WebGPURenderer` plus TSL-Postprocessing (`RenderPipeline`).
 *
 * Das Bild entsteht in einem eigenen Render Target und wird per `readRenderTargetPixelsAsync`
 * zurückgelesen. Ein direktes `drawImage` des WebGPU-Canvas liefert unter SwiftShader nicht
 * zuverlässig Pixel (Probelauf), daher dieser Weg.
 */
import { OpenVideoError } from '@agentic-video/core';
import { clamp, dot, exp2, float, luminance, mix, pass, renderOutput, screenUV, texture3D, uniform, vec3, vec4 } from 'three/tsl';
import { NoColorSpace, PCFShadowMap, PMREMGenerator, RenderPipeline, RenderTarget, SRGBColorSpace, UnsignedByteType, WebGPURenderer, type Node, type PassNode, type Texture, type UniformNode } from 'three/webgpu';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { lut3D } from 'three/examples/jsm/tsl/display/Lut3DNode.js';
import { depthOfFieldNode } from './dof.js';
import { disposeScene, presetScene, type EnvironmentPreset } from './environment.js';
import type { BuiltScene, PostSpec } from './scene.js';

interface PipelineState {
  readonly key: string;
  readonly pipeline: RenderPipeline;
  readonly scenePass: PassNode;
  readonly u: {
    readonly bloomStrength: UniformNode<'float', number>;
    readonly bloomRadius: UniformNode<'float', number>;
    readonly bloomThreshold: UniformNode<'float', number>;
    readonly focus: UniformNode<'float', number>;
    readonly aperture: UniformNode<'float', number>;
    readonly maxBlur: UniformNode<'float', number>;
    readonly aspect: UniformNode<'float', number>;
    readonly exposure: UniformNode<'float', number>;
    readonly contrast: UniformNode<'float', number>;
    readonly saturation: UniformNode<'float', number>;
    readonly offset: UniformNode<'float', number>;
    readonly darkness: UniformNode<'float', number>;
  };
}

function unavailable(cause?: unknown): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_THREE_BACKEND_UNAVAILABLE',
    errorClass: 'ThreeRendererError',
    problem: 'WebGPU is not available in this browser.',
    details: { backend: 'webgpu' },
    ...(cause !== undefined ? { cause } : {}),
    suggestions: ['Start Chromium with --enable-unsafe-webgpu and serve the page from an HTTP origin.', 'Use backend: "webgl2" or "auto".'],
  });
}

/**
 * Prüft, ob der Browser einen WebGPU-Adapter liefert.
 *
 * @example
 * ```ts
 * if (await webgpuAvailable()) console.info('WebGPU');
 * ```
 */
export async function webgpuAvailable(): Promise<boolean> {
  const gpu: unknown = Reflect.get(navigator, 'gpu');
  if (typeof gpu !== 'object' || gpu === null) return false;
  if (!('requestAdapter' in gpu) || typeof gpu.requestAdapter !== 'function') return false;
  try {
    const adapter: unknown = await Reflect.apply(gpu.requestAdapter, gpu, []);
    return adapter !== null && adapter !== undefined;
  } catch (error) {
    // Ein Fehler beim Anfordern bedeutet: kein WebGPU. Der Aufrufer fällt auf WebGL2 zurück.
    if (error instanceof Error) return false;
    throw error;
  }
}

/** Zeilen einer Rückleseoperation ohne die 256-Byte-Ausrichtung von WebGPU. */
function stripRowPadding(data: ArrayLike<number>, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = width * 4;
  const stride = Math.ceil(rowBytes / 256) * 256;
  const out = new Uint8ClampedArray(new ArrayBuffer(rowBytes * height));
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < rowBytes; i++) out[y * rowBytes + i] = data[y * stride + i] ?? 0;
  }
  return out;
}

function postKey(built: BuiltScene, width: number, height: number): string {
  const p = built.post;
  return JSON.stringify([width, height, built.toneMapping, p.bloom !== undefined, p.depthOfField !== undefined, p.colorGrading !== undefined, p.lut?.url ?? null, p.vignette !== undefined]);
}

function method(obj: object, name: string): (...args: unknown[]) => unknown {
  const fn: unknown = Reflect.get(obj, name);
  if (typeof fn !== 'function') {
    throw new OpenVideoError({
      code: 'OV_THREE_INTERNAL',
      errorClass: 'ThreeRendererError',
      problem: `The Three.js WebGPU renderer has no animation method "${name}"; this Three.js version is not supported.`,
      suggestions: ['Use the Three.js version from package.json of @agentic-video/renderer-three.', 'Use backend: "webgl2".'],
    });
  }
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(fn, obj, args);
    return result;
  };
}

/**
 * Übernimmt die interne Animationsschleife des `WebGPURenderer`.
 *
 * Three.js zählt Frames für Effekt-Knoten (`updateBefore` pro Frame, z. B. Bloom und Depth of Field)
 * in einer eigenen `requestAnimationFrame`-Schleife. Das hinge von der Browser-Uhr ab und
 * steht still, wenn der Host die Zeit virtualisiert. Diese Funktion ersetzt den Kontext der
 * Schleife durch einen, der nur auf Aufruf weiterzählt.
 *
 * @returns Funktion, die genau einen Frame weiterzählt.
 */
function manualFrameLoop(renderer: WebGPURenderer): () => void {
  const animation: unknown = Reflect.get(renderer, '_animation');
  if (typeof animation !== 'object' || animation === null) {
    throw new OpenVideoError({
      code: 'OV_THREE_INTERNAL',
      errorClass: 'ThreeRendererError',
      problem: 'The Three.js WebGPU renderer has no internal animation loop; this Three.js version is not supported.',
      suggestions: ['Use the Three.js version from package.json of @agentic-video/renderer-three.', 'Use backend: "webgl2".'],
    });
  }
  let pending: ((time: number) => void) | undefined;
  const context = {
    requestAnimationFrame: (cb: (time: number) => void): number => {
      pending = cb;
      return 1;
    },
    cancelAnimationFrame: (): void => {
      pending = undefined;
    },
  };
  method(animation, 'stop')();
  method(animation, 'setContext')(context);
  method(animation, 'start')();
  return () => {
    const cb = pending;
    pending = undefined;
    cb?.(0);
  };
}

/**
 * Rendert Szenen mit dem `WebGPURenderer` von Three.js.
 *
 * @example
 * ```ts
 * const backend = await WebGPUBackend.create(true);
 * await backend.render(built, 640, 360, ctx2d);
 * ```
 */
export class WebGPUBackend {
  readonly kind = 'webgpu';
  private readonly pmrem: PMREMGenerator;
  private readonly presets = new Map<EnvironmentPreset, Texture>();
  private target: RenderTarget | undefined;
  private state: PipelineState | undefined;

  private readonly tick: () => void;

  private constructor(private readonly renderer: WebGPURenderer) {
    this.pmrem = new PMREMGenerator(renderer);
    this.tick = manualFrameLoop(renderer);
  }

  /** Erzeugt und initialisiert das Backend; wirft `OV_THREE_BACKEND_UNAVAILABLE` ohne WebGPU. */
  static async create(antialias: boolean): Promise<WebGPUBackend> {
    if (!(await webgpuAvailable())) throw unavailable();
    const renderer = new WebGPURenderer({ alpha: true, antialias });
    try {
      await renderer.init();
    } catch (error) {
      throw unavailable(error);
    }
    // Ohne WebGPU fällt Three.js still auf WebGL2 zurück; das wäre eine falsche Backend-Angabe.
    if (!('isWebGPUBackend' in renderer.backend)) {
      void renderer.dispose();
      throw unavailable();
    }
    renderer.setPixelRatio(1);
    return new WebGPUBackend(renderer);
  }

  /** Umgebungstextur eines Presets (einmal pro Backend erzeugt). */
  presetEnvironment(preset: EnvironmentPreset): Promise<Texture> {
    let tex = this.presets.get(preset);
    if (tex === undefined) {
      const scene = presetScene(preset);
      tex = this.pmrem.fromScene(scene, 0.04).texture;
      disposeScene(scene);
      this.presets.set(preset, tex);
    }
    return Promise.resolve(tex);
  }

  /** Rendert eine Szene und zeichnet das Ergebnis in `out` (Größe `width × height`). */
  async render(built: BuiltScene, width: number, height: number, out: CanvasRenderingContext2D): Promise<void> {
    const r = this.renderer;
    r.setSize(width, height, false);
    r.shadowMap.enabled = built.shadows;
    r.shadowMap.type = PCFShadowMap;
    r.setClearColor(built.clearColor, built.clearAlpha);
    if (this.target?.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new RenderTarget(width, height, { type: UnsignedByteType, depthBuffer: false });
      this.target.texture.colorSpace = NoColorSpace;
    }
    const key = postKey(built, width, height);
    const fresh = this.state?.key !== key;
    if (fresh) {
      this.state?.pipeline.dispose();
      this.state = this.createPipeline(built, key);
    }
    const s = this.state;
    if (s === undefined) throw unavailable();
    s.scenePass.scene = built.scene;
    s.scenePass.camera = built.camera;
    this.updateUniforms(s, built.post, width, height);
    r.setRenderTarget(this.target);
    // Effekt-Knoten (z. B. Depth of Field) lesen ihre Größe erst nach dem ersten Durchlauf.
    // Ein Vorlauf pro neuer Pipeline macht das Ergebnis unabhängig von vorherigen Frames.
    if (fresh) {
      this.tick();
      s.pipeline.render();
    }
    this.tick();
    s.pipeline.render();
    r.setRenderTarget(null);
    const pixels = await r.readRenderTargetPixelsAsync(this.target, 0, 0, width, height);
    out.clearRect(0, 0, width, height);
    out.putImageData(new ImageData(stripRowPadding(pixels, width, height), width, height), 0, 0);
  }

  private updateUniforms(s: PipelineState, post: PostSpec, width: number, height: number): void {
    if (post.bloom !== undefined) {
      s.u.bloomStrength.value = post.bloom.strength;
      s.u.bloomRadius.value = post.bloom.radius;
      s.u.bloomThreshold.value = post.bloom.threshold;
    }
    if (post.depthOfField !== undefined) {
      s.u.focus.value = post.depthOfField.focus;
      s.u.aperture.value = post.depthOfField.aperture;
      s.u.maxBlur.value = post.depthOfField.maxBlur;
      s.u.aspect.value = width / height;
    }
    if (post.colorGrading !== undefined) {
      s.u.exposure.value = post.colorGrading.exposure;
      s.u.contrast.value = post.colorGrading.contrast;
      s.u.saturation.value = post.colorGrading.saturation;
    }
    if (post.vignette !== undefined) {
      s.u.offset.value = post.vignette.offset;
      s.u.darkness.value = post.vignette.darkness;
    }
  }

  private createPipeline(built: BuiltScene, key: string): PipelineState {
    const post = built.post;
    const u = {
      bloomStrength: uniform(1),
      bloomRadius: uniform(0.4),
      bloomThreshold: uniform(0.85),
      focus: uniform(10),
      aperture: uniform(0.025),
      maxBlur: uniform(0.01),
      aspect: uniform(1),
      exposure: uniform(0),
      contrast: uniform(1),
      saturation: uniform(1),
      offset: uniform(1),
      darkness: uniform(1),
    };
    const scenePass = pass(built.scene, built.camera);
    // Reihenfolge wie im WebGL2-Backend: Tiefenunschärfe → Bloom → Tone Mapping.
    let color: Node<'vec4'> = post.depthOfField !== undefined ? depthOfFieldNode(scenePass, u) : scenePass.getTextureNode('output');
    if (post.bloom !== undefined) {
      const glow = bloom(color, u.bloomStrength, u.bloomRadius, u.bloomThreshold);
      color = vec4(color.rgb.add(glow.rgb), color.a);
    }
    color = renderOutput(color, built.toneMapping, SRGBColorSpace);
    if (post.colorGrading !== undefined) {
      let rgb = color.rgb.mul(exp2(u.exposure));
      rgb = rgb.sub(0.5).mul(u.contrast).add(0.5);
      rgb = mix(vec3(luminance(rgb)), rgb, u.saturation);
      color = vec4(clamp(rgb, 0, 1), color.a);
    }
    if (post.vignette !== undefined) {
      const d = screenUV.sub(0.5).mul(u.offset);
      color = vec4(mix(color.rgb, vec3(float(1).sub(u.darkness)), dot(d, d)), color.a);
    }
    // Reihenfolge wie im WebGL2-Backend: Tone Mapping → Grading → Vignette → LUT.
    let output: Node = color;
    if (post.lut !== undefined) output = lut3D(color, texture3D(post.lut.texture), post.lut.size, float(1));
    const pipeline = new RenderPipeline(this.renderer, output);
    pipeline.outputColorTransform = false;
    return { key, pipeline, scenePass, u };
  }

  /** Gibt Renderer, Pipeline und Preset-Texturen frei. */
  dispose(): void {
    this.state?.pipeline.dispose();
    this.state = undefined;
    this.target?.dispose();
    for (const t of this.presets.values()) t.dispose();
    this.presets.clear();
    this.pmrem.dispose();
    void this.renderer.dispose();
  }
}
