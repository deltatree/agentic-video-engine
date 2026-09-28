/**
 * Tests für checkThreeNode (jede Einschränkung) und die reinen Hilfsfunktionen.
 */
import type { EvaluatedNode } from '@agentic-video/core';
import { describe, expect, it } from 'vitest';
import { THREE_CAPABILITIES, THREE_VERSION, checkThreeNode, detectFormat, instanceTransforms, particles3d, requiresWebGL2 } from '../src/index.js';

const scene = (props: Record<string, unknown>, children: Record<string, unknown>[] = []): Record<string, unknown> => ({ id: 'hero', type: 'scene3d', width: 640, height: 360, ...props, children });
const codes = (node: Record<string, unknown>): string[] => checkThreeNode(node).map((d) => d.code);
const shaderMesh = { id: 'm', type: 'mesh3d', geometry: { type: 'plane' }, material: { type: 'shader', fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }' } };

describe('checkThreeNode', () => {
  it('akzeptiert eine gültige Szene ohne Meldungen', () => {
    expect(checkThreeNode(scene({}, [{ id: 'c', type: 'camera3d' }, { id: 'm', type: 'mesh3d', geometry: { type: 'box' } }]))).toEqual([]);
  });

  it('OV_THREE_NODE_TYPE: nur scene3d', () => {
    expect(codes({ id: 'r', type: 'rect', width: 1, height: 1 })).toEqual(['OV_THREE_NODE_TYPE']);
  });

  it('OV_THREE_UNSUPPORTED: 2D-Kind in scene3d, auch verschachtelt', () => {
    const d = checkThreeNode(scene({}, [{ id: 'g', type: 'group3d', children: [{ id: 'label', type: 'text', text: 'Hi' }] }]));
    expect(d.map((x) => x.code)).toEqual(['OV_THREE_UNSUPPORTED']);
    expect(d[0]?.nodeId).toBe('label');
    expect(d[0]?.pointer).toBe('/children/0/children/0');
  });

  it('OV_THREE_CAMERA_UNKNOWN: camera nennt keine camera3d', () => {
    const d = checkThreeNode(scene({ camera: 'nope' }, [{ id: 'main', type: 'camera3d' }]));
    expect(d.map((x) => x.code)).toEqual(['OV_THREE_CAMERA_UNKNOWN']);
    expect(d[0]?.suggestions[0]).toContain('main');
  });

  it('OV_THREE_BACKEND_FEATURE: GLSL unter webgpu ist ein Fehler', () => {
    const d = checkThreeNode(scene({ backend: 'webgpu' }, [shaderMesh]));
    expect(d.map((x) => [x.code, x.severity])).toEqual([['OV_THREE_BACKEND_FEATURE', 'error']]);
  });

  it('OV_THREE_BACKEND_FALLBACK: GLSL unter auto fällt auf WebGL2 zurück (info)', () => {
    expect(checkThreeNode(scene({}, [shaderMesh])).map((x) => [x.code, x.severity])).toEqual([['OV_THREE_BACKEND_FALLBACK', 'info']]);
    expect(codes(scene({ backend: 'webgl2' }, [shaderMesh]))).toEqual([]);
  });

  it('OV_THREE_SHADER_MISSING: shader ohne fragmentShader', () => {
    expect(codes(scene({ backend: 'webgl2' }, [{ id: 'm', type: 'mesh3d', geometry: { type: 'plane' }, material: { type: 'shader' } }]))).toEqual(['OV_THREE_SHADER_MISSING']);
  });

  it('OV_THREE_FOG_RANGE: far ≤ near', () => {
    expect(codes(scene({ fog: { color: '#FFFFFF', near: 10, far: 5 } }))).toEqual(['OV_THREE_FOG_RANGE']);
    expect(codes(scene({ fog: { color: '#FFFFFF', near: 1, far: 5 } }))).toEqual([]);
  });

  it('OV_THREE_SHADOWS_OFF: castShadow ohne shadows', () => {
    const child = { id: 'l', type: 'light3d', kind: 'directional', castShadow: true };
    expect(codes(scene({}, [child]))).toEqual(['OV_THREE_SHADOWS_OFF']);
    expect(codes(scene({ shadows: true }, [child]))).toEqual([]);
  });

  it('OV_THREE_ENVIRONMENT_CONFLICT: hdri und preset', () => {
    expect(codes(scene({ environment: { hdri: 'sky', preset: 'studio' } }))).toEqual(['OV_THREE_ENVIRONMENT_CONFLICT']);
  });

  it('requiresWebGL2 erkennt GLSL in Modellen und Instanzen', () => {
    expect(requiresWebGL2(scene({}, [{ id: 'i', type: 'instances3d', material: { type: 'shader' } }]))).toBe(true);
    expect(requiresWebGL2(scene({}, [{ id: 'm', type: 'model3d', asset: 'a' }]))).toBe(false);
  });
});

describe('Konstanten', () => {
  it('nennen Version und Fähigkeiten', () => {
    expect(THREE_VERSION).toMatch(/^0\.\d+$/u);
    for (const c of ['three.webgl2', 'three.webgpu', 'three.gltf', 'three.postprocessing.bloom', 'three.motion-blur.temporal', 'three.reflections.envmap']) expect(THREE_CAPABILITIES).toContain(c);
  });
});

describe('detectFormat', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it('nutzt die Dateiendung', () => {
    expect(detectFormat('/a/robot.GLB?x=1', new Uint8Array())).toBe('glb');
    expect(detectFormat('/a/sky.exr', new Uint8Array())).toBe('exr');
  });
  it('erkennt Formate an den Bytes', () => {
    expect(detectFormat('/assets/a', enc('glTF\u0002\u0000'))).toBe('glb');
    expect(detectFormat('/assets/a', new Uint8Array([0x76, 0x2f, 0x31, 0x01, 0]))).toBe('exr');
    expect(detectFormat('/assets/a', enc('#?RADIANCE\n'))).toBe('hdr');
    expect(detectFormat('/assets/a', enc(' {"asset":{"version":"2.0"}}'))).toBe('gltf');
    expect(detectFormat('/assets/a', enc('TITLE "x"\nLUT_3D_SIZE 2\n'))).toBe('cube');
    expect(detectFormat('/assets/a', enc('# comment\nv 0 0 0\n'))).toBe('obj');
    expect(detectFormat('/assets/a', new Uint8Array([1, 2, 3]))).toBe('unknown');
  });
});

function ev(type: string, props: Record<string, unknown>, frame = 0): EvaluatedNode {
  return { id: type, type, props, children: [], time: { localFrame: frame, relFrame: frame, durationFrames: 60, progress: 0, compositionFrame: frame }, pointer: '' };
}

describe('particles3d', () => {
  const node = ev('particles3d', { count: 50, seed: 4, gravity: [0, -1, 0] });
  it('ist zustandslos und deterministisch', () => {
    expect(particles3d(node, 1.2, 30, 0)).toEqual(particles3d(node, 1.2, 30, 0));
  });
  it('gebiert Partikel über die Dauer der Node und lässt sie sterben', () => {
    expect(particles3d(node, 0, 30, 0)).toHaveLength(1);
    const alive = particles3d(node, 1, 30, 0);
    expect(alive.length).toBeGreaterThan(10);
    for (const p of alive) expect(p.size).toBeLessThanOrEqual(0.05);
  });
  it('nutzt den Eingabe-Seed nur ohne eigenen seed', () => {
    const noSeed = ev('particles3d', { count: 20 });
    expect(particles3d(noSeed, 1, 30, 1)).not.toEqual(particles3d(noSeed, 1, 30, 2));
    expect(particles3d(node, 1, 30, 1)).toEqual(particles3d(node, 1, 30, 2));
  });
});

describe('instanceTransforms', () => {
  it('grid ist zentriert, Zeilen laufen nach unten', () => {
    const t = instanceTransforms(ev('instances3d', { count: 4, layout: { type: 'grid', columns: 2, spacing: 2 } }), 0, 0);
    expect(t.map((x) => x.position)).toEqual([
      [-1, 1, 0],
      [1, 1, 0],
      [-1, -1, 0],
      [1, -1, 0],
    ]);
  });
  it('spin dreht um Y mit Grad pro Sekunde', () => {
    const t = instanceTransforms(ev('instances3d', { count: 1, spin: 90, layout: { type: 'explicit', transforms: [{ position: [1, 2, 3] }] } }), 2, 0);
    expect(t[0]).toEqual({ position: [1, 2, 3], rotation: [0, 180, 0], scale: [1, 1, 1] });
  });
  it('random-sphere bleibt in der Kugel und ist deterministisch', () => {
    const node = ev('instances3d', { count: 100, seed: 2, layout: { type: 'random-sphere', radius: 2, scale: { min: 0.5, max: 1 } } });
    const t = instanceTransforms(node, 0, 0);
    expect(t).toEqual(instanceTransforms(node, 0, 0));
    for (const x of t) {
      expect(Math.hypot(...x.position)).toBeLessThanOrEqual(2);
      expect(x.scale[0]).toBeGreaterThanOrEqual(0.5);
    }
  });
  it('random-box bleibt im Quader', () => {
    for (const x of instanceTransforms(ev('instances3d', { count: 50, layout: { type: 'random-box', size: [2, 4, 6] } }), 0, 7)) {
      expect(Math.abs(x.position[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(x.position[2])).toBeLessThanOrEqual(3);
    }
  });
});
