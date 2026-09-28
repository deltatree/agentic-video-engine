/**
 * Fähigkeiten und Version des Three.js-Renderers (FR-38..FR-42, FR-44).
 */
import { REVISION } from 'three';

/**
 * Version der gebündelten Three.js-Bibliothek als `0.<REVISION>`, z. B. `0.186`
 * (für Manifest und Cache-Schlüssel). Three.js veröffentlicht nur die Revision als Konstante.
 *
 * @example
 * ```ts
 * const versions = { three: THREE_VERSION };
 * ```
 */
export const THREE_VERSION: string = `0.${REVISION}`;

/**
 * Benannte Fähigkeiten des Three.js-Renderers.
 *
 * `three.motion-blur.temporal` bedeutet: Bewegungsunschärfe entsteht im Compositor
 * durch Zeit-Supersampling (mehrere Renderaufrufe pro Frame), nicht in diesem Paket.
 *
 * @example
 * ```ts
 * if (THREE_CAPABILITIES.includes('three.webgpu')) console.info('WebGPU bevorzugt');
 * ```
 */
export const THREE_CAPABILITIES: readonly string[] = [
  'three.webgl2',
  'three.webgpu',
  'three.camera.perspective',
  'three.camera.orthographic',
  'three.light.ambient',
  'three.light.directional',
  'three.light.point',
  'three.light.spot',
  'three.light.hemisphere',
  'three.shadows',
  'three.geometry.box',
  'three.geometry.sphere',
  'three.geometry.plane',
  'three.geometry.cylinder',
  'three.geometry.cone',
  'three.geometry.torus',
  'three.geometry.torus-knot',
  'three.geometry.capsule',
  'three.material.standard',
  'three.material.physical',
  'three.material.basic',
  'three.material.shader',
  'three.textures',
  'three.gltf',
  'three.glb',
  'three.obj',
  'three.animation.clips',
  'three.animation.skeletal',
  'three.morph-targets',
  'three.geometry-cache',
  'three.instancing',
  'three.particles',
  'three.environment.preset',
  'three.environment.hdr',
  'three.environment.exr',
  'three.reflections.envmap',
  'three.fog',
  'three.tone-mapping',
  'three.postprocessing.bloom',
  'three.postprocessing.depth-of-field',
  'three.postprocessing.color-grading',
  'three.postprocessing.lut',
  'three.postprocessing.vignette',
  'three.motion-blur.temporal',
  'three.transparent-background',
  'three.debug.camera-frustum',
  'three.debug.light-helpers',
];
