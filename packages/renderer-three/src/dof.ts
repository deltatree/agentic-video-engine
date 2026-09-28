/**
 * Tiefenunschärfe (Depth of Field) mit identischer Rechnung für WebGL2 und WebGPU.
 *
 * Unschärfe je Pixel (in UV-Einheiten der Bildbreite) wie im `BokehShader` von Three.js:
 * `blur = clamp(|focus − Abstand| · aperture, 0, maxBlur)`. Gemittelt wird über eine
 * Scheibe aus 32 Vogel-Punkten plus den Pixel selbst; Alpha wird mitgemittelt, damit
 * transparente Hintergründe erhalten bleiben.
 */
import { DepthTexture, MeshBasicMaterial, ShaderMaterial, WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer } from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { abs, clamp, uv, vec2 } from 'three/tsl';
import type { Node, PassNode, UniformNode } from 'three/webgpu';

const SAMPLES = 32;
const GOLDEN_ANGLE = 2.39996323;

/** Abtastpunkte der Unschärfe-Scheibe (Radius 1). */
export const DOF_KERNEL: readonly (readonly [number, number])[] = Array.from({ length: SAMPLES }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / SAMPLES);
  const t = i * GOLDEN_ANGLE;
  return [r * Math.cos(t), r * Math.sin(t)] as const;
});

const glslKernel = DOF_KERNEL.map(([x, y]) => `vec2(${x.toFixed(6)}, ${y.toFixed(6)})`).join(',\n  ');

const FRAGMENT = `#include <packing>
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform float focus;
uniform float aperture;
uniform float maxblur;
uniform float aspect;
uniform float nearClip;
uniform float farClip;
uniform bool orthographic;
varying vec2 vUv;
const vec2 KERNEL[${String(SAMPLES)}] = vec2[${String(SAMPLES)}](
  ${glslKernel}
);
void main() {
  float depth = texture2D(tDepth, vUv).x;
  float viewZ = orthographic ? orthographicDepthToViewZ(depth, nearClip, farClip) : perspectiveDepthToViewZ(depth, nearClip, farClip);
  float blur = clamp(abs(focus + viewZ) * aperture, 0.0, maxblur);
  vec4 sum = texture2D(tDiffuse, vUv);
  for (int i = 0; i < ${String(SAMPLES)}; i++) {
    sum += texture2D(tDiffuse, vUv + KERNEL[i] * vec2(1.0, aspect) * blur);
  }
  gl_FragColor = sum / ${String(SAMPLES + 1)}.0;
}`;

/** Parameter der Tiefenunschärfe. */
export interface DofParams {
  readonly focus: number;
  readonly aperture: number;
  readonly maxBlur: number;
}

/**
 * WebGL2-Pass für den `EffectComposer`: rendert die Tiefe der Szene in eine Tiefentextur und
 * mischt dann mit dem gemeinsamen Kernel.
 *
 * @example
 * ```ts
 * composer.addPass(new DepthOfFieldPass(scene, camera, 640, 360));
 * ```
 */
export class DepthOfFieldPass extends Pass {
  scene: Scene;
  camera: Camera;
  private readonly depthTarget: WebGLRenderTarget;
  private readonly depthMaterial = new MeshBasicMaterial({ colorWrite: false });
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(scene: Scene, camera: Camera, width: number, height: number) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.depthTarget = new WebGLRenderTarget(width, height, { depthTexture: new DepthTexture(width, height) });
    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: this.depthTarget.depthTexture },
        focus: { value: 10 },
        aperture: { value: 0.025 },
        maxblur: { value: 0.01 },
        aspect: { value: width / height },
        nearClip: { value: 0.1 },
        farClip: { value: 1000 },
        orthographic: { value: false },
      },
      vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\n',
      fragmentShader: FRAGMENT,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Setzt die Parameter für den nächsten Frame. */
  setParams(params: DofParams, width: number, height: number): void {
    this.set('focus', params.focus);
    this.set('aperture', params.aperture);
    this.set('maxblur', params.maxBlur);
    this.set('aspect', width / height);
  }

  private set(name: string, value: unknown): void {
    const u = this.material.uniforms[name];
    if (u !== undefined) u.value = value;
  }

  override setSize(width: number, height: number): void {
    this.depthTarget.setSize(width, height);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const cam = this.camera;
    this.set('nearClip', 'near' in cam && typeof cam.near === 'number' ? cam.near : 0.1);
    this.set('farClip', 'far' in cam && typeof cam.far === 'number' ? cam.far : 1000);
    this.set('orthographic', 'isOrthographicCamera' in cam && cam.isOrthographicCamera === true);
    const background = this.scene.background;
    const override = this.scene.overrideMaterial;
    this.scene.background = null;
    this.scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(this.scene, cam);
    this.scene.overrideMaterial = override;
    this.scene.background = background;
    this.set('tDiffuse', readBuffer.texture);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.depthTarget.dispose();
    this.depthMaterial.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

/** Uniforms der WebGPU-Variante. */
export interface DofUniforms {
  readonly focus: UniformNode<'float', number>;
  readonly aperture: UniformNode<'float', number>;
  readonly maxBlur: UniformNode<'float', number>;
  readonly aspect: UniformNode<'float', number>;
}

/**
 * WebGPU-Variante als TSL-Knoten: gleiche Rechnung wie {@link DepthOfFieldPass}.
 *
 * @example
 * ```ts
 * const color = depthOfFieldNode(scenePass, uniforms);
 * ```
 */
export function depthOfFieldNode(scenePass: PassNode, u: DofUniforms): Node<'vec4'> {
  const tex = scenePass.getTextureNode('output');
  const viewZ = scenePass.getViewZNode();
  const blur = clamp(abs(u.focus.add(viewZ)).mul(u.aperture), 0, u.maxBlur);
  const at = uv();
  let sum: Node<'vec4'> = tex.sample(at);
  for (const [x, y] of DOF_KERNEL) sum = sum.add(tex.sample(at.add(vec2(x, u.aspect.mul(y)).mul(blur))));
  return sum.div(SAMPLES + 1);
}

