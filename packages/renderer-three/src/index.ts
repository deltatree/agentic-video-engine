/**
 * @packageDocumentation
 * Three.js-Renderer von OpenVideo (FR-38..FR-42): baut aus ausgewerteten `scene3d`-Nodes eine
 * Three.js-Szene und rendert sie mit WebGPU oder WebGL2 auf ein Canvas. Läuft nur im Browser;
 * den Chromium-Host stellt `@agentic-video/renderer-browser` bereit.
 *
 * @example
 * ```ts
 * import { ThreeLayerRenderer, checkThreeNode } from '@agentic-video/renderer-three';
 * const diagnostics = checkThreeNode(irNode);
 * const canvas = await new ThreeLayerRenderer().render({ node, width: 640, height: 360, scale: 1, frame: 0, time: 0, fps: 30, seed: 1, assetUrl: (id) => `/assets/${id}` });
 * ```
 */
export { THREE_CAPABILITIES, THREE_VERSION } from './capabilities.js';
export { THREE_CHILD_TYPES, checkThreeNode, requiresWebGL2, threeBackendFor } from './check.js';
export { detectFormat, type AssetFormat } from './assets.js';
export { instanceTransforms, type InstanceTransform } from './instances.js';
export { particles3d, type Particle3D } from './particles.js';
export { ORTHOGRAPHIC_VIEW_HEIGHT } from './objects.js';
export { probeWebGPU, type WebGPUProbe } from './webgpu-probe.js';
export { ThreeLayerRenderer, type ThreeBackendPreference } from './renderer.js';
export type { ThreeLayerInput } from './scene.js';
export { fitTextureSize, textureTooLargeError, type TextureUse } from './texture-limit.js';
