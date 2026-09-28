/**
 * @packageDocumentation
 * TSX-SDK von OpenVideo: `composition()`, `project()`, Element-Komponenten,
 * Animations-Helfer und `toIR`. Isomorph: keine Node-APIs.
 *
 * @example
 * ```tsx
 * import { composition, Scene, Text, spring } from '@agentic-video/sdk';
 * export default composition({
 *   width: 1920, height: 1080, fps: 30, duration: '3s',
 *   scene: ({ frame }) => <Scene><Text id="title" text="Hi" opacity={spring({ frame, config: { damping: 26 } })} /></Scene>,
 * });
 * ```
 */
export * from './element.js';
export * from './components.js';
export * from './definition.js';
export * from './animation.js';
export { toIR, isIrProjectShape, type ToIROptions } from './to-ir.js';
export { COMPONENT_FOR_NODE_TYPE, LIGHT_COMPONENTS } from './convert.js';
