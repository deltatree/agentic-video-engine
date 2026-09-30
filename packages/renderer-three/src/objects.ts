/**
 * Baut Three.js-Objekte aus ausgewerteten 3D-Nodes: Geometrien, Materialien, Lichter, Kameras,
 * Modelle, Instanzen und Partikel (FR-38..FR-41).
 */
import { OpenVideoError, getNumber, getVec3, isRecord, parseColor, toSeconds, type EvaluatedNode } from '@agentic-video/core';
import {
  AdditiveBlending,
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  TorusGeometry,
  TorusKnotGeometry,
  Vector2,
  Vector3,
  Vector4,
  type BufferGeometry,
  type Camera,
  type IUniform,
  type Light,
  type Material,
} from 'three';
import type { ThreeAssets } from './assets.js';
import { isMesh } from './environment.js';
import { instanceTransforms } from './instances.js';
import { particles3d } from './particles.js';

const DEG = Math.PI / 180;

/** Sichtbare Höhe einer orthografischen Kamera in Metern bei `zoom: 1`. */
export const ORTHOGRAPHIC_VIEW_HEIGHT = 10;

/** Laufzeitkontext beim Aufbau einer Szene. */
export interface BuildContext {
  readonly assets: ThreeAssets;
  readonly assetUrl: (assetId: string) => string;
  readonly fps: number;
  readonly seed: number;
  /** Ausgabegröße in Pixeln (für `resolution` in Shadern). */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** Seitenverhältnis der Szenen-Box. */
  readonly aspect: number;
  /** Alle Ressourcen, die nach dem Frame freigegeben werden. */
  readonly disposables: { dispose(): void }[];
  /** Texturgrenze der GPU und Composition-Frame (Auftrag §40); fehlt sie, wird nicht geprüft. */
  readonly textureLimit?: { readonly maxSize: number; readonly downscale: boolean; readonly frame: number };
}

/** Lokale Zeit einer Node in Sekunden. */
export function localSeconds(node: EvaluatedNode, fps: number): number {
  return node.time.localFrame / fps;
}

/** sRGB-Farbe (`#RRGGBB[AA]`) als Three.js-Farbe (linear) und Alpha. */
export function toColor(value: unknown, fallback: string): { color: Color; alpha: number } {
  const c = parseColor(typeof value === 'string' ? value : fallback);
  return { color: new Color().setRGB(c.r, c.g, c.b, SRGBColorSpace), alpha: c.a };
}

function num(record: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Wendet `position`, `rotation` (Grad, XYZ) und `scale` an. */
export function applyTransform(obj: Object3D, node: EvaluatedNode, defaultPosition: readonly [number, number, number] = [0, 0, 0]): void {
  obj.position.fromArray(getVec3(node, 'position', defaultPosition));
  const r = getVec3(node, 'rotation', [0, 0, 0]);
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
  obj.scale.fromArray(getVec3(node, 'scale', [1, 1, 1]));
  obj.name = node.id;
}

// ---------------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------------

/**
 * Erzeugt eine Geometrie aus einer `Geometry`-Beschreibung. Standardmaße sind die von Three.js
 * (Kantenlänge 1, Radius 1), mit 32 Segmenten für runde Formen.
 *
 * @example
 * ```ts
 * const g = createGeometry({ type: 'sphere', radius: 0.5 });
 * ```
 */
export function createGeometry(spec: unknown): BufferGeometry {
  const g = isRecord(spec) ? spec : { type: 'box' };
  const segments = Math.max(3, Math.floor(num(g, 'segments', 32)));
  switch (g['type']) {
    case 'sphere':
      return new SphereGeometry(num(g, 'radius', 1), segments, Math.max(2, Math.floor(segments / 2)));
    case 'plane':
      return new PlaneGeometry(num(g, 'width', 1), num(g, 'height', 1));
    case 'cylinder':
      return new CylinderGeometry(num(g, 'radiusTop', 1), num(g, 'radiusBottom', 1), num(g, 'height', 1), segments);
    case 'cone':
      return new ConeGeometry(num(g, 'radius', 1), num(g, 'height', 1), segments);
    case 'torus':
      return new TorusGeometry(num(g, 'radius', 1), num(g, 'tube', 0.4), 16, 64);
    case 'torus-knot':
      return new TorusKnotGeometry(num(g, 'radius', 1), num(g, 'tube', 0.4), 128, 16, Math.floor(num(g, 'p', 2)), Math.floor(num(g, 'q', 3)));
    case 'capsule':
      return new CapsuleGeometry(num(g, 'radius', 1), num(g, 'length', 1), 8, 16);
    default:
      return new BoxGeometry(num(g, 'width', 1), num(g, 'height', 1), num(g, 'depth', 1));
  }
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

const DEFAULT_VERTEX_SHADER = 'varying vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}\n';

function uniformValue(v: unknown): unknown {
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.every((x): x is number => typeof x === 'number')) {
    if (v.length === 2) return new Vector2(v[0], v[1]);
    if (v.length === 3) return new Vector3(v[0], v[1], v[2]);
    if (v.length === 4) return new Vector4(v[0], v[1], v[2], v[3]);
    return [...v];
  }
  return 0;
}

/**
 * Erzeugt ein Material aus einer `Material`-Beschreibung.
 *
 * - `standard` (Standard), `physical`, `basic`: Farben sRGB, Texturen über `assetUrl`.
 * - `shader`: GLSL-`ShaderMaterial` (nur WebGL2). Uniforms: eigene `uniforms` plus
 *   `time` (Sekunden), `frame` und `resolution` (Ausgabepixel). Ohne `vertexShader` gilt ein
 *   Standard-Vertex-Shader, der `varying vec2 vUv` setzt.
 *
 * @example
 * ```ts
 * const m = await createMaterial({ type: 'physical', color: '#88CCFF', transmission: 0.8 }, ctx, 1.5, 45);
 * ```
 */
export async function createMaterial(spec: unknown, ctx: BuildContext, timeSeconds: number, frame: number, nodeId = ''): Promise<Material> {
  const m = isRecord(spec) ? spec : {};
  const type = typeof m['type'] === 'string' ? m['type'] : 'standard';
  const { color, alpha } = toColor(m['color'], '#FFFFFF');
  const opacity = num(m, 'opacity', 1) * alpha;
  const transparent = opacity < 1;
  const wireframe = m['wireframe'] === true;
  const texture = async (key: string, srgb: boolean) => {
    const id = m[key];
    if (typeof id !== 'string') return null;
    const limit = ctx.textureLimit;
    return ctx.assets.texture(ctx.assetUrl(id), srgb, limit === undefined ? undefined : { ...limit, nodeId, assetId: id });
  };
  let material: Material;
  if (type === 'shader') {
    const uniforms: Record<string, IUniform> = {};
    const custom = m['uniforms'];
    if (isRecord(custom)) for (const [k, v] of Object.entries(custom)) uniforms[k] = { value: uniformValue(v) };
    uniforms['time'] = { value: timeSeconds };
    uniforms['frame'] = { value: frame };
    uniforms['resolution'] = { value: new Vector2(ctx.pixelWidth, ctx.pixelHeight) };
    material = new ShaderMaterial({
      vertexShader: typeof m['vertexShader'] === 'string' ? m['vertexShader'] : DEFAULT_VERTEX_SHADER,
      fragmentShader: typeof m['fragmentShader'] === 'string' ? m['fragmentShader'] : 'void main() { gl_FragColor = vec4(1.0); }',
      uniforms,
      transparent,
      wireframe,
    });
  } else if (type === 'basic') {
    material = new MeshBasicMaterial({ color, opacity, transparent, wireframe, map: await texture('map', true) });
  } else {
    const params = {
      color,
      opacity,
      transparent,
      wireframe,
      metalness: num(m, 'metalness', 0),
      roughness: num(m, 'roughness', 1),
      emissive: toColor(m['emissive'], '#000000').color,
      emissiveIntensity: num(m, 'emissiveIntensity', 1),
      envMapIntensity: num(m, 'envMapIntensity', 1),
      map: await texture('map', true),
      normalMap: await texture('normalMap', false),
      roughnessMap: await texture('roughnessMap', false),
    };
    material = type === 'physical' ? new MeshPhysicalMaterial({ ...params, transmission: num(m, 'transmission', 0), clearcoat: num(m, 'clearcoat', 0) }) : new MeshStandardMaterial(params);
  }
  ctx.disposables.push(material);
  return material;
}

// ---------------------------------------------------------------------------
// Kameras und Lichter
// ---------------------------------------------------------------------------

/**
 * Erzeugt eine Kamera. `perspective`: `fov` 50°, `near` 0.1, `far` 1000.
 * `orthographic`: sichtbare Höhe {@link ORTHOGRAPHIC_VIEW_HEIGHT} m, geteilt durch `zoom`.
 * `target` bestimmt die Blickrichtung, sonst gilt `rotation`.
 *
 * @example
 * ```ts
 * const cam = createCamera(cameraNode, 16 / 9);
 * ```
 */
export function createCamera(node: EvaluatedNode, aspect: number): Camera {
  const near = getNumber(node, 'near', 0.1);
  const far = getNumber(node, 'far', 1000);
  let cam: PerspectiveCamera | OrthographicCamera;
  if (node.props['projection'] === 'orthographic') {
    const h = ORTHOGRAPHIC_VIEW_HEIGHT / 2;
    cam = new OrthographicCamera(-h * aspect, h * aspect, h, -h, near, far);
  } else {
    cam = new PerspectiveCamera(getNumber(node, 'fov', 50), aspect, near, far);
  }
  cam.zoom = getNumber(node, 'zoom', 1);
  applyTransform(cam, node);
  const target = node.props['target'];
  if (Array.isArray(target)) cam.lookAt(new Vector3().fromArray(getVec3(node, 'target', [0, 0, 0])));
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/** Standardkamera ohne `camera3d`: Perspektive bei `[0, 0, 5]`, Blick auf den Ursprung. */
export function defaultCamera(aspect: number): Camera {
  const cam = new PerspectiveCamera(50, aspect, 0.1, 1000);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * Erzeugt ein Licht. Gerichtete Lichter (`directional`, `spot`, `hemisphere`) stehen ohne
 * `position` bei `[0, 1, 0]` (Three.js-Standard); `target` ist Standard der Ursprung.
 * `spot.angle` ist der halbe Öffnungswinkel in Grad (Standard 60).
 *
 * @example
 * ```ts
 * const { light, extra } = createLight(lightNode);
 * scene.add(light, ...extra);
 * ```
 */
export function createLight(node: EvaluatedNode): { light: Light; extra: Object3D[] } {
  const { color } = toColor(node.props['color'], '#FFFFFF');
  const intensity = getNumber(node, 'intensity', 1);
  const kind = node.props['kind'];
  const castShadow = node.props['castShadow'] === true;
  const target = getVec3(node, 'target', [0, 0, 0]);
  switch (kind) {
    case 'directional': {
      const light = new DirectionalLight(color, intensity);
      applyTransform(light, node, [0, 1, 0]);
      light.target.position.fromArray(target);
      light.castShadow = castShadow;
      light.shadow.mapSize.set(1024, 1024);
      return { light, extra: [light.target] };
    }
    case 'point': {
      const light = new PointLight(color, intensity, getNumber(node, 'distance', 0), 2);
      applyTransform(light, node);
      light.castShadow = castShadow;
      light.shadow.mapSize.set(1024, 1024);
      return { light, extra: [] };
    }
    case 'spot': {
      const light = new SpotLight(color, intensity, getNumber(node, 'distance', 0), getNumber(node, 'angle', 60) * DEG, getNumber(node, 'penumbra', 0), 2);
      applyTransform(light, node, [0, 1, 0]);
      light.target.position.fromArray(target);
      light.castShadow = castShadow;
      light.shadow.mapSize.set(1024, 1024);
      return { light, extra: [light.target] };
    }
    case 'hemisphere': {
      const light = new HemisphereLight(color, toColor(node.props['groundColor'], '#FFFFFF').color, intensity);
      applyTransform(light, node, [0, 1, 0]);
      return { light, extra: [] };
    }
    default: {
      const light = new AmbientLight(color, intensity);
      light.name = node.id;
      return { light, extra: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Meshes, Modelle, Instanzen, Partikel
// ---------------------------------------------------------------------------

function applyShadowFlags(obj: Object3D, node: EvaluatedNode): void {
  const cast = node.props['castShadow'] === true;
  const receive = node.props['receiveShadow'] === true;
  obj.traverse((o) => {
    o.castShadow = cast;
    o.receiveShadow = receive;
  });
}

/** Baut eine `mesh3d`-Node. */
export async function createMesh(node: EvaluatedNode, ctx: BuildContext): Promise<Mesh> {
  const geometry = createGeometry(node.props['geometry']);
  ctx.disposables.push(geometry);
  const mesh = new Mesh(geometry, await createMaterial(node.props['material'], ctx, localSeconds(node, ctx.fps), node.time.localFrame, node.id));
  applyTransform(mesh, node);
  applyShadowFlags(mesh, node);
  return mesh;
}

/**
 * Baut eine `model3d`-Node: lädt glTF/GLB/OBJ (zwischengespeichert pro URL), setzt den
 * Animation Clip frame-genau (`AnimationMixer.setTime(offset + localTime · speed)`) und danach
 * die Morph Targets nach Name.
 *
 * @example
 * ```ts
 * const obj = await createModel(modelNode, ctx);
 * ```
 */
export async function createModel(node: EvaluatedNode, ctx: BuildContext): Promise<Object3D> {
  const asset = node.props['asset'];
  if (typeof asset !== 'string') {
    throw new OpenVideoError({ code: 'OV_THREE_ASSET_MISSING', errorClass: 'ThreeRendererError', problem: 'model3d needs an asset id.', nodeId: node.id, suggestions: ['asset: "robot"'] });
  }
  const { root, animations } = await ctx.assets.model(ctx.assetUrl(asset));
  applyTransform(root, node);
  applyShadowFlags(root, node);
  if (node.props['material'] !== undefined) {
    const material = await createMaterial(node.props['material'], ctx, localSeconds(node, ctx.fps), node.time.localFrame, node.id);
    root.traverse((o) => {
      if (isMesh(o)) o.material = material;
    });
  }
  const anim = node.props['animation'];
  if (isRecord(anim) && typeof anim['clip'] === 'string') {
    const clip = AnimationClip.findByName([...animations], anim['clip']);
    if (clip === null) {
      throw new OpenVideoError({
        code: 'OV_THREE_CLIP_UNKNOWN',
        errorClass: 'ThreeRendererError',
        problem: `Animation clip "${anim['clip']}" does not exist in the model.`,
        nodeId: node.id,
        received: JSON.stringify(anim['clip']),
        suggestions: animations.length > 0 ? [`Use one of: ${animations.map((a) => a.name).join(', ')}.`] : ['The model has no animation clips; remove animation.'],
      });
    }
    const offsetRaw = anim['offset'];
    const offset = typeof offsetRaw === 'number' || typeof offsetRaw === 'string' ? toSeconds(offsetRaw, { fps: ctx.fps }) : 0;
    const speed = typeof anim['speed'] === 'number' ? anim['speed'] : 1;
    const loop = anim['loop'] === true;
    const raw = offset + localSeconds(node, ctx.fps) * speed;
    const d = clip.duration;
    const t = d <= 0 ? 0 : loop ? ((raw % d) + d) % d : Math.min(Math.max(raw, 0), d);
    const mixer = new AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(t);
  }
  const morph = node.props['morphTargets'];
  if (isRecord(morph)) {
    root.traverse((o) => {
      if (!isMesh(o)) return;
      const dict = o.morphTargetDictionary;
      const influences = o.morphTargetInfluences;
      if (dict === undefined || influences === undefined) return;
      for (const [name, value] of Object.entries(morph)) {
        const idx = dict[name];
        if (idx !== undefined && typeof value === 'number') influences[idx] = value;
      }
    });
  }
  return root;
}

/** Baut eine `instances3d`-Node als `InstancedMesh`. */
export async function createInstances(node: EvaluatedNode, ctx: BuildContext): Promise<InstancedMesh> {
  const transforms = instanceTransforms(node, localSeconds(node, ctx.fps), ctx.seed);
  const geometry = createGeometry(node.props['geometry']);
  ctx.disposables.push(geometry);
  const mesh = new InstancedMesh(geometry, await createMaterial(node.props['material'], ctx, localSeconds(node, ctx.fps), node.time.localFrame, node.id), Math.max(1, transforms.length));
  mesh.count = transforms.length;
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  transforms.forEach((t, i) => {
    e.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ');
    m.compose(new Vector3().fromArray(t.position), q.setFromEuler(e), new Vector3().fromArray(t.scale));
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  applyTransform(mesh, node);
  applyShadowFlags(mesh, node);
  ctx.disposables.push(mesh);
  return mesh;
}

/**
 * Baut eine `particles3d`-Node: jedes lebende Partikel ist eine kleine Kugel (Instanz)
 * mit eigener Farbe. `additive: true` mischt additiv und schreibt keine Tiefe.
 */
export function createParticles(node: EvaluatedNode, ctx: BuildContext): InstancedMesh {
  const alive = particles3d(node, localSeconds(node, ctx.fps), ctx.fps, ctx.seed);
  const additive = node.props['additive'] === true;
  const geometry = new IcosahedronGeometry(0.5, 2);
  const material = new MeshBasicMaterial({ color: 0xffffff, blending: additive ? AdditiveBlending : NormalBlending, transparent: additive, depthWrite: !additive });
  ctx.disposables.push(geometry, material);
  const mesh = new InstancedMesh(geometry, material, Math.max(1, alive.length));
  mesh.count = alive.length;
  const m = new Matrix4();
  const color = new Color();
  alive.forEach((p, i) => {
    m.makeScale(p.size, p.size, p.size).setPosition(p.position[0], p.position[1], p.position[2]);
    mesh.setMatrixAt(i, m);
    const c = parseColor(p.color);
    mesh.setColorAt(i, color.setRGB(c.r, c.g, c.b, SRGBColorSpace));
  });
  // Ohne lebende Partikel legt Three.js keine Farbpuffer an; ein Dummy hält die Pipeline gleich.
  if (alive.length === 0) mesh.setColorAt(0, color.setRGB(1, 1, 1));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  applyTransform(mesh, node);
  ctx.disposables.push(mesh);
  return mesh;
}
