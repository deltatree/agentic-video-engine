/**
 * Baut aus einer ausgewerteten `scene3d`-Node eine Three.js-Szene samt Kamera,
 * Umgebung, Nebel, Tone Mapping, Postprocessing-Beschreibung und Debug-Helfern.
 */
import { OpenVideoError, isRecord, type EvaluatedNode } from '@agentic-video/core';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CameraHelper,
  Color,
  DirectionalLight,
  DirectionalLightHelper,
  Fog,
  Group,
  HemisphereLight,
  HemisphereLightHelper,
  NeutralToneMapping,
  NoToneMapping,
  PointLight,
  PointLightHelper,
  Scene,
  SpotLight,
  SpotLightHelper,
  type Camera,
  type Light,
  type Object3D,
  type Texture,
  type ToneMapping,
} from 'three';
import type { LoadedLut, ThreeAssets } from './assets.js';
import type { EnvironmentPreset } from './environment.js';
import { applyTransform, createCamera, createInstances, createLight, createMesh, createModel, createParticles, defaultCamera, toColor, type BuildContext } from './objects.js';

/** Eingabe für einen Three.js-Layer (siehe Paket-README). */
export interface ThreeLayerInput {
  /** Die `scene3d`-Node. */
  readonly node: EvaluatedNode;
  /** Box der Szene in Composition-Pixeln. */
  readonly width: number;
  readonly height: number;
  /** Vorschau-Skalierung: Das Canvas ist `width·scale × height·scale` groß. */
  readonly scale: number;
  readonly frame: number;
  readonly time: number;
  readonly fps: number;
  readonly seed: number;
  /** URL eines Assets auf der Host-Origin. */
  readonly assetUrl: (assetId: string) => string;
  readonly debug?: { readonly showCameraFrustum?: boolean; readonly showLightHelpers?: boolean };
  /**
   * Ergebnis der Grafik-Probe, die im Cache-Schlüssel steht (Review M3): `webgpu` entscheidet
   * `backend: 'auto'`, `maxTextureSize` (WebGL2 `MAX_TEXTURE_SIZE`) die Texturgrenze von WebGL2.
   * Ohne Angabe prüft der Renderer live (Studio, direkte Nutzung).
   */
  readonly graphics?: ThreeGraphicsHint;
}

/** Grafik-Fähigkeiten aus der Probe des Hosts (siehe {@link ThreeLayerInput.graphics}). */
export interface ThreeGraphicsHint {
  readonly webgpu: boolean;
  readonly maxTextureSize: number;
}

/** Postprocessing-Einstellungen eines Frames (Zahlen bereits ausgewertet). */
export interface PostSpec {
  readonly bloom?: { readonly strength: number; readonly radius: number; readonly threshold: number };
  readonly depthOfField?: { readonly focus: number; readonly aperture: number; readonly maxBlur: number };
  readonly colorGrading?: { readonly exposure: number; readonly contrast: number; readonly saturation: number };
  readonly lut?: LoadedLut & { readonly url: string };
  readonly vignette?: { readonly offset: number; readonly darkness: number };
}

/** Fertig aufgebaute Szene für genau einen Frame. */
export interface BuiltScene {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly clearColor: Color;
  /** 0 = transparenter Hintergrund. */
  readonly clearAlpha: number;
  readonly toneMapping: ToneMapping;
  readonly shadows: boolean;
  readonly post: PostSpec;
  readonly disposables: readonly { dispose(): void }[];
}

/** Liefert die Umgebungstextur eines Presets für das aktive Backend. */
export type PresetEnvironment = (preset: EnvironmentPreset) => Promise<Texture>;

const TONE_MAPPINGS: Readonly<Record<string, ToneMapping>> = { none: NoToneMapping, aces: ACESFilmicToneMapping, agx: AgXToneMapping, neutral: NeutralToneMapping };

function rec(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function n(r: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = r[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Liest die Postprocessing-Einstellungen. Standardwerte: Bloom `radius` 0.4, `threshold` 0.85;
 * Depth of Field `maxBlur` 0.01; Color Grading `exposure` 0 (Blenden), `contrast` 1, `saturation` 1.
 *
 * @example
 * ```ts
 * const post = await readPost(sceneNode, assets, (id) => `/assets/${id}`);
 * ```
 */
export async function readPost(node: EvaluatedNode, assets: ThreeAssets, assetUrl: (id: string) => string): Promise<PostSpec> {
  const pp = rec(node.props['postprocessing']);
  if (pp === undefined) return {};
  const bloom = rec(pp['bloom']);
  const dof = rec(pp['depthOfField']);
  const grading = rec(pp['colorGrading']);
  const vignette = rec(pp['vignette']);
  const lutId = grading?.['lut'];
  const lutUrl = typeof lutId === 'string' ? assetUrl(lutId) : undefined;
  return {
    ...(bloom !== undefined ? { bloom: { strength: n(bloom, 'strength', 1), radius: n(bloom, 'radius', 0.4), threshold: n(bloom, 'threshold', 0.85) } } : {}),
    ...(dof !== undefined ? { depthOfField: { focus: n(dof, 'focus', 10), aperture: n(dof, 'aperture', 0.025), maxBlur: n(dof, 'maxBlur', 0.01) } } : {}),
    ...(grading !== undefined && (grading['exposure'] !== undefined || grading['contrast'] !== undefined || grading['saturation'] !== undefined)
      ? { colorGrading: { exposure: n(grading, 'exposure', 0), contrast: n(grading, 'contrast', 1), saturation: n(grading, 'saturation', 1) } }
      : {}),
    ...(lutUrl !== undefined ? { lut: { ...(await assets.lut(lutUrl)), url: lutUrl } } : {}),
    ...(vignette !== undefined ? { vignette: { offset: n(vignette, 'offset', 1), darkness: n(vignette, 'darkness', 1) } } : {}),
  };
}

interface Collected {
  readonly cameras: { readonly id: string; readonly camera: Camera }[];
  readonly lights: Light[];
}

async function addChildren(parent: Object3D, nodes: readonly EvaluatedNode[], ctx: BuildContext, collected: Collected): Promise<void> {
  for (const child of nodes) {
    switch (child.type) {
      case 'group3d': {
        const group = new Group();
        applyTransform(group, child);
        parent.add(group);
        await addChildren(group, child.children, ctx, collected);
        break;
      }
      case 'camera3d': {
        const camera = createCamera(child, ctx.aspect);
        parent.add(camera);
        collected.cameras.push({ id: child.id, camera });
        break;
      }
      case 'light3d': {
        const { light, extra } = createLight(child);
        parent.add(light, ...extra);
        collected.lights.push(light);
        break;
      }
      case 'mesh3d':
        parent.add(await createMesh(child, ctx));
        break;
      case 'model3d':
        parent.add(await createModel(child, ctx));
        break;
      case 'instances3d':
        parent.add(await createInstances(child, ctx));
        break;
      case 'particles3d':
        parent.add(createParticles(child, ctx));
        break;
      default:
        throw new OpenVideoError({
          code: 'OV_THREE_UNSUPPORTED',
          errorClass: 'ThreeRendererError',
          problem: `Node type "${child.type}" cannot be a child of scene3d.`,
          nodeId: child.id,
          pointer: child.pointer,
          suggestions: ['Use camera3d, light3d, mesh3d, model3d, instances3d, particles3d or group3d.'],
        });
    }
  }
}

function addDebugHelpers(scene: Scene, active: Camera, collected: Collected, input: ThreeLayerInput, disposables: { dispose(): void }[]): void {
  scene.updateMatrixWorld(true);
  if (input.debug?.showCameraFrustum === true) {
    for (const { camera } of collected.cameras) {
      if (camera === active) continue;
      const helper = new CameraHelper(camera);
      helper.update();
      scene.add(helper);
      disposables.push(helper);
    }
  }
  if (input.debug?.showLightHelpers === true) {
    for (const light of collected.lights) {
      let helper: Object3D & { dispose(): void; update(): void } | undefined;
      if (light instanceof DirectionalLight) helper = new DirectionalLightHelper(light, 0.5);
      else if (light instanceof SpotLight) helper = new SpotLightHelper(light);
      else if (light instanceof PointLight) helper = new PointLightHelper(light, 0.2);
      else if (light instanceof HemisphereLight) helper = new HemisphereLightHelper(light, 0.5);
      if (helper === undefined) continue;
      helper.update();
      scene.add(helper);
      disposables.push(helper);
    }
  }
}

/**
 * Baut die Szene eines Frames. Alles wird pro Frame neu aufgebaut (zustandslos);
 * nur geladene Assets kommen aus dem Zwischenspeicher.
 *
 * @example
 * ```ts
 * const built = await buildScene(input, assets, (preset) => pmremFor(preset));
 * ```
 */
export async function buildScene(input: ThreeLayerInput, assets: ThreeAssets, presetEnvironment: PresetEnvironment, textureLimit?: { readonly maxSize: number; readonly downscale: boolean }): Promise<BuiltScene> {
  const node = input.node;
  const aspect = input.height > 0 ? input.width / input.height : 1;
  const disposables: { dispose(): void }[] = [];
  const ctx: BuildContext = {
    assets,
    assetUrl: input.assetUrl,
    fps: input.fps,
    seed: input.seed,
    pixelWidth: Math.max(1, Math.round(input.width * input.scale)),
    pixelHeight: Math.max(1, Math.round(input.height * input.scale)),
    aspect,
    disposables,
    ...(textureLimit !== undefined ? { textureLimit: { ...textureLimit, frame: input.frame } } : {}),
  };
  const scene = new Scene();
  const collected: Collected = { cameras: [], lights: [] };
  await addChildren(scene, node.children, ctx, collected);

  const wanted = node.props['camera'];
  let camera: Camera | undefined;
  if (typeof wanted === 'string') {
    camera = collected.cameras.find((c) => c.id === wanted)?.camera;
    if (camera === undefined) {
      throw new OpenVideoError({
        code: 'OV_THREE_CAMERA_UNKNOWN',
        errorClass: 'ThreeRendererError',
        problem: `Camera "${wanted}" is not a camera3d child of this scene.`,
        nodeId: node.id,
        suggestions: collected.cameras.length > 0 ? [`Use one of: ${collected.cameras.map((c) => c.id).join(', ')}.`] : ['Add a camera3d child with this id.'],
      });
    }
  }
  camera ??= collected.cameras[0]?.camera ?? defaultCamera(aspect);

  const bg = node.props['background'];
  const { color: clearColor, alpha: clearAlpha } = typeof bg === 'string' ? toColor(bg, '#000000') : { color: new Color(0, 0, 0), alpha: 0 };

  const fog = rec(node.props['fog']);
  if (fog !== undefined) scene.fog = new Fog(toColor(fog['color'], '#FFFFFF').color, n(fog, 'near', 1), n(fog, 'far', 1000));

  const env = rec(node.props['environment']);
  if (env !== undefined) {
    const hdri = env['hdri'];
    const preset = env['preset'];
    let tex: Texture | undefined;
    if (typeof hdri === 'string') tex = await assets.environment(input.assetUrl(hdri));
    else if (preset === 'studio' || preset === 'neutral' || preset === 'sunset') tex = await presetEnvironment(preset);
    if (tex !== undefined) {
      const intensity = n(env, 'intensity', 1);
      scene.environment = tex;
      scene.environmentIntensity = intensity;
      if (env['showBackground'] === true) {
        scene.background = tex;
        scene.backgroundIntensity = intensity;
      }
    }
  }

  addDebugHelpers(scene, camera, collected, input, disposables);
  scene.updateMatrixWorld(true);

  const tm = node.props['toneMapping'];
  return {
    scene,
    camera,
    clearColor,
    clearAlpha,
    toneMapping: (typeof tm === 'string' ? TONE_MAPPINGS[tm] : undefined) ?? NoToneMapping,
    shadows: node.props['shadows'] === true,
    post: await readPost(node, assets, input.assetUrl),
    disposables,
  };
}

/** Pixelgröße des Ausgabe-Canvas. */
export function outputSize(input: ThreeLayerInput): { width: number; height: number } {
  return { width: Math.max(1, Math.round(input.width * input.scale)), height: Math.max(1, Math.round(input.height * input.scale)) };
}

/** Liest `antialias` der Szene (Standard an). */
export function wantsAntialias(node: EvaluatedNode): boolean {
  return node.props['antialias'] !== false;
}
