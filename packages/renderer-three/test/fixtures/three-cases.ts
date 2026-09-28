/**
 * Testszenen für den Three.js-Renderer. Das Modul ist reine Daten (ohne DOM beim Import),
 * damit Node-Tests die Fallnamen kennen und die Browser-Seite die Szenen baut.
 */
import type { EvaluatedNode } from '@agentic-video/core';

export const FPS = 30;
export const WIDTH = 160;
export const HEIGHT = 120;

/** Ein Testfall: Szene als Funktion des Frames. */
export interface ThreeCase {
  readonly build: (frame: number) => EvaluatedNode;
  readonly frame?: number;
  readonly backends?: readonly ('webgpu' | 'webgl2')[];
  readonly scale?: number;
  readonly debug?: { readonly showCameraFrustum?: boolean; readonly showLightHelpers?: boolean };
}

let counter = 0;

/** Baut eine ausgewertete Node für einen Frame (lokale Zeit = Frame). */
export function ev(type: string, props: Record<string, unknown>, children: EvaluatedNode[] = [], frame = 0, id?: string): EvaluatedNode {
  counter++;
  return {
    id: id ?? `${type}-${String(counter)}`,
    type,
    props,
    children,
    time: { localFrame: frame, relFrame: frame, durationFrames: 60, progress: frame / 60, compositionFrame: frame },
    pointer: `/test/${String(counter)}`,
  };
}

const camera = (frame: number, props: Record<string, unknown> = {}): EvaluatedNode => ev('camera3d', { position: [0, 0, 4], target: [0, 0, 0], ...props }, [], frame, 'cam');
const keyLight = (frame: number): EvaluatedNode[] => [ev('light3d', { kind: 'ambient', intensity: 0.4 }, [], frame), ev('light3d', { kind: 'directional', position: [3, 4, 5], intensity: 2.5 }, [], frame)];

function scene(frame: number, children: EvaluatedNode[], props: Record<string, unknown> = {}): EvaluatedNode {
  return ev('scene3d', { width: WIDTH, height: HEIGHT, background: '#20242C', ...props }, children, frame, 'scene');
}

function standardScene(frame: number, objects: EvaluatedNode[], props: Record<string, unknown> = {}): EvaluatedNode {
  return scene(frame, [camera(frame), ...keyLight(frame), ...objects], props);
}

const GEOMETRIES: Record<string, Record<string, unknown>> = {
  box: { type: 'box', width: 1.4, height: 1.4, depth: 1.4 },
  sphere: { type: 'sphere', radius: 1 },
  plane: { type: 'plane', width: 2, height: 1.4 },
  cylinder: { type: 'cylinder', radiusTop: 0.6, radiusBottom: 0.9, height: 1.6 },
  cone: { type: 'cone', radius: 0.9, height: 1.6 },
  torus: { type: 'torus', radius: 0.8, tube: 0.3 },
  'torus-knot': { type: 'torus-knot', radius: 0.7, tube: 0.22, p: 2, q: 3 },
  capsule: { type: 'capsule', radius: 0.5, length: 0.9 },
};

const mesh = (frame: number, props: Record<string, unknown>): EvaluatedNode => ev('mesh3d', { geometry: { type: 'sphere', radius: 1 }, material: { color: '#E0E0E0' }, ...props }, [], frame);
const floor = (frame: number, extra: Record<string, unknown> = {}): EvaluatedNode =>
  mesh(frame, { geometry: { type: 'plane', width: 8, height: 8 }, rotation: [-90, 0, 0], position: [0, -1, 0], material: { color: '#9AA0A8', roughness: 0.9 }, receiveShadow: true, ...extra });

const cases: Record<string, ThreeCase> = {};

for (const [name, geometry] of Object.entries(GEOMETRIES)) {
  cases[`geometry-${name}`] = { build: (f) => standardScene(f, [mesh(f, { geometry, rotation: [25, 35, 0], material: { color: '#4C9BE8', roughness: 0.5 } })]) };
}

cases['light-ambient'] = { build: (f) => scene(f, [camera(f), ev('light3d', { kind: 'ambient', intensity: 1, color: '#FFD9A0' }), mesh(f, {})]) };
cases['light-directional'] = { build: (f) => scene(f, [camera(f), ev('light3d', { kind: 'directional', position: [-3, 2, 2], intensity: 3 }), mesh(f, {})]) };
cases['light-point'] = { build: (f) => scene(f, [camera(f), ev('light3d', { kind: 'point', position: [1.2, 1.2, 1.5], intensity: 8, color: '#FF7755' }), mesh(f, {})]) };
cases['light-spot'] = {
  build: (f) => scene(f, [camera(f, { position: [0, 2.5, 4] }), ev('light3d', { kind: 'spot', position: [0, 3, 0.5], target: [0, -1, 0], angle: 25, penumbra: 0.3, intensity: 30 }), floor(f), mesh(f, { geometry: { type: 'box' }, position: [0, -0.5, 0] })]),
};
cases['light-hemisphere'] = { build: (f) => scene(f, [camera(f), ev('light3d', { kind: 'hemisphere', color: '#88BBFF', groundColor: '#664422', intensity: 2 }), mesh(f, {})]) };

cases['shadows'] = {
  build: (f) =>
    scene(
      f,
      [
        camera(f, { position: [0, 2.5, 4.5], target: [0, -0.5, 0] }),
        ev('light3d', { kind: 'ambient', intensity: 0.3 }),
        ev('light3d', { kind: 'directional', position: [2, 5, 2], intensity: 2.5, castShadow: true }),
        floor(f),
        mesh(f, { geometry: { type: 'box' }, position: [0, -0.3, 0], rotation: [0, 30, 0], material: { color: '#E86A4C' }, castShadow: true }),
      ],
      { shadows: true },
    ),
};

cases['pbr'] = {
  build: (f) =>
    scene(
      f,
      [
        camera(f),
        mesh(f, { geometry: { type: 'sphere', radius: 0.6 }, position: [-1.4, 0, 0], material: { color: '#FFFFFF', metalness: 1, roughness: 0.05 } }),
        mesh(f, { geometry: { type: 'sphere', radius: 0.6 }, position: [0, 0, 0], material: { color: '#D4AF37', metalness: 1, roughness: 0.4, envMapIntensity: 1.5 } }),
        mesh(f, { geometry: { type: 'sphere', radius: 0.6 }, position: [1.4, 0, 0], material: { type: 'physical', color: '#3366CC', metalness: 0, roughness: 0.3, clearcoat: 1 } }),
      ],
      { environment: { preset: 'studio' } },
    ),
};
cases['physical-transmission'] = {
  build: (f) =>
    scene(f, [camera(f), mesh(f, { geometry: { type: 'torus-knot', radius: 0.7, tube: 0.25 }, material: { type: 'physical', color: '#AADDFF', transmission: 0.9, roughness: 0.1, clearcoat: 1 } })], {
      environment: { preset: 'sunset', showBackground: true },
    }),
};
cases['textures'] = {
  build: (f) => standardScene(f, [mesh(f, { geometry: { type: 'box', width: 1.6, height: 1.6, depth: 1.6 }, rotation: [25, 35, 0], material: { color: '#FFFFFF', map: 'checker', normalMap: 'normal', roughnessMap: 'rough', metalness: 0.2 } })]),
};
cases['material-basic-wireframe'] = {
  build: (f) =>
    standardScene(f, [
      mesh(f, { geometry: { type: 'sphere', radius: 0.8 }, position: [-0.9, 0, 0], material: { type: 'basic', color: '#55DD88' } }),
      mesh(f, { geometry: { type: 'torus', radius: 0.6, tube: 0.25 }, position: [0.9, 0, 0], material: { color: '#FFCC33', wireframe: true } }),
    ]),
};
cases['shader-material'] = {
  backends: ['webgl2'],
  frame: 15,
  build: (f) =>
    standardScene(
      f,
      [
        mesh(f, {
          geometry: { type: 'plane', width: 3, height: 2.2 },
          material: {
            type: 'shader',
            uniforms: { tint: [1, 0.5, 0.2] },
            fragmentShader: 'uniform float time; uniform vec3 tint; varying vec2 vUv; void main() { float s = 0.5 + 0.5 * sin(vUv.x * 20.0 + time * 6.0); gl_FragColor = vec4(tint * s + vec3(0.0, 0.0, vUv.y), 1.0); }',
          },
        }),
      ],
      { backend: 'webgl2' },
    ),
};

cases['shader-material-webgpu'] = {
  // Nur für den Fehlerfall: GLSL unter erzwungenem WebGPU (kein Golden).
  backends: [],
  build: (f) => {
    const base = cases['shader-material']?.build(f);
    if (base === undefined) throw new Error('shader-material missing');
    return { ...base, props: { ...base.props, backend: 'webgpu' } };
  },
};

cases['gltf-animation'] = {
  frame: 20,
  build: (f) => standardScene(f, [ev('model3d', { asset: 'skinned', animation: { clip: 'bend', loop: true }, rotation: [0, 20, 0], position: [0, -1, 0] }, [], f)]),
};
cases['gltf-node-clip'] = {
  frame: 10,
  build: (f) => standardScene(f, [ev('model3d', { asset: 'skinned', animation: { clip: 'spin', offset: '0.5s', speed: 2 }, position: [0, -1, 0] }, [], f)]),
};
cases['morph-target'] = {
  build: (f) =>
    standardScene(f, [
      ev('model3d', { asset: 'morph', position: [-0.9, 0, 0], scale: [0.8, 0.8, 0.8] }, [], f),
      ev('model3d', { asset: 'morph', morphTargets: { spiky: 1 }, position: [0.9, 0, 0], scale: [0.8, 0.8, 0.8] }, [], f),
    ]),
};
cases['obj-model'] = {
  build: (f) => standardScene(f, [ev('model3d', { asset: 'pyramid', rotation: [15, 30, 0], material: { color: '#CC66FF', roughness: 0.4 } }, [], f)]),
};

cases['instances-grid'] = {
  frame: 12,
  build: (f) => standardScene(f, [ev('instances3d', { geometry: { type: 'box', width: 0.35, height: 0.35, depth: 0.35 }, material: { color: '#E8B04C' }, count: 20, layout: { type: 'grid', columns: 5, spacing: 0.55 }, spin: 90 }, [], f)]),
};
cases['instances-random-box'] = {
  build: (f) => standardScene(f, [ev('instances3d', { geometry: { type: 'box', width: 0.2, height: 0.2, depth: 0.2 }, material: { color: '#4CE8B0' }, count: 80, seed: 3, layout: { type: 'random-box', size: [3.5, 2.5, 1], scale: { min: 0.5, max: 1.5 } } }, [], f)]),
};
cases['instances-random-sphere'] = {
  build: (f) => standardScene(f, [ev('instances3d', { geometry: { type: 'sphere', radius: 0.08, segments: 8 }, material: { color: '#E84C8B' }, count: 300, seed: 5, layout: { type: 'random-sphere', radius: 1.3 } }, [], f)]),
};
cases['instances-explicit'] = {
  frame: 30,
  build: (f) =>
    standardScene(f, [
      ev(
        'instances3d',
        {
          geometry: { type: 'cone', radius: 0.3, height: 0.6 },
          material: { color: '#8BE84C' },
          count: 3,
          spin: 45,
          layout: { type: 'explicit', transforms: [{ position: [-1, 0, 0] }, { position: [0, 0.3, 0], rotation: [0, 0, 180] }, { position: [1, 0, 0], scale: [1.5, 1.5, 1.5] }] },
        },
        [],
        f,
      ),
    ]),
};

cases['particles'] = {
  frame: 30,
  build: (f) =>
    scene(
      f,
      [
        camera(f),
        ev('particles3d', { count: 400, seed: 9, emitter: { shape: 'sphere', size: 0.2 }, lifetime: { min: 1, max: 2 }, speed: { min: 0.5, max: 1.2 }, gravity: [0, -0.8, 0], size: { start: 0.12, end: 0.02 }, color: { start: '#FFE08A', end: '#FF3D00' }, additive: true }, [], f),
      ],
      { background: '#05060A' },
    ),
};

const glowScene = (f: number, props: Record<string, unknown>): EvaluatedNode =>
  scene(
    f,
    [
      camera(f),
      ev('light3d', { kind: 'ambient', intensity: 0.5 }),
      mesh(f, { geometry: { type: 'sphere', radius: 0.5 }, position: [-1, 0, 0], material: { color: '#000000', emissive: '#FF5533', emissiveIntensity: 4 } }),
      mesh(f, { geometry: { type: 'torus', radius: 0.45, tube: 0.12 }, position: [1, 0, 0], material: { color: '#000000', emissive: '#33AAFF', emissiveIntensity: 4 } }),
      mesh(f, { geometry: { type: 'box', width: 0.6, height: 0.6, depth: 0.6 }, material: { color: '#888888' } }),
    ],
    { background: '#000000', ...props },
  );
cases['bloom'] = { build: (f) => glowScene(f, { postprocessing: { bloom: { strength: 1.5, radius: 0.5, threshold: 0.6 } } }) };

const depthRow = (f: number): EvaluatedNode[] =>
  [-2, 0, 2, 4].map((z, i) => mesh(f, { geometry: { type: 'box', width: 0.7, height: 0.7, depth: 0.7 }, position: [-1.5 + i * 1.1, 0, -z], rotation: [20, 30, 0], material: { color: ['#E84C4C', '#4CE86A', '#4C8BE8', '#E8D84C'][i] } }));
cases['depth-of-field'] = { build: (f) => standardScene(f, depthRow(f), { postprocessing: { depthOfField: { focus: 4, aperture: 0.05, maxBlur: 0.02 } } }) };
cases['color-grading'] = { build: (f) => standardScene(f, depthRow(f), { postprocessing: { colorGrading: { exposure: 0.5, contrast: 1.4, saturation: 0.3 } } }) };
cases['lut'] = { build: (f) => standardScene(f, depthRow(f), { postprocessing: { colorGrading: { lut: 'warm' } } }) };
cases['vignette'] = { build: (f) => standardScene(f, depthRow(f), { background: '#C8CCD4', postprocessing: { vignette: { offset: 1.6, darkness: 1 } } }) };
cases['fog'] = {
  build: (f) =>
    standardScene(
      f,
      [0, 1, 2, 3, 4, 5].map((i) => mesh(f, { geometry: { type: 'box', width: 0.8, height: 0.8, depth: 0.8 }, position: [-1.2 + i * 0.5, -0.2, -i * 2.5], material: { color: '#E86A4C' } })),
      { background: '#B0C4DE', fog: { color: '#B0C4DE', near: 3, far: 14 } },
    ),
};
cases['transparent-background'] = {
  build: (f) => scene(f, [camera(f), ...keyLight(f), mesh(f, { geometry: { type: 'torus', radius: 0.8, tube: 0.3 }, rotation: [60, 0, 0], material: { color: '#FF8844' } })], { background: undefined }),
};
cases['environment-hdr'] = {
  build: (f) => scene(f, [camera(f), mesh(f, { material: { color: '#FFFFFF', metalness: 1, roughness: 0.15 } })], { environment: { hdri: 'sky-hdr', showBackground: true } }),
};
cases['environment-exr'] = {
  build: (f) => scene(f, [camera(f), mesh(f, { material: { color: '#FFFFFF', metalness: 1, roughness: 0.15 } })], { environment: { hdri: 'sky-exr', showBackground: true, intensity: 1.2 } }),
};
cases['environment-neutral'] = {
  build: (f) => scene(f, [camera(f), mesh(f, { material: { color: '#FFFFFF', metalness: 1, roughness: 0.2 } })], { environment: { preset: 'neutral', showBackground: true } }),
};
cases['environment-sunset'] = {
  build: (f) => scene(f, [camera(f), mesh(f, { material: { color: '#FFFFFF', metalness: 1, roughness: 0.2 } })], { environment: { preset: 'sunset', showBackground: true } }),
};
for (const tm of ['none', 'aces', 'agx', 'neutral']) {
  cases[`tone-mapping-${tm}`] = {
    build: (f) =>
      scene(f, [camera(f), ev('light3d', { kind: 'directional', position: [2, 3, 4], intensity: 8 }), mesh(f, { material: { color: '#FF9955' } }), mesh(f, { geometry: { type: 'box', width: 0.6, height: 0.6, depth: 0.6 }, position: [1.3, 0.6, 0], material: { color: '#55CCFF' } })], {
        toneMapping: tm,
      }),
  };
}
cases['camera-orthographic'] = {
  build: (f) =>
    scene(f, [ev('camera3d', { projection: 'orthographic', position: [4, 4, 4], target: [0, 0, 0], zoom: 2.5 }, [], f, 'ortho'), ...keyLight(f), mesh(f, { geometry: { type: 'box' }, material: { color: '#4C9BE8' } }), floor(f, { position: [0, -0.5, 0] })], {
      camera: 'ortho',
    }),
};
cases['group3d'] = {
  frame: 15,
  build: (f) =>
    standardScene(f, [
      ev('group3d', { rotation: [0, 0, 30], position: [0, 0.2, 0] }, [mesh(f, { geometry: { type: 'box', width: 0.5, height: 0.5, depth: 0.5 }, position: [-0.8, 0, 0], material: { color: '#E84C4C' } }), mesh(f, { geometry: { type: 'box', width: 0.5, height: 0.5, depth: 0.5 }, position: [0.8, 0, 0], material: { color: '#4C8BE8' } })], f),
    ]),
};
cases['debug-helpers'] = {
  debug: { showCameraFrustum: true, showLightHelpers: true },
  build: (f) =>
    scene(f, [
      camera(f, { position: [5, 4, 6] }),
      ev('camera3d', { position: [0, 0.5, 2], target: [0, 0, -2], fov: 40, far: 3 }, [], f, 'second'),
      ev('light3d', { kind: 'directional', position: [-2, 2, 1], intensity: 2 }),
      ev('light3d', { kind: 'point', position: [1.5, 1, 0], intensity: 3 }),
      ev('light3d', { kind: 'spot', position: [0, 2.5, -1], target: [0, 0, -1], angle: 20, intensity: 5 }),
      mesh(f, { geometry: { type: 'box', width: 0.5, height: 0.5, depth: 0.5 }, position: [0, 0, -2] }),
    ]),
};
cases['preview-scale'] = { scale: 0.5, build: (f) => standardScene(f, [mesh(f, { geometry: { type: 'torus-knot', radius: 0.7, tube: 0.22 }, material: { color: '#4C9BE8' } })]) };

/** Alle Testfälle nach Name. */
export const THREE_CASES: Readonly<Record<string, ThreeCase>> = cases;
