/**
 * glTF-Import (FR-85): `scene3d` mit `model3d`, Kameras und Punktlichtern (KHR_lights_punctual).
 * Der GLB-Container wird hier selbst gelesen (nur der JSON-Chunk wird gebraucht).
 */
import { isRecord, linearToSrgb, formatColor, type Diagnostic } from '@agentic-video/core';
import { importError, lossy, makeAsset, round, type ImportedAsset, type JsonNode } from './common.js';

/** Optionen für {@link importGltf}. */
export interface GltfImportOptions {
  /** ID des Modell-Assets. Die Nodes erhalten IDs mit diesem Präfix. */
  readonly assetId: string;
  /** Größe der `scene3d`-Box in Pixeln (Standard 1920 × 1080). */
  readonly width?: number;
  readonly height?: number;
}

/** Ein Animation Clip aus dem glTF. */
export interface GltfClip {
  readonly name: string;
  readonly index: number;
  /** Länge in Sekunden (größte Eingabezeit der Sampler). */
  readonly duration: number;
}

/** Ergebnis von {@link importGltf}. */
export interface GltfImportResult {
  readonly nodes: JsonNode[];
  readonly assets: ImportedAsset[];
  readonly clips: GltfClip[];
  readonly diagnostics: Diagnostic[];
}

type Rec = Record<string, unknown>;
type Mat4 = readonly number[];

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/**
 * Liest den JSON-Chunk eines GLB-Containers.
 *
 * @example
 * ```ts
 * const json = readGlbJson(bytes); // { asset: { version: '2.0' }, ... }
 * ```
 */
export function readGlbJson(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw importError('OV_IMPORT_PARSE', 'The data is not a GLB container (magic "glTF" missing).', 'Pass a .glb file or glTF JSON.');
  const version = view.getUint32(4, true);
  if (version !== 2) throw importError('OV_IMPORT_PARSE', `GLB version ${String(version)} is not supported.`, 'Export as glTF 2.0.');
  const total = Math.min(view.getUint32(8, true), bytes.byteLength);
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== CHUNK_JSON || 20 + chunkLength > total) throw importError('OV_IMPORT_PARSE', 'The first GLB chunk is not a valid JSON chunk.', 'Re-export the GLB file.');
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength));
  return parseJsonText(text.replace(/[\s\p{Cc}]+$/u, ''));
}

function parseJsonText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw importError('OV_IMPORT_PARSE', `The glTF JSON is invalid: ${error instanceof Error ? error.message : String(error)}.`, 'Re-export the glTF file.');
  }
}

function records(o: Rec, key: string): Rec[] {
  const v = o[key];
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function nums(v: unknown, length: number): number[] | undefined {
  return Array.isArray(v) && v.length === length && v.every((x): x is number => typeof x === 'number') ? v : undefined;
}

function num(o: Rec, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Spaltenweise 4×4-Matrizen wie im glTF.
function mul(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
    out[c * 4 + r] = s;
  }
  return out;
}

function trs(node: Rec): number[] {
  const m = nums(node['matrix'], 16);
  if (m !== undefined) return m;
  const [tx = 0, ty = 0, tz = 0] = nums(node['translation'], 3) ?? [];
  const [qx = 0, qy = 0, qz = 0, qw = 1] = nums(node['rotation'], 4) ?? [];
  const [sx = 1, sy = 1, sz = 1] = nums(node['scale'], 3) ?? [];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

interface WorldPose {
  readonly position: [number, number, number];
  /** Euler XYZ in Grad (Three.js-Konvention). */
  readonly rotation: [number, number, number];
  /** Blickrichtung (−Z der Node) in Weltkoordinaten. */
  readonly forward: [number, number, number];
  readonly scaled: boolean;
}

function pose(m: Mat4): WorldPose {
  const col = (c: number): [number, number, number] => [m[c * 4] ?? 0, m[c * 4 + 1] ?? 0, m[c * 4 + 2] ?? 0];
  const len = (v: readonly number[]) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  const [x, y, z] = [col(0), col(1), col(2)];
  const [lx, ly, lz] = [len(x), len(y), len(z)];
  // Normierte Rotationsmatrix, Element (Zeile r, Spalte c) = mRC
  const m11 = x[0] / lx;
  const m12 = y[0] / ly;
  const m22 = y[1] / ly;
  const m32 = y[2] / ly;
  const m13 = z[0] / lz;
  const m23 = z[1] / lz;
  const m33 = z[2] / lz;
  const deg = (r: number) => round((r * 180) / Math.PI, 4);
  const ry = Math.asin(Math.min(Math.max(m13, -1), 1));
  const [rx, rz] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
  return {
    position: [round(m[12] ?? 0, 6), round(m[13] ?? 0, 6), round(m[14] ?? 0, 6)],
    rotation: [deg(rx), deg(ry), deg(rz)],
    forward: [-m13, -m23, -m33],
    scaled: [lx, ly, lz].some((l) => Math.abs(l - 1) > 1e-6),
  };
}

function lightColor(c: number[] | undefined): string {
  const [r = 1, g = 1, b = 1] = c ?? [];
  return formatColor({ r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b), a: 1 });
}

/**
 * Importiert ein glTF- oder GLB-Modell als `scene3d` mit `model3d`, Kameras (`camera3d`)
 * und KHR_lights_punctual-Lichtern (`light3d`). Die Animation Clips stehen in `clips`
 * und in `meta.animationClips` der `scene3d`-Node.
 *
 * @example
 * ```ts
 * const { nodes, assets, clips } = importGltf(glbBytes, { assetId: 'robot' });
 * // nodes[0] = { id: 'robot-scene', type: 'scene3d', children: [{ type: 'model3d', asset: 'robot' }, ...] }
 * ```
 */
export function importGltf(input: Uint8Array | string | object, options: GltfImportOptions): GltfImportResult {
  let json: unknown;
  let bytes: Uint8Array;
  let ext: string;
  if (input instanceof Uint8Array) {
    bytes = input;
    const isGlb = input.byteLength >= 4 && new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, true) === GLB_MAGIC;
    json = isGlb ? readGlbJson(input) : parseJsonText(new TextDecoder().decode(input));
    ext = isGlb ? 'glb' : 'gltf';
  } else if (typeof input === 'string') {
    json = parseJsonText(input);
    bytes = new TextEncoder().encode(input);
    ext = 'gltf';
  } else {
    json = input;
    bytes = new TextEncoder().encode(JSON.stringify(input));
    ext = 'gltf';
  }
  if (!isRecord(json) || !isRecord(json['asset'])) throw importError('OV_IMPORT_PARSE', 'The glTF JSON has no "asset" object.', 'Pass a glTF 2.0 file.');
  const gltf = json;
  const diagnostics: Diagnostic[] = [];
  const id = options.assetId;
  for (const [i, buffer] of records(gltf, 'buffers').entries()) {
    const uri = buffer['uri'];
    if (typeof uri === 'string' && !uri.startsWith('data:')) {
      diagnostics.push(lossy(`gltf.buffers[${String(i)}]`, `External buffer "${uri}" is not part of the imported asset.`, `Import "${uri}" next to the model or export a self-contained .glb.`));
    }
  }
  for (const [i, image] of records(gltf, 'images').entries()) {
    const uri = image['uri'];
    if (typeof uri === 'string' && !uri.startsWith('data:')) {
      diagnostics.push(lossy(`gltf.images[${String(i)}]`, `External texture "${uri}" is not part of the imported asset.`, `Import "${uri}" next to the model or export a self-contained .glb.`));
    }
  }

  const nodes = records(gltf, 'nodes');
  const cameras = records(gltf, 'cameras');
  const extensions = isRecord(gltf['extensions']) ? gltf['extensions'] : {};
  const lightExt = isRecord(extensions['KHR_lights_punctual']) ? extensions['KHR_lights_punctual'] : {};
  const lights = records(lightExt, 'lights');
  const scenes = records(gltf, 'scenes');
  const scene = scenes[num(gltf, 'scene') ?? 0];
  const children: JsonNode[] = [{ id: `${id}-model`, type: 'model3d', asset: id }];
  const cameraNodes: JsonNode[] = [];
  const lightNodes: JsonNode[] = [];
  const visit = (index: number, parent: Mat4, depth: number): void => {
    const node = nodes[index];
    if (node === undefined || depth > 64) return;
    const world = mul(parent, trs(node));
    const p = pose(world);
    const name = typeof node['name'] === 'string' ? node['name'] : `node${String(index)}`;
    const path = `gltf.nodes[${String(index)}] "${name}"`;
    const cameraIndex = num(node, 'camera');
    const camera = cameraIndex !== undefined ? cameras[cameraIndex] : undefined;
    if (camera !== undefined) {
      const cam: JsonNode = { id: `${id}-camera-${String(cameraNodes.length + 1)}`, type: 'camera3d', name, position: p.position, rotation: p.rotation };
      const persp = isRecord(camera['perspective']) ? camera['perspective'] : undefined;
      const ortho = isRecord(camera['orthographic']) ? camera['orthographic'] : undefined;
      if (persp !== undefined) {
        const yfov = num(persp, 'yfov');
        if (yfov !== undefined) cam['fov'] = round((yfov * 180) / Math.PI, 4);
        const near = num(persp, 'znear');
        const far = num(persp, 'zfar');
        if (near !== undefined && near > 0) cam['near'] = near;
        if (far !== undefined && far > 0) cam['far'] = far;
        if (num(persp, 'aspectRatio') !== undefined) diagnostics.push(lossy(path, 'The camera aspect ratio is replaced by the scene3d box aspect ratio.', 'Set scene3d width and height to the wanted aspect ratio.'));
      } else if (ortho !== undefined) {
        cam['projection'] = 'orthographic';
        const near = num(ortho, 'znear');
        const far = num(ortho, 'zfar');
        if (near !== undefined && near > 0) cam['near'] = near;
        if (far !== undefined && far > 0) cam['far'] = far;
        diagnostics.push(lossy(path, `Orthographic extents (xmag ${String(num(ortho, 'xmag') ?? '?')}, ymag ${String(num(ortho, 'ymag') ?? '?')}) are not mapped; adjust zoom manually.`, 'Set camera3d.zoom after import.'));
      }
      if (p.scaled) diagnostics.push(lossy(path, 'Camera node scale is ignored.', 'Remove the scale from the camera node.'));
      cameraNodes.push(cam);
    }
    const nodeExt = isRecord(node['extensions']) ? node['extensions'] : {};
    const lightRef = isRecord(nodeExt['KHR_lights_punctual']) ? num(nodeExt['KHR_lights_punctual'], 'light') : undefined;
    const light = lightRef !== undefined ? lights[lightRef] : undefined;
    if (light !== undefined) {
      const kind = light['type'];
      if (kind === 'directional' || kind === 'point' || kind === 'spot') {
        const l: JsonNode = { id: `${id}-light-${String(lightNodes.length + 1)}`, type: 'light3d', name, kind, position: p.position, color: lightColor(nums(light['color'], 3)) };
        const intensity = num(light, 'intensity');
        if (intensity !== undefined) l['intensity'] = Math.max(0, intensity);
        const range = num(light, 'range');
        if (range !== undefined && range > 0) l['distance'] = range;
        if (kind !== 'point') l['target'] = p.position.map((v, i) => round(v + (p.forward[i] ?? 0), 6));
        const spot = isRecord(light['spot']) ? light['spot'] : undefined;
        if (kind === 'spot') {
          const outer = spot !== undefined ? (num(spot, 'outerConeAngle') ?? Math.PI / 4) : Math.PI / 4;
          const inner = spot !== undefined ? (num(spot, 'innerConeAngle') ?? 0) : 0;
          l['angle'] = round(Math.min((outer * 180) / Math.PI, 90), 4);
          l['penumbra'] = round(outer > 0 ? Math.min(Math.max(1 - inner / outer, 0), 1) : 0, 4);
        }
        lightNodes.push(l);
      } else {
        diagnostics.push(lossy(path, `Light type "${String(kind)}" is not supported.`, 'Use directional, point or spot lights.'));
      }
    }
    const kids = node['children'];
    if (Array.isArray(kids)) for (const k of kids) if (typeof k === 'number') visit(k, world, depth + 1);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const roots = scene !== undefined && Array.isArray(scene['nodes']) ? scene['nodes'] : [];
  for (const r of roots) if (typeof r === 'number') visit(r, identity, 0);
  children.push(...cameraNodes, ...lightNodes);
  if (lightNodes.length > 0) {
    diagnostics.push({
      code: 'OV_IMPORT_GLTF_LIGHTS',
      severity: 'info',
      errorClass: 'ImportError',
      problem: `${String(lightNodes.length)} KHR_lights_punctual light(s) were extracted as light3d nodes; loaders that also read glTF lights may light the model twice.`,
      path: 'gltf.extensions.KHR_lights_punctual',
      suggestions: ['Remove the extracted light3d nodes or strip the lights from the model file if the scene looks too bright.'],
    });
  }

  const accessors = records(gltf, 'accessors');
  const clips: GltfClip[] = records(gltf, 'animations').map((anim, index) => {
    let duration = 0;
    for (const sampler of records(anim, 'samplers')) {
      const input = num(sampler, 'input');
      const accessor = input !== undefined ? accessors[input] : undefined;
      const max = accessor !== undefined && Array.isArray(accessor['max']) && typeof accessor['max'][0] === 'number' ? accessor['max'][0] : 0;
      duration = Math.max(duration, max);
    }
    return { name: typeof anim['name'] === 'string' ? anim['name'] : `animation${String(index)}`, index, duration: round(duration, 6) };
  });

  const [firstCamera] = cameraNodes;
  const scene3d: JsonNode = {
    id: `${id}-scene`,
    type: 'scene3d',
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    ...(firstCamera !== undefined ? { camera: firstCamera['id'] } : {}),
    meta: { source: 'gltf', animationClips: clips },
    children,
  };
  const asset = makeAsset(id, 'model', ext, bytes, { animationClips: clips });
  return { nodes: [scene3d], assets: [asset], clips, diagnostics };
}
