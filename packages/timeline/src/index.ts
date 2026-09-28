/**
 * @packageDocumentation
 * Deterministische Timeline von OpenVideo: Zeiteinheiten, Easing, Keyframes,
 * Springs, Expressions, Zufall und die zeitliche Einbettung von Nodes.
 *
 * @example
 * ```ts
 * import { evaluateAnimated, animate } from '@agentic-video/timeline';
 * const x = animate(0, 100, { to: '1s', ease: 'easeOutCubic' });
 * evaluateAnimated(x, { frame: 15, fps: 30, seed: 0, durationFrames: 30 }); // 87.5
 * ```
 */
export * from './time.js';
export * from './color.js';
export * from './random.js';
export * from './spring.js';
export * from './easing.js';
export * from './expression.js';
export * from './interpolate.js';
export * from './animated.js';
export * from './timing.js';
export * from './builders.js';
