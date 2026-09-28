/**
 * @packageDocumentation
 * Kern von OpenVideo: Frame Evaluation, Frame Plan, Patches, Register, Plugins,
 * Renderer-Verträge, Bounding Boxes, Hashes. Rein und plattformunabhängig.
 *
 * @example
 * ```ts
 * import { evaluateScene, planFrame, Registry } from '@agentic-video/core';
 * const registry = new Registry();
 * const scene = evaluateScene(project, 'hero', 0, { registry });
 * const plan = planFrame(scene, registry);
 * ```
 */
export * from '@agentic-video/schema';
export * from '@agentic-video/timeline';
export * from './contracts.js';
export * from './guards.js';
export * from './hash.js';
export * from './matrix.js';
export * from './path.js';
export * from './props.js';
export * from './registry.js';
export * from './evaluate.js';
export * from './plan.js';
export * from './patches.js';
export * from './bounds.js';
export * from './frame-key.js';
