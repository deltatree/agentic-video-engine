/**
 * @packageDocumentation
 * Blender-Backend für OpenVideo: rendert `blender`-Nodes headless mit Cycles oder Eevee,
 * mit Pässen (Tiefe, Normale, Objektmaske), Volumen, Nebel und Motion Blur.
 *
 * @example
 * ```ts
 * import { createBlenderBackend } from '@agentic-video/renderer-blender';
 * const backend = createBlenderBackend({ workDir: '/tmp/ov-blender' });
 * const check = backend.check(blenderNode);
 * const image = await backend.renderLayer(request);
 * ```
 */
export * from './backend.js';
export * from './check.js';
export * from './describe.js';
export * from './detect.js';
export * from './instances.js';
export * from './place.js';
