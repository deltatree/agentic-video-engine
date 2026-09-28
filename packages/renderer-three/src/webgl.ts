/**
 * WebGL2-Backend: `WebGLRenderer` plus `EffectComposer` für Postprocessing.
 */
import { OpenVideoError } from '@agentic-video/core';
import { ACESFilmicToneMapping, AgXToneMapping, HalfFloatType, LinearSRGBColorSpace, NeutralToneMapping, NoToneMapping, PCFShadowMap, PMREMGenerator, Vector2, WebGLRenderTarget, WebGLRenderer, type ShaderMaterial, type Texture, type ToneMapping } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { LUTPass } from 'three/examples/jsm/postprocessing/LUTPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { DepthOfFieldPass } from './dof.js';
import { disposeScene, presetScene, type EnvironmentPreset } from './environment.js';
import type { BuiltScene, PostSpec } from './scene.js';

const VERTEX = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\n';

/** Farbkorrektur im Anzeige-Raum (nach Tone Mapping): Belichtung, Kontrast, Sättigung. */
const GRADING_SHADER = {
  name: 'OpenVideoGrading',
  uniforms: { tDiffuse: { value: null }, exposure: { value: 0 }, contrast: { value: 1 }, saturation: { value: 1 } },
  vertexShader: VERTEX,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float exposure; uniform float contrast; uniform float saturation; varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 rgb = c.rgb * exp2(exposure);
  rgb = (rgb - 0.5) * contrast + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, saturation);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`,
};

/** Vignette wie `VignetteShader` von Three.js. */
const VIGNETTE_SHADER = {
  name: 'OpenVideoVignette',
  uniforms: { tDiffuse: { value: null }, offset: { value: 1 }, darkness: { value: 1 } },
  vertexShader: VERTEX,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float offset; uniform float darkness; varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 uv = (vUv - vec2(0.5)) * vec2(offset);
  gl_FragColor = vec4(mix(c.rgb, vec3(1.0 - darkness), dot(uv, uv)), c.a);
}`,
};

function setUniform(material: ShaderMaterial, name: string, value: unknown): void {
  const u = material.uniforms[name];
  if (u !== undefined) u.value = value;
}

interface ComposerState {
  readonly key: string;
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloom?: UnrealBloomPass;
  readonly dof?: DepthOfFieldPass;
  readonly grading?: ShaderPass;
  readonly lut?: LUTPass;
  readonly vignette?: ShaderPass;
}

/**
 * Tone Mapping und sRGB-Kodierung am Ende der linearen Kette. Der Renderer selbst arbeitet mit
 * linearem Ausgabe-Farbraum und ohne Tone Mapping; nur dieser Pass kodiert.
 */
function createOutputPass(toneMapping: ToneMapping): ShaderPass {
  let mapping = '';
  if (toneMapping === ACESFilmicToneMapping) mapping = 'c.rgb = ACESFilmicToneMapping(c.rgb);';
  else if (toneMapping === AgXToneMapping) mapping = 'c.rgb = AgXToneMapping(c.rgb);';
  else if (toneMapping === NeutralToneMapping) mapping = 'c.rgb = NeutralToneMapping(c.rgb);';
  return new ShaderPass({
    name: 'OpenVideoOutput',
    uniforms: { tDiffuse: { value: null }, toneMappingExposure: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: `#include <tonemapping_pars_fragment>
uniform sampler2D tDiffuse; varying vec2 vUv;
vec3 srgbEncode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  ${mapping}
  gl_FragColor = vec4(srgbEncode(clamp(c.rgb, 0.0, 1.0)), c.a);
}`,
  });
}

function postKey(post: PostSpec, width: number, height: number, toneMapping: ToneMapping): string {
  return JSON.stringify([width, height, toneMapping, post.bloom !== undefined, post.depthOfField !== undefined, post.colorGrading !== undefined, post.lut?.url ?? null, post.vignette !== undefined]);
}

/**
 * Rendert Szenen mit dem `WebGLRenderer` von Three.js in ein eigenes Canvas.
 *
 * @example
 * ```ts
 * const backend = new WebGLBackend(true);
 * await backend.render(built, 640, 360, ctx2d);
 * ```
 */
export class WebGLBackend {
  readonly kind = 'webgl2';
  private readonly renderer: WebGLRenderer;
  private readonly pmrem: PMREMGenerator;
  private readonly presets = new Map<EnvironmentPreset, Texture>();
  private composer: ComposerState | undefined;

  constructor(private readonly antialias: boolean) {
    const canvas = document.createElement('canvas');
    try {
      this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias, preserveDrawingBuffer: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    } catch (error) {
      throw new OpenVideoError({
        code: 'OV_THREE_BACKEND_UNAVAILABLE',
        errorClass: 'ThreeRendererError',
        problem: 'WebGL2 is not available in this browser.',
        details: { backend: 'webgl2' },
        cause: error,
        suggestions: ['Start Chromium with --use-angle=swiftshader --enable-unsafe-swiftshader.', 'Use backend: "webgpu".'],
      });
    }
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.pmrem = new PMREMGenerator(this.renderer);
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
  render(built: BuiltScene, width: number, height: number, out: CanvasRenderingContext2D): Promise<void> {
    const r = this.renderer;
    r.setSize(width, height, false);
    r.shadowMap.enabled = built.shadows;
    r.shadowMap.type = PCFShadowMap;
    // Tone Mapping und sRGB-Kodierung macht nur der Ausgabe-Pass; der Renderer selbst bleibt neutral.
    r.toneMapping = NoToneMapping;
    r.setClearColor(built.clearColor, built.clearAlpha);
    // Immer über den Composer: So behandelt WebGL2 Hintergrund und Tone Mapping genau wie WebGPU.
    this.renderChain(built, width, height);
    out.clearRect(0, 0, width, height);
    out.drawImage(r.domElement, 0, 0);
    return Promise.resolve();
  }

  private renderChain(built: BuiltScene, width: number, height: number): void {
    const post = built.post;
    const key = postKey(post, width, height, built.toneMapping);
    if (this.composer?.key !== key) {
      this.composer?.composer.dispose();
      this.composer = this.createComposer(post, key, width, height, built);
    }
    const s = this.composer;
    s.renderPass.scene = built.scene;
    s.renderPass.camera = built.camera;
    s.renderPass.clearAlpha = built.clearAlpha;
    s.renderPass.clearColor = built.clearColor;
    if (s.bloom !== undefined && post.bloom !== undefined) {
      s.bloom.strength = post.bloom.strength;
      s.bloom.radius = post.bloom.radius;
      s.bloom.threshold = post.bloom.threshold;
    }
    if (s.dof !== undefined && post.depthOfField !== undefined) {
      s.dof.scene = built.scene;
      s.dof.camera = built.camera;
      s.dof.setParams(post.depthOfField, width, height);
    }
    if (s.grading !== undefined && post.colorGrading !== undefined) {
      setUniform(s.grading.material, 'exposure', post.colorGrading.exposure);
      setUniform(s.grading.material, 'contrast', post.colorGrading.contrast);
      setUniform(s.grading.material, 'saturation', post.colorGrading.saturation);
    }
    if (s.vignette !== undefined && post.vignette !== undefined) {
      setUniform(s.vignette.material, 'offset', post.vignette.offset);
      setUniform(s.vignette.material, 'darkness', post.vignette.darkness);
    }
    // Die Kette bleibt linear und ohne Tone Mapping des Renderers; sonst kodiert Three.js den
    // letzten Pass zusätzlich (Probelauf: doppelte sRGB-Kodierung). Kodiert wird genau einmal
    // im Ausgabe-Pass.
    s.composer.render();
  }

  private createComposer(post: PostSpec, key: string, width: number, height: number, built: BuiltScene): ComposerState {
    const target = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: this.antialias ? 4 : 0 });
    const composer = new EffectComposer(this.renderer, target);
    composer.setPixelRatio(1);
    composer.setSize(width, height);
    const renderPass = new RenderPass(built.scene, built.camera);
    composer.addPass(renderPass);
    let bloom: UnrealBloomPass | undefined;
    let dof: DepthOfFieldPass | undefined;
    let grading: ShaderPass | undefined;
    let lut: LUTPass | undefined;
    let vignette: ShaderPass | undefined;
    // Reihenfolge wie im WebGPU-Backend: Tiefenunschärfe → Bloom → Tone Mapping.
    if (post.depthOfField !== undefined) {
      dof = new DepthOfFieldPass(built.scene, built.camera, width, height);
      composer.addPass(dof);
    }
    if (post.bloom !== undefined) {
      bloom = new UnrealBloomPass(new Vector2(width, height), post.bloom.strength, post.bloom.radius, post.bloom.threshold);
      composer.addPass(bloom);
    }
    composer.addPass(createOutputPass(built.toneMapping));
    if (post.colorGrading !== undefined) {
      grading = new ShaderPass(GRADING_SHADER);
      composer.addPass(grading);
    }
    if (post.vignette !== undefined) {
      vignette = new ShaderPass(VIGNETTE_SHADER);
      composer.addPass(vignette);
    }
    // Reihenfolge wie im WebGPU-Backend: Tone Mapping → Grading → Vignette → LUT.
    if (post.lut !== undefined) {
      lut = new LUTPass({ lut: post.lut.texture, intensity: 1 });
      composer.addPass(lut);
    }
    return {
      key,
      composer,
      renderPass,
      ...(bloom !== undefined ? { bloom } : {}),
      ...(dof !== undefined ? { dof } : {}),
      ...(grading !== undefined ? { grading } : {}),
      ...(lut !== undefined ? { lut } : {}),
      ...(vignette !== undefined ? { vignette } : {}),
    };
  }

  /** Gibt Renderer, Composer und Preset-Texturen frei. */
  dispose(): void {
    this.composer?.composer.dispose();
    this.composer = undefined;
    for (const t of this.presets.values()) t.dispose();
    this.presets.clear();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}
