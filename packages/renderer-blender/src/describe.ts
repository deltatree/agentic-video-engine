/**
 * Szenenbeschreibung für Blender: wandelt eine ausgewertete `blender`-Node in einen
 * JSON-Zustand um, den `python/openvideo_blender.py` in Blender aufbaut.
 *
 * Alle Werte sind fertig ausgewertet (OpenVideo besitzt die Zeit). Farben gehen als
 * lineare RGB-Werte an Blender, Lichtstärken sind in Blender-Einheiten umgerechnet.
 * Koordinaten bleiben in der OpenVideo-Konvention (Y oben, Meter, Grad).
 */
import { closeSync, openSync, readSync } from 'node:fs';
import {
  OpenVideoError,
  getNumber,
  getOptionalString,
  getVec3,
  isRecord,
  parseColor,
  srgbToLinear,
  toFrames,
  type AssetResolver,
  type EvaluatedNode,
} from '@agentic-video/core';
import { instanceTransforms } from './instances.js';

/** Sichtbare Höhe einer orthografischen Kamera in Metern bei `zoom: 1` (wie im Three.js-Renderer). */
export const ORTHOGRAPHIC_VIEW_HEIGHT = 10;

/** Standard-Samples je Engine, wenn die Node keine `samples` setzt. */
export const DEFAULT_SAMPLES = { cycles: 64, eevee: 32 } as const;

type Vec3 = readonly [number, number, number];

/** Material für Principled BSDF (`principled`) oder unbeleuchtet (`basic`). Farben linear. */
export interface BlenderMaterialState {
  readonly kind: 'principled' | 'basic';
  /** Lineares RGB plus Alpha 1. */
  readonly color: readonly [number, number, number, number];
  readonly metalness: number;
  readonly roughness: number;
  readonly emissive: Vec3;
  readonly emissiveIntensity: number;
  readonly opacity: number;
  readonly transmission: number;
  readonly clearcoat: number;
  readonly wireframe: boolean;
  readonly map?: string;
  readonly normalMap?: string;
  readonly roughnessMap?: string;
}

/** Ein Objekt der Szene. `key` ist in der ganzen Blender-Datei eindeutig. */
export interface BlenderObjectState {
  readonly key: string;
  readonly parent: string | null;
  readonly kind: 'group' | 'mesh' | 'camera' | 'light' | 'model' | 'instances';
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: Vec3;
  /** Blickziel in Weltkoordinaten (Kamera, Sonne, Spot). */
  readonly target?: Vec3;
  readonly camera?: { readonly projection: 'perspective' | 'orthographic'; readonly fov: number; readonly near: number; readonly far: number; readonly zoom: number; readonly orthoHeight: number };
  readonly light?: { readonly type: 'SUN' | 'POINT' | 'SPOT'; readonly color: Vec3; readonly energy: number; readonly angle: number; readonly penumbra: number };
  readonly geometry?: Readonly<Record<string, unknown>>;
  readonly material?: BlenderMaterialState;
  readonly model?: {
    readonly path: string;
    readonly format: 'gltf' | 'obj';
    readonly clip?: { readonly name: string; readonly seconds: number; readonly loop: boolean };
    readonly morphTargets: Readonly<Record<string, number>>;
    readonly material?: BlenderMaterialState;
  };
  readonly instances?: { readonly transforms: readonly { readonly position: Vec3; readonly rotation: Vec3; readonly scale: Vec3 }[] };
}

/** Welt: Hintergrund, Umgebungslicht, HDRI, Volumen, Nebel. Farben linear. */
export interface BlenderWorldState {
  /** Farbe, die die Kamera als Hintergrund sieht; `null` = keine. */
  readonly background: Vec3 | null;
  /** `film_transparent`: kein Hintergrund und keine sichtbare Umgebung. */
  readonly transparent: boolean;
  /** Gleichmäßiges Umgebungslicht (Welt-Strahldichte). */
  readonly ambient: Vec3;
  /** Halbkugel-Verlauf (oben/unten); `null` = keiner. */
  readonly sky: Vec3 | null;
  readonly ground: Vec3 | null;
  readonly hdri: string | null;
  readonly envIntensity: number;
  readonly volume: { readonly density: number; readonly color: Vec3; readonly anisotropy: number } | null;
  readonly fog: { readonly color: Vec3; readonly near: number; readonly far: number } | null;
}

/** Vollständiger Zustand einer `blender`-Node für einen (Sub-)Frame. */
export interface BlenderSceneState {
  readonly key: string;
  /** Render-Auflösung in Pixeln. */
  readonly width: number;
  readonly height: number;
  readonly engine: 'cycles' | 'eevee';
  readonly samples: number;
  readonly pass: 'combined' | 'depth' | 'normal' | 'object-mask';
  /** Objekt-Schlüssel für den Maskenpass. */
  readonly mask: string | null;
  readonly motionBlur: boolean;
  readonly seed: number;
  /** Objekt-Schlüssel der aktiven Kamera; `null` = Standardkamera bei `[0, 0, 5]`. */
  readonly camera: string | null;
  readonly world: BlenderWorldState;
  readonly objects: readonly BlenderObjectState[];
}

/** Eingaben für {@link describeScene}. */
export interface DescribeContext {
  /** Render-Auflösung in Pixeln. */
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seed: number;
  readonly assets: AssetResolver;
}

const PRESETS: Readonly<Record<string, { sky: Vec3; ground: Vec3 }>> = {
  studio: { sky: [0.8, 0.8, 0.8], ground: [0.35, 0.35, 0.35] },
  neutral: { sky: [0.5, 0.5, 0.5], ground: [0.5, 0.5, 0.5] },
  sunset: { sky: [1.0, 0.55, 0.3], ground: [0.2, 0.15, 0.25] },
};

/** sRGB-Farbtext → lineares RGB und Alpha. */
function linearColor(value: unknown, fallback: string): { rgb: Vec3; alpha: number } {
  const c = parseColor(typeof value === 'string' ? value : fallback);
  return { rgb: [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)], alpha: c.a };
}

function num(record: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function add(a: Vec3, b: Vec3, k = 1): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

/** Lokaler Dateipfad eines Assets; wirft `OV_BLENDER_ASSET_MISSING`, wenn es fehlt. */
function assetPath(assets: AssetResolver, id: string, nodeId: string): string {
  const record = assets.get(id);
  if (record === undefined) {
    throw new OpenVideoError({
      code: 'OV_BLENDER_ASSET_MISSING',
      errorClass: 'BlenderRendererError',
      problem: `Asset "${id}" is not known to the renderer.`,
      nodeId,
      details: { asset: id },
      suggestions: [`Import the file first: openvideo assets import <file> --id ${id}`, 'Check the asset id for typos.'],
    });
  }
  return record.path;
}

/**
 * Erkennt das Modellformat am Dateiinhalt (Pfade im Content Store haben oft keine Endung):
 * GLB beginnt mit `glTF`, glTF-JSON mit `{`, alles andere gilt als OBJ.
 */
function modelFormat(path: string): 'gltf' | 'obj' {
  const head = new Uint8Array(4);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const text = String.fromCharCode(...head);
  return text === 'glTF' || text.trimStart().startsWith('{') ? 'gltf' : 'obj';
}

function materialState(spec: unknown, assets: AssetResolver, nodeId: string): BlenderMaterialState {
  const m = isRecord(spec) ? spec : {};
  const { rgb, alpha } = linearColor(m['color'], '#FFFFFF');
  const tex = (key: string): { [k: string]: string } => {
    const id = m[key];
    return typeof id === 'string' ? { [key]: assetPath(assets, id, nodeId) } : {};
  };
  return {
    kind: m['type'] === 'basic' ? 'basic' : 'principled',
    color: [rgb[0], rgb[1], rgb[2], 1],
    metalness: num(m, 'metalness', 0),
    roughness: num(m, 'roughness', 1),
    emissive: linearColor(m['emissive'], '#000000').rgb,
    emissiveIntensity: num(m, 'emissiveIntensity', 1),
    opacity: num(m, 'opacity', 1) * alpha,
    transmission: num(m, 'transmission', 0),
    clearcoat: num(m, 'clearcoat', 0),
    wireframe: m['wireframe'] === true,
    ...tex('map'),
    ...tex('normalMap'),
    ...tex('roughnessMap'),
  };
}

function geometryState(spec: unknown): Readonly<Record<string, unknown>> {
  return isRecord(spec) ? spec : { type: 'box' };
}

/** Sammelt Kameras in Tiefensuche. */
function findCameras(nodes: readonly EvaluatedNode[], out: EvaluatedNode[] = []): EvaluatedNode[] {
  for (const n of nodes) {
    if (n.type === 'camera3d') out.push(n);
    findCameras(n.children, out);
  }
  return out;
}

/** Objekt-Schlüssel einer 3D-Node innerhalb einer `blender`-Node. */
export function objectKey(sceneId: string, nodeId: string): string {
  return `${sceneId}:${nodeId}`;
}

/**
 * Beschreibt eine ausgewertete `blender`-Node für einen Frame.
 *
 * Umrechnungen (Three.js-Konvention → Blender, „glTF compat“):
 * - Sonne: Stärke = `intensity` (W/m²); Punkt und Spot: Leistung = 4π · `intensity` (W).
 * - `ambient`: Welt-Strahldichte `color · intensity / π`; `hemisphere`: Verlauf zwischen
 *   `groundColor` und `color`, ebenfalls `/ π` (Näherung).
 * - `environment.preset`: fester Verlauf je Preset (Näherung); `hdri`: Environment Texture.
 * - `fog`: linearer Nebel über den Mist-Pass; `volume`: Principled Volume in der Welt.
 *
 * @example
 * ```ts
 * const state = describeScene(blenderNode, { width: 640, height: 360, fps: 30, seed: 1, assets });
 * ```
 */
export function describeScene(node: EvaluatedNode, ctx: DescribeContext): BlenderSceneState {
  const sceneId = node.id;
  const engine = node.props['engine'] === 'eevee' ? 'eevee' : 'cycles';
  const pass = node.props['pass'] === 'depth' || node.props['pass'] === 'normal' || node.props['pass'] === 'object-mask' ? node.props['pass'] : 'combined';
  const objects: BlenderObjectState[] = [];
  // Weltlicht aus ambient- und hemisphere-Lichtern (in visit() gesammelt).
  const light: { ambient: Vec3; sky: Vec3 | null; ground: Vec3 | null } = { ambient: [0, 0, 0], sky: null, ground: null };

  const visit = (n: EvaluatedNode, parent: string | null): void => {
    const key = objectKey(sceneId, n.id);
    const base = {
      key,
      parent,
      position: getVec3(n, 'position', [0, 0, 0]),
      rotation: getVec3(n, 'rotation', [0, 0, 0]),
      scale: getVec3(n, 'scale', [1, 1, 1]),
    };
    const hasTarget = Array.isArray(n.props['target']);
    switch (n.type) {
      case 'group3d':
        objects.push({ ...base, kind: 'group' });
        for (const c of n.children) visit(c, key);
        return;
      case 'camera3d':
        objects.push({
          ...base,
          kind: 'camera',
          ...(hasTarget ? { target: getVec3(n, 'target', [0, 0, 0]) } : {}),
          camera: {
            projection: n.props['projection'] === 'orthographic' ? 'orthographic' : 'perspective',
            fov: getNumber(n, 'fov', 50),
            near: getNumber(n, 'near', 0.1),
            far: getNumber(n, 'far', 1000),
            zoom: getNumber(n, 'zoom', 1),
            orthoHeight: ORTHOGRAPHIC_VIEW_HEIGHT,
          },
        });
        return;
      case 'light3d': {
        const kind = n.props['kind'];
        const color = linearColor(n.props['color'], '#FFFFFF').rgb;
        const intensity = getNumber(n, 'intensity', 1);
        if (kind === 'ambient' || kind === undefined) {
          light.ambient = add(light.ambient, color, intensity / Math.PI);
          return;
        }
        if (kind === 'hemisphere') {
          const g = linearColor(n.props['groundColor'], '#FFFFFF').rgb;
          light.sky = add(light.sky ?? [0, 0, 0], color, intensity / Math.PI);
          light.ground = add(light.ground ?? [0, 0, 0], g, intensity / Math.PI);
          return;
        }
        const type = kind === 'directional' ? 'SUN' : kind === 'spot' ? 'SPOT' : 'POINT';
        const directed = type !== 'POINT';
        objects.push({
          ...base,
          position: getVec3(n, 'position', directed ? [0, 1, 0] : [0, 0, 0]),
          kind: 'light',
          ...(directed ? { target: getVec3(n, 'target', [0, 0, 0]) } : {}),
          light: {
            type,
            color,
            energy: type === 'SUN' ? intensity : intensity * 4 * Math.PI,
            angle: getNumber(n, 'angle', 60),
            penumbra: getNumber(n, 'penumbra', 0),
          },
        });
        return;
      }
      case 'mesh3d':
        objects.push({ ...base, kind: 'mesh', geometry: geometryState(n.props['geometry']), material: materialState(n.props['material'], ctx.assets, n.id) });
        return;
      case 'instances3d':
        objects.push({
          ...base,
          kind: 'instances',
          geometry: geometryState(n.props['geometry']),
          material: materialState(n.props['material'], ctx.assets, n.id),
          instances: { transforms: instanceTransforms(n, n.time.localFrame / ctx.fps, ctx.seed) },
        });
        return;
      case 'model3d': {
        const assetId = getOptionalString(n, 'asset') ?? '';
        const path = assetPath(ctx.assets, assetId, n.id);
        const anim = n.props['animation'];
        let clip: { name: string; seconds: number; loop: boolean } | undefined;
        if (isRecord(anim) && typeof anim['clip'] === 'string') {
          const offsetRaw = anim['offset'];
          const offset = typeof offsetRaw === 'number' || typeof offsetRaw === 'string' ? toFrames(offsetRaw, { fps: ctx.fps }) / ctx.fps : 0;
          const speed = num(anim, 'speed', 1);
          clip = { name: anim['clip'], seconds: offset + (n.time.localFrame / ctx.fps) * speed, loop: anim['loop'] !== false };
        }
        const morphRaw = n.props['morphTargets'];
        const morphTargets: Record<string, number> = {};
        if (isRecord(morphRaw)) for (const [k, v] of Object.entries(morphRaw)) if (typeof v === 'number') morphTargets[k] = v;
        const material = n.props['material'];
        objects.push({
          ...base,
          kind: 'model',
          model: {
            path,
            format: modelFormat(path),
            ...(clip === undefined ? {} : { clip }),
            morphTargets,
            ...(material === undefined ? {} : { material: materialState(material, ctx.assets, n.id) }),
          },
        });
        return;
      }
      default:
        // Nicht übertragbare Typen (z. B. particles3d) meldet check() vor dem Render.
        return;
    }
  };
  for (const c of node.children) visit(c, null);

  const cameraId = getOptionalString(node, 'camera') ?? findCameras(node.children)[0]?.id;
  const bg = node.props['background'];
  const bgColor = typeof bg === 'string' ? linearColor(bg, 'transparent') : undefined;
  const background = bgColor !== undefined && bgColor.alpha > 0 ? bgColor.rgb : null;

  const envRaw = node.props['environment'];
  const env = isRecord(envRaw) ? envRaw : {};
  const envIntensity = num(env, 'intensity', 1);
  const hdri = typeof env['hdri'] === 'string' ? assetPath(ctx.assets, env['hdri'], node.id) : null;
  const preset = typeof env['preset'] === 'string' ? PRESETS[env['preset']] : undefined;
  if (hdri === null && preset !== undefined) {
    light.sky = add(light.sky ?? [0, 0, 0], preset.sky, envIntensity);
    light.ground = add(light.ground ?? [0, 0, 0], preset.ground, envIntensity);
  }
  const showEnvironment = env['showBackground'] === true && (hdri !== null || preset !== undefined);

  const volRaw = node.props['volume'];
  const volume = isRecord(volRaw)
    ? { density: num(volRaw, 'density', 0), color: linearColor(volRaw['color'], '#FFFFFF').rgb, anisotropy: num(volRaw, 'anisotropy', 0) }
    : null;
  const fogRaw = node.props['fog'];
  const fog = isRecord(fogRaw) ? { color: linearColor(fogRaw['color'], '#FFFFFF').rgb, near: num(fogRaw, 'near', 0), far: num(fogRaw, 'far', 100) } : null;

  const samplesRaw = getNumber(node, 'samples', DEFAULT_SAMPLES[engine]);
  const maskObject = getOptionalString(node, 'maskObject');
  return {
    key: sceneId,
    width: ctx.width,
    height: ctx.height,
    engine,
    samples: Math.max(1, Math.round(samplesRaw)),
    pass,
    mask: maskObject === undefined ? null : objectKey(sceneId, maskObject),
    motionBlur: node.props['motionBlur'] === true,
    seed: ctx.seed,
    camera: cameraId === undefined ? null : objectKey(sceneId, cameraId),
    world: {
      background,
      transparent: background === null && !showEnvironment,
      ambient: light.ambient,
      sky: light.sky,
      ground: light.sky === null ? null : (light.ground ?? [0, 0, 0]),
      hdri,
      envIntensity,
      volume,
      fog,
    },
    objects,
  };
}
