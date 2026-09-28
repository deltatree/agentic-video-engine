import { describe, expect, it } from 'vitest';
import { importGltf, LOSSY_CODE, readGlbJson } from '@agentic-video/importers';
import { find, validateImport } from './helpers.js';

const s = Math.SQRT1_2;

/** Selbst gebautes Modell: Kamera, drei Lichter, externe Textur, zwei Animation Clips. */
const GLTF = {
  asset: { version: '2.0', generator: 'test' },
  scene: 0,
  scenes: [{ nodes: [0, 1, 2] }],
  nodes: [
    { name: 'Robot', mesh: 0, children: [3] },
    { name: 'MainCamera', camera: 0, translation: [0, 1, 5] },
    { name: 'Sun', translation: [0, 10, 0], rotation: [-s, 0, 0, s], extensions: { KHR_lights_punctual: { light: 0 } } },
    { name: 'HeadLamp', translation: [0, 2, 1], extensions: { KHR_lights_punctual: { light: 1 } } },
  ],
  cameras: [{ type: 'perspective', perspective: { yfov: 0.8, znear: 0.05, zfar: 200 } }],
  extensionsUsed: ['KHR_lights_punctual'],
  extensions: {
    KHR_lights_punctual: {
      lights: [
        { type: 'directional', color: [1, 1, 1], intensity: 3 },
        { type: 'spot', color: [1, 0.5, 0.2], intensity: 20, range: 8, spot: { innerConeAngle: Math.PI / 8, outerConeAngle: Math.PI / 4 } },
      ],
    },
  },
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  images: [{ uri: 'textures/robot.png' }],
  accessors: [
    { count: 3, componentType: 5126, type: 'VEC3' },
    { count: 2, componentType: 5126, type: 'SCALAR', min: [0], max: [2.5] },
    { count: 2, componentType: 5126, type: 'SCALAR', min: [0], max: [1.25] },
  ],
  animations: [
    { name: 'Walk', samplers: [{ input: 1, output: 0 }], channels: [] },
    { samplers: [{ input: 2, output: 0 }], channels: [] },
  ],
};

function glb(json: unknown): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + padded).fill(0x20);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  return out;
}

describe('importGltf', () => {
  const bytes = glb(GLTF);
  const result = importGltf(bytes, { assetId: 'robot', width: 1280, height: 720 });

  it('reads the JSON chunk of a GLB container', () => {
    expect(readGlbJson(bytes)).toEqual(GLTF);
  });

  it('produces schema-valid IR', () => {
    expect(validateImport(result.nodes, result.assets)).toEqual([]);
  });

  it('creates scene3d with the model asset and the first camera', () => {
    expect(result.nodes[0]).toMatchObject({ id: 'robot-scene', type: 'scene3d', width: 1280, height: 720, camera: 'robot-camera-1' });
    expect(find(result.nodes, 'robot-model')).toEqual({ id: 'robot-model', type: 'model3d', asset: 'robot' });
    expect(result.assets[0]?.asset).toMatchObject({ id: 'robot', type: 'model', src: 'assets/robot.glb' });
    expect(result.assets[0]?.bytes).toBe(bytes);
  });

  it('imports cameras with world transform and perspective settings', () => {
    const cam = find(result.nodes, 'robot-camera-1');
    expect(cam).toMatchObject({ type: 'camera3d', name: 'MainCamera', position: [0, 1, 5], rotation: [0, 0, 0], near: 0.05, far: 200 });
    expect(Number(cam?.['fov'])).toBeCloseTo((0.8 * 180) / Math.PI, 3);
  });

  it('imports KHR_lights_punctual lights, including nested nodes', () => {
    const sun = find(result.nodes, 'robot-light-2');
    expect(sun).toMatchObject({ type: 'light3d', kind: 'directional', name: 'Sun', position: [0, 10, 0], color: '#FFFFFF', intensity: 3 });
    expect((sun?.['target'] as number[]).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 9, 0]);
    const lamp = find(result.nodes, 'robot-light-1');
    expect(lamp).toMatchObject({ kind: 'spot', name: 'HeadLamp', position: [0, 2, 1], distance: 8, angle: 45, penumbra: 0.5, intensity: 20 });
    expect(lamp?.['color']).toMatch(/^#FF[0-9A-F]{4}$/u);
  });

  it('lists animation clips in metadata', () => {
    const clips = [
      { name: 'Walk', index: 0, duration: 2.5 },
      { name: 'animation1', index: 1, duration: 1.25 },
    ];
    expect(result.clips).toEqual(clips);
    expect(result.nodes[0]?.['meta']).toEqual({ source: 'gltf', animationClips: clips });
  });

  it('reports external resources as lossy and flags extracted lights', () => {
    const lossyDiags = result.diagnostics.filter((d) => d.code === LOSSY_CODE);
    expect(lossyDiags).toHaveLength(1);
    expect(lossyDiags[0]?.problem).toContain('textures/robot.png');
    expect(result.diagnostics.find((d) => d.code === 'OV_IMPORT_GLTF_LIGHTS')?.severity).toBe('info');
  });

  it('accepts glTF JSON text and rejects foreign data', () => {
    const fromJson = importGltf(JSON.stringify(GLTF), { assetId: 'robot' });
    expect(fromJson.assets[0]?.asset.src).toBe('assets/robot.gltf');
    expect(() => importGltf(new Uint8Array([1, 2, 3, 4]), { assetId: 'x' })).toThrow(/glTF JSON is invalid/u);
    expect(() => importGltf({ nodes: [] }, { assetId: 'x' })).toThrow(/"asset"/u);
  });
});
