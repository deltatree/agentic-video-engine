/**
 * Laden und Zwischenspeichern von Assets für Three.js: Modelle (Geometry Cache),
 * Texturen, HDR/EXR-Umgebungen und LUTs. Alles wird pro URL genau einmal geladen.
 */
import { OpenVideoError } from '@agentic-video/core';
import { DataTexture, EquirectangularReflectionMapping, HalfFloatType, LinearFilter, LinearSRGBColorSpace, RGBAFormat, SRGBColorSpace, TextureLoader, type AnimationClip, type Data3DTexture, type Object3D, type Texture } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { LUTCubeLoader } from 'three/examples/jsm/loaders/LUTCubeLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { isMesh } from './environment.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/** Erkanntes Dateiformat eines Assets. */
export type AssetFormat = 'gltf' | 'glb' | 'obj' | 'hdr' | 'exr' | 'cube' | 'unknown';

const EXTENSIONS: Readonly<Record<string, AssetFormat>> = { gltf: 'gltf', glb: 'glb', obj: 'obj', hdr: 'hdr', pic: 'hdr', exr: 'exr', cube: 'cube' };

/**
 * Erkennt das Format eines Assets: zuerst an der Dateiendung der URL, sonst an den ersten Bytes
 * (Host-URLs wie `/assets/<id>` haben oft keine Endung).
 *
 * @example
 * ```ts
 * detectFormat('/assets/robot', new TextEncoder().encode('glTF....')); // 'glb'
 * ```
 */
export function detectFormat(url: string, bytes: Uint8Array): AssetFormat {
  const path = url.split(/[?#]/u)[0] ?? '';
  const ext = /\.([a-z0-9]+)$/iu.exec(path)?.[1]?.toLowerCase();
  const byExt = ext !== undefined ? EXTENSIONS[ext] : undefined;
  if (byExt !== undefined) return byExt;
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0x67 && b(1) === 0x6c && b(2) === 0x54 && b(3) === 0x46) return 'glb';
  if (b(0) === 0x76 && b(1) === 0x2f && b(2) === 0x31 && b(3) === 0x01) return 'exr';
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (head.startsWith('#?')) return 'hdr';
  if (/^\s*\{/u.test(head)) return 'gltf';
  if (/^\s*LUT_3D_SIZE\s/mu.test(head)) return 'cube';
  if (/^\s*(v|f|vn|vt|o|g)\s/mu.test(head)) return 'obj';
  return 'unknown';
}

/** Geladenes Modell: Szene und Animation Clips. */
export interface LoadedModel {
  readonly root: Object3D;
  readonly animations: readonly AnimationClip[];
}

/** Geladene LUT (.cube). */
export interface LoadedLut {
  readonly size: number;
  readonly texture: Data3DTexture;
}

function loadError(url: string, what: string, cause: unknown): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_THREE_ASSET_LOAD',
    errorClass: 'ThreeRendererError',
    problem: `Could not load ${what} from "${url}".`,
    details: { url },
    cause,
    suggestions: ['Check that the asset id exists and was imported.', 'Check that the host serves the asset under this URL.'],
  });
}

function formatError(url: string, what: string, format: AssetFormat, allowed: readonly string[]): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_THREE_ASSET_FORMAT',
    errorClass: 'ThreeRendererError',
    problem: `The asset at "${url}" is not a supported ${what} (detected: ${format}).`,
    details: { url, format },
    suggestions: [`Use one of: ${allowed.join(', ')}.`],
  });
}

/**
 * Zwischenspeicher für Assets einer Renderer-Instanz. Geladene Modelle werden pro URL
 * einmal geparst; jede Verwendung erhält einen Klon, der Geometrien und Materialien teilt.
 *
 * @example
 * ```ts
 * const assets = new ThreeAssets();
 * const model = await assets.model('/assets/robot');
 * ```
 */
export class ThreeAssets {
  private readonly bytesCache = new Map<string, Promise<Uint8Array>>();
  private readonly models = new Map<string, Promise<LoadedModel>>();
  private readonly textures = new Map<string, Promise<Texture>>();
  private readonly environments = new Map<string, Promise<Texture>>();
  private readonly luts = new Map<string, Promise<LoadedLut>>();

  /** Lädt die Bytes einer URL (einmal pro URL). */
  bytes(url: string): Promise<Uint8Array> {
    let p = this.bytesCache.get(url);
    if (p === undefined) {
      p = fetch(url)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
          return new Uint8Array(await res.arrayBuffer());
        })
        .catch((error: unknown) => {
          throw loadError(url, 'asset bytes', error);
        });
      this.bytesCache.set(url, p);
    }
    return p;
  }

  /**
   * Lädt ein glTF-, GLB- oder OBJ-Modell und liefert einen Klon (Skelette werden mitgeklont).
   */
  async model(url: string): Promise<LoadedModel> {
    let p = this.models.get(url);
    if (p === undefined) {
      p = this.loadModel(url);
      this.models.set(url, p);
    }
    const loaded = await p;
    return { root: cloneSkinned(loaded.root), animations: loaded.animations };
  }

  private async loadModel(url: string): Promise<LoadedModel> {
    const bytes = await this.bytes(url);
    const format = detectFormat(url, bytes);
    const buffer = bytes.slice().buffer;
    try {
      if (format === 'glb' || format === 'gltf') {
        const dir = url.slice(0, url.lastIndexOf('/') + 1);
        const gltf = await new GLTFLoader().parseAsync(buffer, dir);
        return { root: gltf.scene, animations: gltf.animations };
      }
      if (format === 'obj') return { root: new OBJLoader().parse(new TextDecoder().decode(bytes)), animations: [] };
    } catch (error) {
      throw loadError(url, `${format} model`, error);
    }
    throw formatError(url, 'model', format, ['.gltf', '.glb', '.obj']);
  }

  /** Lädt eine Bildtextur; `srgb` für Farbtexturen (`map`), sonst linear (Normalen, Rauheit). */
  texture(url: string, srgb: boolean): Promise<Texture> {
    const key = `${srgb ? 'srgb' : 'linear'}:${url}`;
    let p = this.textures.get(key);
    if (p === undefined) {
      p = new TextureLoader()
        .loadAsync(url)
        .then((tex) => {
          tex.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace;
          return tex;
        })
        .catch((error: unknown) => {
          throw loadError(url, 'texture', error);
        });
      this.textures.set(key, p);
    }
    return p;
  }

  /** Lädt eine HDR- (Radiance) oder EXR-Umgebung als Equirectangular-Textur. */
  environment(url: string): Promise<Texture> {
    let p = this.environments.get(url);
    if (p === undefined) {
      p = this.loadEnvironment(url);
      this.environments.set(url, p);
    }
    return p;
  }

  private async loadEnvironment(url: string): Promise<Texture> {
    const bytes = await this.bytes(url);
    const format = detectFormat(url, bytes);
    if (format !== 'hdr' && format !== 'exr') throw formatError(url, 'environment map', format, ['.hdr', '.exr']);
    let data;
    try {
      data = format === 'hdr' ? new HDRLoader().setDataType(HalfFloatType).parse(bytes.slice().buffer) : new EXRLoader().setDataType(HalfFloatType).parse(bytes.slice().buffer);
    } catch (error) {
      throw loadError(url, `${format} environment`, error);
    }
    const tex = new DataTexture(data.data ?? null, data.width ?? 1, data.height ?? 1, data.format ?? RGBAFormat, data.type ?? HalfFloatType);
    tex.colorSpace = LinearSRGBColorSpace;
    tex.mapping = EquirectangularReflectionMapping;
    tex.flipY = data.flipY ?? true;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** Lädt eine 3D-LUT im Format `.cube`. */
  lut(url: string): Promise<LoadedLut> {
    let p = this.luts.get(url);
    if (p === undefined) {
      p = this.bytes(url).then((bytes) => {
        const format = detectFormat(url, bytes);
        if (format !== 'cube') throw formatError(url, 'LUT', format, ['.cube']);
        try {
          const result = new LUTCubeLoader().parse(new TextDecoder().decode(bytes));
          return { size: result.size, texture: result.texture3D };
        } catch (error) {
          throw loadError(url, 'LUT', error);
        }
      });
      this.luts.set(url, p);
    }
    return p;
  }

  /** Gibt alle zwischengespeicherten GPU-Ressourcen frei. */
  async dispose(): Promise<void> {
    const settle = async <T>(p: Promise<T>): Promise<T | undefined> => {
      try {
        return await p;
      } catch (error) {
        // Fehlgeschlagene Ladevorgänge haben nichts zu entsorgen; der Fehler ging bereits an den Aufrufer.
        if (error instanceof OpenVideoError) return undefined;
        throw error;
      }
    };
    for (const p of this.textures.values()) (await settle(p))?.dispose();
    for (const p of this.environments.values()) (await settle(p))?.dispose();
    for (const p of this.luts.values()) (await settle(p))?.texture.dispose();
    for (const p of this.models.values()) {
      const m = await settle(p);
      m?.root.traverse((o) => {
        if (isMesh(o)) o.geometry.dispose();
      });
    }
    this.textures.clear();
    this.environments.clear();
    this.luts.clear();
    this.models.clear();
    this.bytesCache.clear();
  }
}
