/**
 * @packageDocumentation
 * Motion-Canvas-artige Generator-Szenen als OpenVideo-IR (FR-86).
 * Motion Canvas wird nicht eingebunden: Die Szenen laufen symbolisch ohne Uhr (A8)
 * und werden zu `$keyframes`.
 *
 * @example
 * ```ts
 * import { all, makeScene, Rect, toProject, waitFor } from '@agentic-video/motion-canvas-adapter';
 * const scene = makeScene('intro', function* (view) {
 *   const rect = new Rect({ width: 200, height: 100, fill: '#e13238' });
 *   view.add(rect);
 *   yield* all(rect.x(300, 1), rect.opacity(0, 1));
 *   yield* waitFor(0.5);
 *   yield* rect.x(0, 1);
 * });
 * const { project } = toProject([scene], { width: 1920, height: 1080, fps: 30 });
 * ```
 */
export { all, any, chain, delay, loop, sequence, waitFor, waitUntil } from './flow.js';
export { Circle, Img, Line, Node, Rect, Shape, SizedShape, Txt, View2D, type ImgProps, type LineProps, type NodeProps, type PossibleVector2, type RectProps, type ShapeProps, type Signal, type SizedProps, type TxtProps, type Vector2, type Vector2Signal } from './nodes.js';
export { makeScene, toProject, type Scene, type ToProjectOptions, type ToProjectResult } from './project.js';
export type { Instruction, ThreadGenerator } from './runtime.js';
export * from './timing.js';
