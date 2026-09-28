/**
 * Easing-Funktionen mit den Namen aus Motion Canvas. Jede Funktion ist ausführbar
 * (`(value, from, to) => number`) und trägt zusätzlich ihren OpenVideo-Namen.
 */
import { easing } from '@agentic-video/core';

/** Easing wie in Motion Canvas: `(value, from = 0, to = 1) => number`. */
export type TimingFunction = (value: number, from?: number, to?: number) => number;

const NAMES = new WeakMap<TimingFunction, string>();

function timing(name: string): TimingFunction {
  const ease = easing(name);
  const fn: TimingFunction = (value, from = 0, to = 1) => from + (to - from) * ease(value);
  NAMES.set(fn, name);
  return fn;
}

/**
 * Liefert den OpenVideo-Namen einer Easing-Funktion, falls sie aus diesem Paket stammt.
 *
 * @example
 * ```ts
 * easingName(easeInOutCubic); // 'easeInOutCubic'
 * ```
 */
export function easingName(fn: TimingFunction): string | undefined {
  return NAMES.get(fn);
}

/** Motion-Canvas-Easing `linear`. */
export const linear: TimingFunction = timing('linear');
/** Motion-Canvas-Easing `easeInSine`. */
export const easeInSine: TimingFunction = timing('easeInSine');
/** Motion-Canvas-Easing `easeOutSine`. */
export const easeOutSine: TimingFunction = timing('easeOutSine');
/** Motion-Canvas-Easing `easeInOutSine`. */
export const easeInOutSine: TimingFunction = timing('easeInOutSine');
/** Motion-Canvas-Easing `easeInQuad`. */
export const easeInQuad: TimingFunction = timing('easeInQuad');
/** Motion-Canvas-Easing `easeOutQuad`. */
export const easeOutQuad: TimingFunction = timing('easeOutQuad');
/** Motion-Canvas-Easing `easeInOutQuad`. */
export const easeInOutQuad: TimingFunction = timing('easeInOutQuad');
/** Motion-Canvas-Easing `easeInCubic`. */
export const easeInCubic: TimingFunction = timing('easeInCubic');
/** Motion-Canvas-Easing `easeOutCubic`. */
export const easeOutCubic: TimingFunction = timing('easeOutCubic');
/** Motion-Canvas-Easing `easeInOutCubic`. */
export const easeInOutCubic: TimingFunction = timing('easeInOutCubic');
/** Motion-Canvas-Easing `easeInQuart`. */
export const easeInQuart: TimingFunction = timing('easeInQuart');
/** Motion-Canvas-Easing `easeOutQuart`. */
export const easeOutQuart: TimingFunction = timing('easeOutQuart');
/** Motion-Canvas-Easing `easeInOutQuart`. */
export const easeInOutQuart: TimingFunction = timing('easeInOutQuart');
/** Motion-Canvas-Easing `easeInQuint`. */
export const easeInQuint: TimingFunction = timing('easeInQuint');
/** Motion-Canvas-Easing `easeOutQuint`. */
export const easeOutQuint: TimingFunction = timing('easeOutQuint');
/** Motion-Canvas-Easing `easeInOutQuint`. */
export const easeInOutQuint: TimingFunction = timing('easeInOutQuint');
/** Motion-Canvas-Easing `easeInExpo`. */
export const easeInExpo: TimingFunction = timing('easeInExpo');
/** Motion-Canvas-Easing `easeOutExpo`. */
export const easeOutExpo: TimingFunction = timing('easeOutExpo');
/** Motion-Canvas-Easing `easeInOutExpo`. */
export const easeInOutExpo: TimingFunction = timing('easeInOutExpo');
/** Motion-Canvas-Easing `easeInCirc`. */
export const easeInCirc: TimingFunction = timing('easeInCirc');
/** Motion-Canvas-Easing `easeOutCirc`. */
export const easeOutCirc: TimingFunction = timing('easeOutCirc');
/** Motion-Canvas-Easing `easeInOutCirc`. */
export const easeInOutCirc: TimingFunction = timing('easeInOutCirc');
/** Motion-Canvas-Easing `easeInBack`. */
export const easeInBack: TimingFunction = timing('easeInBack');
/** Motion-Canvas-Easing `easeOutBack`. */
export const easeOutBack: TimingFunction = timing('easeOutBack');
/** Motion-Canvas-Easing `easeInOutBack`. */
export const easeInOutBack: TimingFunction = timing('easeInOutBack');
/** Motion-Canvas-Easing `easeInElastic`. */
export const easeInElastic: TimingFunction = timing('easeInElastic');
/** Motion-Canvas-Easing `easeOutElastic`. */
export const easeOutElastic: TimingFunction = timing('easeOutElastic');
/** Motion-Canvas-Easing `easeInOutElastic`. */
export const easeInOutElastic: TimingFunction = timing('easeInOutElastic');
/** Motion-Canvas-Easing `easeInBounce`. */
export const easeInBounce: TimingFunction = timing('easeInBounce');
/** Motion-Canvas-Easing `easeOutBounce`. */
export const easeOutBounce: TimingFunction = timing('easeOutBounce');
/** Motion-Canvas-Easing `easeInOutBounce`. */
export const easeInOutBounce: TimingFunction = timing('easeInOutBounce');
