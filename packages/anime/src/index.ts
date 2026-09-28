/**
 * @packageDocumentation
 * Anime.js-artige API (v4-Konzepte), die in OpenVideo-Keyframes übersetzt (FR-86).
 * Anime.js wird nicht eingebunden; OpenVideo besitzt die Zeit (A8).
 *
 * @example
 * ```ts
 * import { createTimeline, stagger, applyTimeline } from '@agentic-video/anime';
 * const tl = createTimeline()
 *   .add(['a', 'b', 'c'], { y: [40, 0], opacity: [0, 1], delay: stagger(100) })
 *   .add('title', { scale: 1.2 }, '-=200');
 * const result = applyTimeline(project, tl);
 * ```
 */
export { LOSSY_CODE } from './diagnostics.js';
export { cubicBezier, mapEase, reverseEase, spring, steps, type EaseInput, type MappedEase, type SpringParams } from './ease.js';
export { stagger, utils, type FunctionValue, type StaggerOptions } from './helpers.js';
export {
  animate,
  applyTimeline,
  createTimeline,
  Timeline,
  type AnimationParams,
  type AppliedTimeline,
  type CompiledTimeline,
  type Targets,
  type TimelineDefaults,
  type TimelineOptions,
  type TimePosition,
} from './timeline.js';
