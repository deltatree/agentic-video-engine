/**
 * Browser-Einstieg der Three.js-Tests: erzeugt Test-Assets im Browser (glTF per GLTFExporter,
 * EXR per EXRExporter, HDR, OBJ, LUT, Bilder) als Blob-URLs und rendert Testfälle.
 */
import {
  AnimationClip,
  Bone,
  CylinderGeometry,
  DataTexture,
  Float32BufferAttribute,
  FloatType,
  Group,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  RGBAFormat,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { EXRExporter } from 'three/examples/jsm/exporters/EXRExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ThreeLayerRenderer } from '../../src/index.js';
import { FPS, HEIGHT, THREE_CASES, WIDTH } from './three-cases.js';

function blobUrl(data: BlobPart, type: string): string {
  return URL.createObjectURL(new Blob([data], { type }));
}

async function canvasPng(size: number, draw: (ctx: CanvasRenderingContext2D) => void): Promise<string> {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  draw(ctx);
  const blob = await new Promise<Blob | null>((resolve) => { c.toBlob(resolve, 'image/png'); });
  if (blob === null) throw new Error('toBlob failed');
  return URL.createObjectURL(blob);
}

async function skinnedGlb(): Promise<ArrayBuffer> {
  const geometry = new CylinderGeometry(0.25, 0.25, 2, 12, 8);
  geometry.translate(0, 1, 0);
  const pos = geometry.getAttribute('position');
  const indices: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const w = Math.min(Math.max(pos.getY(i) - 0.5, 0), 1);
    indices.push(0, 1, 0, 0);
    weights.push(1 - w, w, 0, 0);
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const root = new Bone();
  root.name = 'root';
  const tip = new Bone();
  tip.name = 'tip';
  tip.position.y = 1;
  root.add(tip);
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ color: 0xe8a04c }));
  mesh.name = 'arm';
  mesh.add(root);
  mesh.bind(new Skeleton([root, tip]));
  const group = new Group();
  group.name = 'rig';
  group.add(mesh);
  const q0 = new Quaternion();
  const q1 = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
  const bend = new AnimationClip('bend', 2, [new QuaternionKeyframeTrack('tip.quaternion', [0, 1, 2], [...q0.toArray(), ...q1.toArray(), ...q0.toArray()])]);
  const spin = new AnimationClip('spin', 2, [
    new QuaternionKeyframeTrack('rig.quaternion', [0, 1, 2], [...q0.toArray(), ...new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI).toArray(), ...new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI * 2 - 0.001).toArray()]),
    new QuaternionKeyframeTrack('tip.quaternion', [0, 2], [...q0.toArray(), ...new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 3).toArray()]),
  ]);
  const out = await new GLTFExporter().parseAsync(group, { binary: true, animations: [bend, spin] });
  if (!(out instanceof ArrayBuffer)) throw new Error('expected GLB');
  return out;
}

async function morphGlb(): Promise<ArrayBuffer> {
  const geometry = new SphereGeometry(1, 32, 16);
  const pos = geometry.getAttribute('position');
  const spiky: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const k = 1 + 0.35 * Math.sign(Math.sin(v.x * 6) * Math.sin(v.y * 6) * Math.sin(v.z * 6));
    spiky.push(v.x * k, v.y * k, v.z * k);
  }
  geometry.morphAttributes['position'] = [new Float32BufferAttribute(spiky, 3)];
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: 0x4ce8b0, roughness: 0.4 }));
  mesh.name = 'blob';
  mesh.updateMorphTargets();
  if (mesh.morphTargetDictionary !== undefined) {
    mesh.morphTargetDictionary['spiky'] = 0;
  }
  const out = await new GLTFExporter().parseAsync(mesh, { binary: true, animations: [new AnimationClip('pulse', 1, [new NumberKeyframeTrack('blob.morphTargetInfluences[0]', [0, 1], [0, 1])])] });
  if (!(out instanceof ArrayBuffer)) throw new Error('expected GLB');
  return out;
}

const PYRAMID_OBJ = ['o pyramid', 'v -1 -0.8 -1', 'v 1 -0.8 -1', 'v 1 -0.8 1', 'v -1 -0.8 1', 'v 0 1 0', 'f 1 2 3', 'f 1 3 4', 'f 1 5 2', 'f 2 5 3', 'f 3 5 4', 'f 4 5 1', ''].join('\n');

/** Himmel: blau oben, heller Horizont, dunkler Boden, helle Sonne. Werte linear. */
function skyPixel(u: number, v: number): [number, number, number] {
  const y = 1 - v * 2;
  const base: [number, number, number] = y > 0 ? [0.3 + 0.7 * (1 - y), 0.5 + 0.5 * (1 - y), 1.0] : [0.25, 0.2, 0.15];
  const du = u - 0.25;
  const dv = v - 0.3;
  const sun = Math.exp(-(du * du + dv * dv) * 800) * 40;
  return [base[0] + sun, base[1] + sun * 0.9, base[2] + sun * 0.7];
}

/** Radiance-HDR (RGBE, unkomprimiert). */
function skyHdr(width: number, height: number): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${String(height)} +X ${String(width)}\n`);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = skyPixel(x / width, y / height);
      const m = Math.max(r, g, b);
      const i = (y * width + x) * 4;
      if (m < 1e-32) continue;
      const e = Math.ceil(Math.log2(m));
      const f = 256 / Math.pow(2, e);
      data.set([Math.min(255, Math.floor(r * f)), Math.min(255, Math.floor(g * f)), Math.min(255, Math.floor(b * f)), e + 128], i);
    }
  }
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

async function skyExr(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // DataTexture-Zeilen beginnen unten; der Himmel soll oben liegen.
      const [r, g, b] = skyPixel(x / width, 1 - (y + 0.5) / height);
      data.set([r * 0.6, g * 0.8, b, 1], (y * width + x) * 4);
    }
  }
  const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
  tex.needsUpdate = true;
  return new EXRExporter().parse(tex, { type: FloatType });
}

/** Warme 3D-LUT (Größe 8). */
function warmCube(): string {
  const n = 8;
  const lines = ['TITLE "warm"', `LUT_3D_SIZE ${String(n)}`];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const R = r / (n - 1);
        const G = g / (n - 1);
        const B = b / (n - 1);
        lines.push(`${Math.min(1, R * 1.1 + 0.05).toFixed(4)} ${(G * 0.95).toFixed(4)} ${(B * 0.7).toFixed(4)}`);
      }
    }
  }
  return lines.join('\n');
}

async function createAssets(): Promise<Record<string, string>> {
  return {
    checker: await canvasPng(64, (ctx) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#F2F2F2' : '#E8604C';
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }),
    normal: await canvasPng(64, (ctx) => {
      ctx.fillStyle = 'rgb(128,128,255)';
      ctx.fillRect(0, 0, 64, 64);
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = 'rgb(200,128,220)';
        ctx.fillRect(i * 8, 0, 3, 64);
        ctx.fillStyle = 'rgb(56,128,220)';
        ctx.fillRect(i * 8 + 4, 0, 3, 64);
      }
    }),
    rough: await canvasPng(64, (ctx) => {
      ctx.fillStyle = '#202020';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#F0F0F0';
      ctx.fillRect(0, 0, 32, 64);
    }),
    skinned: blobUrl(await skinnedGlb(), 'model/gltf-binary'),
    morph: blobUrl(await morphGlb(), 'model/gltf-binary'),
    pyramid: blobUrl(PYRAMID_OBJ, 'text/plain'),
    'sky-hdr': blobUrl(skyHdr(128, 64), 'application/octet-stream'),
    'sky-exr': blobUrl(await skyExr(128, 64), 'application/octet-stream'),
    warm: blobUrl(warmCube(), 'text/plain'),
  };
}

function toBase64(bytes: Uint8ClampedArray): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const assetsPromise = createAssets();
const renderers = new Map<string, ThreeLayerRenderer>();

function rendererFor(backend: string): ThreeLayerRenderer {
  let r = renderers.get(backend);
  if (r === undefined) {
    r = new ThreeLayerRenderer({ preferredBackend: backend === 'webgpu' || backend === 'webgl2' ? backend : 'auto' });
    renderers.set(backend, r);
  }
  return r;
}

async function render(name: string, backend: string, frame?: number): Promise<{ width: number; height: number; data: string; backend: string | undefined }> {
  const c = THREE_CASES[name];
  if (c === undefined) throw new Error(`unknown case ${name}`);
  const assets = await assetsPromise;
  const f = frame ?? c.frame ?? 0;
  const renderer = rendererFor(backend);
  const node = c.build(f);
  const props = backend === 'auto' || node.props['backend'] !== undefined ? node.props : { ...node.props, backend };
  const canvas = await renderer.render({
    node: { ...node, props },
    width: WIDTH,
    height: HEIGHT,
    scale: c.scale ?? 1,
    frame: f,
    time: f / FPS,
    fps: FPS,
    seed: 1,
    assetUrl: (id) => assets[id] ?? `/missing/${id}`,
    ...(c.debug !== undefined ? { debug: c.debug } : {}),
  });
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2d context');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: toBase64(img.data), backend: renderer.activeBackend };
}

async function renderError(name: string, backend: string): Promise<string> {
  try {
    await render(name, backend);
    return 'no error';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'diagnostic' in error && typeof error.diagnostic === 'object' && error.diagnostic !== null && 'code' in error.diagnostic) return String(error.diagnostic.code);
    return String(error);
  }
}

Object.assign(window, { ovRender: render, ovRenderError: renderError, ovReady: true });
