/**
 * @packageDocumentation
 * Layer-Compositor von OpenVideo: Blend Modes, Masken, Layer-Effekte, LUTs und
 * Color Management. Reines TypeScript ohne Node-APIs (läuft auch im Browser).
 *
 * @example
 * ```ts
 * import { compositeFrame } from '@agentic-video/compositor';
 * const frame = compositeFrame({ width, height, scale: 1, background: '#000000', workingSpace: 'linear', layers, frame: 0, seed: 1 });
 * ```
 */
export { compositeFrame, accumulateFrames, type CompositeInput, type CompositorNode, type CompositorMask, type CompositorReveal } from './composite.js';
export { BLEND_FUNCTIONS, blendPixel, type BlendFunction, type Rgb, type Rgba } from './blend.js';
export { applyLayerEffects, gaussianBlur, gradeColor, NEUTRAL_GRADE, type ColorGrade, type EffectContext } from './effects.js';
export { parseCubeLut, sampleLut, type Lut } from './lut.js';
export {
  convertColorSpace,
  srgbToLinear,
  linearToSrgb,
  rec709ToLinear,
  linearToRec709,
  decodeTransfer,
  encodeTransfer,
  rgbaToFloat,
  floatToRgba,
  createFloatImage,
  type FloatImage,
} from './color.js';
