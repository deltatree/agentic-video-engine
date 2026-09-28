import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateScene, isOpenVideoError, type AssetRecord, type AssetResolver, type EvaluatedNode, type FontResolver, type RgbaImage } from '@agentic-video/core';
import { decodePng, encodePng } from '@agentic-video/png';
import {
  checkBlenderNode,
  createBlenderBackend,
  describeScene,
  detectBlender,
  evaluateMotionStates,
  placeImage,
  type BlenderLayerRequest,
} from '@agentic-video/renderer-blender';

const GOLDEN_DIR = join(import.meta.dirname, 'golden');
const UPDATE = process.env['UPDATE_GOLDENS'] === '1';
const W = 160;
const H = 90;

const detection = detectBlender();
const blenderAvailable = detection.found;
const SKIP_REASON = 'Blender fehlt (OV_BLENDER_MISSING): Blender 4.2 LTS nach ~/.local/opt/ entpacken oder OPENVIDEO_BLENDER setzen.';
if (!blenderAvailable) console.warn(`Blender-Tests übersprungen: ${SKIP_REASON}`);

const workDir = mkdtempSync(join(tmpdir(), 'ov-blender-test-'));
const assetFiles = new Map<string, string>();

const assets: AssetResolver = {
  get(id) {
    const path = assetFiles.get(id);
    if (path === undefined) return undefined;
    const record: AssetRecord = { id, type: 'model', src: path, path, hash: id, metadata: {} };
    return record;
  },
  bytes: (id) => Promise.resolve(readFileSync(assetFiles.get(id) ?? '')),
  videoFrame: () => Promise.reject(new Error('no video in these tests')),
  all: () => [],
};
const fonts: FontResolver = { all: () => [], has: () => false, fallbacks: () => [] };

function project(blender: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    compositions: [{ id: 'main', width: W, height: H, fps: 30, duration: 30, seed: 7, nodes: [{ id: 'b', type: 'blender', width: W, height: H, samples: 32, ...blender }], ...extra }],
  };
}

function request(p: Record<string, unknown>, frame = 0): BlenderLayerRequest {
  const scene = evaluateScene(p, 'main', frame);
  return { layerId: 'layer', scene, nodes: scene.nodes, width: scene.width, height: scene.height, scale: 1, assets, fonts };
}

/** Kamera, Sonne, Umgebungslicht und ein gedrehter Würfel. */
function cubeScene(extra: Record<string, unknown> = {}, children: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    background: '#101418',
    children: [
      { id: 'cam', type: 'camera3d', position: [3, 2.2, 4], target: [0, 0, 0], fov: 40 },
      { id: 'sun', type: 'light3d', kind: 'directional', position: [2, 4, 3], intensity: 3 },
      { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.6 },
      { id: 'cube', type: 'mesh3d', geometry: { type: 'box', width: 1.4, height: 1.4, depth: 1.4 }, rotation: [0, 20, 0], material: { color: '#3B82F6', roughness: 0.45 } },
      ...children,
    ],
    ...extra,
  };
}

/** Vergleicht mit dem Golden Image (Toleranz für Rauschen); schreibt es mit UPDATE_GOLDENS=1. */
function expectGolden(name: string, image: RgbaImage): void {
  const path = join(GOLDEN_DIR, `${name}.png`);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, encodePng(image));
    if (!UPDATE) throw new Error(`Golden ${name}.png fehlte und wurde erzeugt; bitte visuell prüfen.`);
    return;
  }
  const golden = decodePng(readFileSync(path));
  expect([image.width, image.height]).toEqual([golden.width, golden.height]);
  const d = diff(image, golden, 16);
  expect(d.meanAbs, `${name}: mittlere Abweichung`).toBeLessThan(2);
  expect(d.fraction, `${name}: Anteil stark abweichender Pixel`).toBeLessThan(0.01);
}

/** Pixel-Differenz: Anteil der Pixel mit einem Kanal > `threshold`, mittlere Abweichung, Maximum. */
function diff(a: RgbaImage, b: RgbaImage, threshold: number): { fraction: number; meanAbs: number; max: number } {
  let over = 0;
  let sum = 0;
  let max = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < pixels; i++) {
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((a.data[i * 4 + c] ?? 0) - (b.data[i * 4 + c] ?? 0));
      sum += d;
      worst = Math.max(worst, d);
    }
    if (worst > threshold) over++;
    max = Math.max(max, worst);
  }
  return { fraction: over / pixels, meanAbs: sum / (pixels * 4), max };
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(o, o + 4));
}

describe('check()', () => {
  const backend = createBlenderBackend({ workDir });

  it('meldet nicht übertragbare Features mit Vorschlag scene3d', () => {
    const node = {
      id: 'b',
      type: 'blender',
      width: 100,
      height: 100,
      postprocessing: { bloom: { strength: 1 } },
      children: [
        { id: 'many', type: 'instances3d', count: 20000, geometry: { type: 'box' }, layout: { type: 'grid', columns: 100, spacing: 1 } },
        { id: 'few', type: 'instances3d', count: 50, geometry: { type: 'box' }, layout: { type: 'grid', columns: 10, spacing: 1 } },
        { id: 'sparks', type: 'particles3d', count: 100 },
        { id: 'glsl', type: 'mesh3d', geometry: { type: 'box' }, material: { type: 'shader', fragmentShader: 'void main() {}' } },
      ],
    };
    const result = backend.check(node);
    expect(result.supported).toBe(false);
    const unsupported = result.diagnostics.filter((d) => d.code === 'OV_BLENDER_UNSUPPORTED');
    expect(unsupported.map((d) => d.nodeId).sort()).toEqual(['b', 'glsl', 'many', 'sparks']);
    for (const d of unsupported) expect(d.suggestions.join(' ')).toContain('scene3d');
  });

  it('meldet falschen Typ, unbekannte Kamera, fehlende Maske und Näherungen', () => {
    expect(checkBlenderNode({ id: 'x', type: 'scene3d' })[0]?.code).toBe('OV_BLENDER_NODE_TYPE');
    const codes = checkBlenderNode({
      id: 'b',
      type: 'blender',
      camera: 'nope',
      pass: 'object-mask',
      toneMapping: 'aces',
      environment: { preset: 'studio' },
      children: [
        { id: 'cam', type: 'camera3d' },
        { id: 'hemi', type: 'light3d', kind: 'hemisphere' },
        { id: 'r', type: 'rect', width: 1, height: 1 },
      ],
    }).map((d) => `${d.severity}:${d.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'error:OV_BLENDER_CAMERA_UNKNOWN',
        'error:OV_BLENDER_MASK_OBJECT',
        'error:OV_BLENDER_UNSUPPORTED',
        'warning:OV_BLENDER_IGNORED',
        'info:OV_BLENDER_APPROXIMATED',
      ]),
    );
  });

  it('akzeptiert eine gültige Szene', () => {
    const result = backend.check({ id: 'b', type: 'blender', width: 10, height: 10, ...cubeScene() });
    expect(result.supported).toBe(true);
    expect(result.diagnostics.map((d) => `${d.severity}:${d.code}`)).toEqual(['info:OV_BLENDER_APPROXIMATED']);
    expect(backend.fusable).toBe(false);
    expect(backend.nodeTypes).toEqual(['blender']);
    expect(backend.capabilities).toEqual(expect.arrayContaining(['blender.cycles', 'blender.eevee', 'blender.passes.depth', 'blender.motion-blur', 'blender.gltf', 'blender.transparent']));
  });
});

describe('Szenenbeschreibung und Platzierung', () => {
  it('rechnet Farben linear und Lichter in Blender-Einheiten um', () => {
    const scene = evaluateScene(
      project({
        children: [
          { id: 'amb', type: 'light3d', kind: 'ambient', intensity: Math.PI, color: '#FFFFFF' },
          { id: 'p', type: 'light3d', kind: 'point', intensity: 2, color: '#FF0000' },
          { id: 'm', type: 'mesh3d', geometry: { type: 'sphere' }, material: { color: '#808080' } },
        ],
      }),
      'main',
      0,
    );
    const node = scene.nodes[0];
    if (node === undefined) throw new Error('blender node missing');
    const state = describeScene(node, { width: W, height: H, fps: 30, seed: 1, assets });
    expect(state.world.ambient.map((v) => Number(v.toFixed(6)))).toEqual([1, 1, 1]);
    expect(state.world.transparent).toBe(true);
    expect(state.camera).toBeNull();
    const point = state.objects.find((o) => o.key === 'b:p');
    expect(point?.light?.energy).toBeCloseTo(8 * Math.PI, 6);
    expect(point?.light?.color).toEqual([1, 0, 0]);
    expect(state.objects.find((o) => o.key === 'b:m')?.material?.color[0]).toBeCloseTo(0.2158605, 5);
    expect(state.engine).toBe('cycles');
  });

  it('platziert das Bild mit der Node-Matrix und Deckkraft', () => {
    const image: RgbaImage = { width: 2, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) };
    const node: EvaluatedNode = {
      id: 'b',
      type: 'blender',
      props: { width: 2, height: 2, x: 3, y: 1, opacity: 0.5 },
      children: [],
      time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 },
      pointer: '/b',
    };
    const out = placeImage(image, node, 6, 4, 1);
    expect(pixel(out, 3, 1)).toEqual([128, 0, 0, 128]);
    expect(pixel(out, 4, 2)).toEqual([128, 128, 128, 128]);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 5, 3)).toEqual([0, 0, 0, 0]);
  });

  it('meldet fehlendes Blender mit Installationshinweis', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ov-no-blender-'));
    const result = detectBlender({ blenderPath: join(empty, 'blender'), env: { PATH: '', HOME: empty } });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.diagnostic.code).toBe('OV_BLENDER_MISSING');
    expect(result.diagnostic.suggestions.join(' ')).toContain('download.blender.org');
  });
});

describe.skipIf(!blenderAvailable)('Blender-Render (Blender 4.2)', () => {
  const backend = createBlenderBackend({ workDir, threads: 4 });

  beforeAll(() => {
    if (!detection.found) return;
    // Selbst erzeugtes glTF-Modell: Suzanne mit Clip "spin" (eine Umdrehung in 24 Frames bei 24 fps).
    const glb = join(workDir, 'suzanne.glb');
    const script = [
      'import bpy, math',
      'for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)',
      'bpy.context.scene.render.fps = 24',
      'bpy.ops.mesh.primitive_monkey_add(size=1.6)',
      'o = bpy.context.active_object',
      'bpy.ops.object.shade_smooth()',
      'm = bpy.data.materials.new("gold"); m.use_nodes = True',
      'b = m.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value = (0.9, 0.55, 0.1, 1); b.inputs["Roughness"].default_value = 0.35',
      'o.data.materials.append(m)',
      'o.rotation_euler = (0, 0, 0); o.keyframe_insert("rotation_euler", frame=0)',
      'o.rotation_euler = (0, 0, 2 * math.pi); o.keyframe_insert("rotation_euler", frame=24)',
      'for fc in o.animation_data.action.fcurves:',
      '    for k in fc.keyframe_points: k.interpolation = "LINEAR"',
      'o.animation_data.action.name = "spin"',
      `bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, export_format="GLB", export_animation_mode="ACTIONS")`,
    ].join('\n');
    execFileSync(detection.path, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python-expr', script], { stdio: 'ignore' });
    assetFiles.set('suzanne', glb);
    writeFileSync(join(workDir, 'broken.glb'), 'glTF this is not a valid binary glTF');
    assetFiles.set('broken', join(workDir, 'broken.glb'));
  });

  it('meldet die Blender-Version', () => {
    expect(backend.versions()['blender']).toMatch(/^4\.2\.\d+$/);
  });

  it('Cycles: Würfel mit Licht und Kamera', async () => {
    expectGolden('cycles-cube', await backend.renderLayer(request(project(cubeScene()))));
  });

  it('Eevee: Würfel mit Licht und Kamera', async () => {
    expectGolden('eevee-cube', await backend.renderLayer(request(project(cubeScene({ engine: 'eevee', samples: 8 })))));
  });

  it('Material-Varianten (Cycles und Eevee)', async () => {
    const variants = [
      { color: '#E5E7EB', metalness: 1, roughness: 0.2 },
      { color: '#EF4444', roughness: 1 },
      { color: '#111111', emissive: '#22C55E', emissiveIntensity: 3 },
      { type: 'physical', color: '#FFFFFF', roughness: 0.05, transmission: 1 },
      { type: 'physical', color: '#7C3AED', roughness: 0.6, clearcoat: 1 },
      { color: '#F59E0B', opacity: 0.4 },
      { type: 'basic', color: '#06B6D4' },
    ];
    const children = [
      { id: 'cam', type: 'camera3d', position: [0, 0.6, 7], target: [0, 0, 0], fov: 32 },
      { id: 'sun', type: 'light3d', kind: 'directional', position: [3, 5, 4], intensity: 3 },
      { id: 'hemi', type: 'light3d', kind: 'hemisphere', color: '#DDEEFF', groundColor: '#332211', intensity: 2 },
      { id: 'floor', type: 'mesh3d', geometry: { type: 'plane', width: 12, height: 4 }, rotation: [-90, 0, 0], position: [0, -0.45, 0], material: { color: '#9CA3AF' } },
      ...variants.map((material, i) => ({ id: `s${String(i)}`, type: 'mesh3d', geometry: { type: 'sphere', radius: 0.42 }, position: [(i - 3) * 1, 0, 0], material })),
    ];
    const images = await backend.renderFrames([
      request(project({ background: '#1F2937', children })),
      request(project({ background: '#1F2937', engine: 'eevee', samples: 8, children })),
    ]);
    expectGolden('cycles-materials', images[0] ?? { width: 0, height: 0, data: new Uint8Array() });
    expectGolden('eevee-materials', images[1] ?? { width: 0, height: 0, data: new Uint8Array() });
  });

  it('glTF-Modell mit Animationsclip zur OpenVideo-Zeit', async () => {
    const children = [
      { id: 'cam', type: 'camera3d', position: [0, 0.5, 4], target: [0, 0, 0], fov: 40 },
      { id: 'sun', type: 'light3d', kind: 'directional', position: [1, 3, 4], intensity: 3 },
      { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.8 },
      { id: 'monkey', type: 'model3d', asset: 'suzanne', animation: { clip: 'spin', loop: true } },
    ];
    // Frame 5 bei 30 fps = 1/6 s = 60° des Clips.
    const [still, turned] = await backend.renderFrames([request(project({ background: '#0B1020', children }), 0), request(project({ background: '#0B1020', children }), 5)]);
    if (still === undefined || turned === undefined) throw new Error('missing frames');
    expectGolden('cycles-gltf-frame0', still);
    expectGolden('cycles-gltf-frame5', turned);
    expect(diff(still, turned, 16).fraction).toBeGreaterThan(0.02);
  });

  it('transparenter Hintergrund ohne background (vormultipliziert)', async () => {
    const image = await backend.renderLayer(request(project(cubeScene({ background: undefined }))));
    expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, W / 2, H / 2)[3]).toBe(255);
    for (let i = 0; i < image.data.length; i += 4) {
      const a = image.data[i + 3] ?? 0;
      expect(Math.max(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0)).toBeLessThanOrEqual(a);
    }
    expectGolden('cycles-transparent', image);
  });

  it('Volumen-Nebel und linearer Nebel', async () => {
    const spot = { id: 'spot', type: 'light3d', kind: 'spot', position: [0, 4, 0], target: [0, 0, 0], angle: 25, penumbra: 0.3, intensity: 60 };
    const volume = await backend.renderLayer(request(project(cubeScene({ volume: { density: 0.12, color: '#FFFFFF', anisotropy: 0.3 }, samples: 64 }, [spot]))));
    expectGolden('cycles-volume', volume);
    const plain = await backend.renderLayer(request(project(cubeScene({}, [spot]))));
    expect(diff(volume, plain, 16).fraction).toBeGreaterThan(0.05);
    const fog = await backend.renderLayer(request(project(cubeScene({ fog: { color: '#C0C8D0', near: 3, far: 8 } }))));
    expectGolden('cycles-fog', fog);
  });

  it('Pässe: Tiefe, Normale, Objektmaske', async () => {
    const extra = [{ id: 'ball', type: 'mesh3d', geometry: { type: 'sphere', radius: 0.8 }, position: [-1.2, 0.2, -1.4], material: { color: '#FFFFFF' } }];
    const [depth, normal, mask, eeveeMask] = await backend.renderFrames([
      request(project(cubeScene({ pass: 'depth' }, extra))),
      request(project(cubeScene({ pass: 'normal' }, extra))),
      request(project(cubeScene({ pass: 'object-mask', maskObject: 'ball' }, extra))),
      request(project(cubeScene({ pass: 'object-mask', maskObject: 'ball', engine: 'eevee', samples: 8 }, extra))),
    ]);
    if (depth === undefined || normal === undefined || mask === undefined || eeveeMask === undefined) throw new Error('missing passes');
    expectGolden('cycles-pass-depth', depth);
    expectGolden('cycles-pass-normal', normal);
    expectGolden('cycles-pass-object-mask', mask);
    expectGolden('eevee-pass-object-mask', eeveeMask);
    // Tiefe: nah dunkel, Hintergrund weiß, deckend.
    const center = pixel(depth, W / 2, H / 2);
    expect(center[0]).toBeLessThan(160);
    expect(pixel(depth, 0, 0)).toEqual([255, 255, 255, 255]);
    // Normale: Hintergrund (0,0,0) → 128.
    expect(pixel(normal, 0, 0).map((v) => Math.round(v / 4))).toEqual([32, 32, 32, 64]);
    // Maske: nur die Kugel ist weiß, der Würfel verdeckt sie teilweise (Holdout).
    expect(pixel(mask, W / 2, H / 2)).toEqual([0, 0, 0, 255]);
    const white = Array.from({ length: W * H }, (_, i) => mask.data[i * 4] ?? 0).filter((v) => v > 250).length;
    expect(white).toBeGreaterThan(100);
  });

  it('Motion Blur aus Subframe-Zuständen', async () => {
    const moving = project({
      background: '#101418',
      motionBlur: true,
      children: [
        { id: 'cam', type: 'camera3d', position: [0, 0, 6], target: [0, 0, 0], fov: 40 },
        { id: 'sun', type: 'light3d', kind: 'directional', position: [1, 2, 4], intensity: 3 },
        { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.8 },
        {
          id: 'cube',
          type: 'mesh3d',
          geometry: { type: 'box', width: 1, height: 1, depth: 1 },
          position: { $keyframes: [{ t: 0, v: [-3, 0, 0] }, { t: 10, v: [3, 0, 0] }] },
          material: { color: '#F97316' },
        },
      ],
    });
    const sharp = request(moving, 5);
    const motionStates = evaluateMotionStates(moving, 'main', 5, ['b'], [-0.5, 0.5]);
    expect(motionStates).toHaveLength(2);
    const [blurred, still] = await backend.renderFrames([{ ...sharp, motionStates }, sharp]);
    if (blurred === undefined || still === undefined) throw new Error('missing frames');
    expectGolden('cycles-motion-blur', blurred);
    // Weiche Kanten: mehr Zwischenwerte in der Mittelzeile.
    const soft = (img: RgbaImage) => Array.from({ length: W }, (_, x) => pixel(img, x, H / 2)[0] ?? 0).filter((v) => v > 40 && v < 200).length;
    expect(soft(blurred)).toBeGreaterThan(soft(still) + 6);
  });

  it('ist deterministisch (zweimal rendern)', async () => {
    const knot = [{ id: 'knot', type: 'mesh3d', geometry: { type: 'torus-knot', radius: 0.5, tube: 0.15 }, position: [-1.5, 0, -1], material: { color: '#EAB308', roughness: 0.3, metalness: 0.5 } }];
    for (const engine of ['cycles', 'eevee']) {
      const p = project(cubeScene({ engine, samples: engine === 'eevee' ? 8 : 32 }, knot));
      // Zwei getrennte Blender-Prozesse.
      const a = await backend.renderLayer(request(p));
      const b = await backend.renderLayer(request(p));
      const d = diff(a, b, 2);
      console.info(`Determinismus ${engine}: ${String(d.fraction * 100)} % Pixel mit Kanal > 2, maximale Abweichung ${String(d.max)}`);
      expect(d.fraction).toBeLessThanOrEqual(0.001);
    }
  });

  it('Batch von 3 Frames startet Blender genau einmal', async () => {
    const before = backend.launches;
    const p = project(cubeScene({ samples: 4 }));
    const images = await backend.renderFrames([request(p, 0), request(p, 1), request(p, 2)]);
    expect(images).toHaveLength(3);
    expect(backend.launches - before).toBe(1);
  });

  it('meldet Prozessfehler mit Blender-stderr', async () => {
    const p = project({ children: [{ id: 'bad', type: 'model3d', asset: 'broken' }] });
    const error: unknown = await backend.renderLayer(request(p)).catch((e: unknown) => e);
    expect(isOpenVideoError(error)).toBe(true);
    if (!isOpenVideoError(error)) return;
    expect(error.diagnostic.code).toBe('OV_BLENDER_PROCESS_FAILED');
    expect(String(error.diagnostic.details?.['stderr'])).toContain('Error');
  });

  it('bricht nach dem Timeout je Frame ab', async () => {
    const slow = createBlenderBackend({ workDir, threads: 1, frameTimeoutMs: 50 });
    const error: unknown = await slow.renderLayer(request(project(cubeScene()))).catch((e: unknown) => e);
    expect(isOpenVideoError(error) && error.diagnostic.code).toBe('OV_BLENDER_TIMEOUT');
  });
});

describe('Ohne Blender (Regression: Umgebung darf nicht scheitern)', () => {
  it('liefert leere Versionen statt eines Fehlers', () => {
    const backend = createBlenderBackend({ workDir: '/tmp/ov-no-blender', blenderPath: '/nicht/vorhanden/blender', env: { PATH: '/nicht/vorhanden', HOME: '/nicht/vorhanden' } });
    expect(backend.versions()).toEqual({});
  });
});
