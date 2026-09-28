/**
 * @packageDocumentation
 * PixiJS-Renderer von OpenVideo (FR-31): rendert dieselben 2D-Nodes wie Skia, soweit PixiJS es
 * kann, mit WebGL auf ein Canvas. Läuft nur im Browser; den Chromium-Host stellt
 * `@agentic-video/renderer-browser` bereit. Was fehlt, meldet `checkPixiNode`.
 *
 * @example
 * ```ts
 * import { PixiLayerRenderer, checkPixiNode } from '@agentic-video/renderer-pixi';
 * const diagnostics = checkPixiNode(irNode);
 * const canvas = await new PixiLayerRenderer().render(input);
 * ```
 */
export { PIXI_CAPABILITIES, PIXI_VERSION } from './capabilities.js';
export { PIXI_BLEND_MODES, PIXI_NODE_TYPES, checkPixiNode } from './check.js';
export { LUMINANCE_TO_ALPHA, filterMatrix } from './filters.js';
export { fragmentSource, shaderUniforms } from './shader.js';
export { PixiLayerRenderer } from './renderer.js';
export type { PixiLayerInput } from './build.js';
