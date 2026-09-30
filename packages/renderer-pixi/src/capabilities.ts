/**
 * Fähigkeiten und Version des PixiJS-Renderers (FR-31).
 */
import { VERSION } from 'pixi.js';

/**
 * Version der gebündelten PixiJS-Bibliothek, z. B. `8.21.0`.
 *
 * @example
 * ```ts
 * const versions = { pixi: PIXI_VERSION };
 * ```
 */
export const PIXI_VERSION: string = VERSION;

/**
 * Benannte Fähigkeiten des PixiJS-Renderers. Was fehlt, meldet `checkPixiNode` als `OV_PIXI_UNSUPPORTED`.
 *
 * @example
 * ```ts
 * PIXI_CAPABILITIES.includes('pixi.gradient.radial'); // true
 * ```
 */
export const PIXI_CAPABILITIES: readonly string[] = [
  'pixi.webgl',
  'pixi.node.group',
  'pixi.node.group.clip',
  'pixi.node.rect',
  'pixi.node.ellipse',
  'pixi.node.line',
  'pixi.node.polyline',
  'pixi.node.polygon',
  'pixi.node.path',
  'pixi.node.text',
  'pixi.node.rich-text',
  'pixi.node.image',
  'pixi.node.video',
  'pixi.node.sprite',
  'pixi.node.shader.glsl',
  'pixi.node.particles',
  'pixi.paint.color',
  'pixi.gradient.linear',
  'pixi.gradient.radial',
  'pixi.stroke',
  'pixi.opacity',
  'pixi.blend-modes',
  'pixi.blend.hue',
  'pixi.filter.blur',
  'pixi.filter.color-matrix',
  'pixi.mask.alpha',
  'pixi.mask.luminance',
  'pixi.mask.invert',
  'pixi.reveal',
  'pixi.text.background',
  'pixi.text.background.per-line',
];
