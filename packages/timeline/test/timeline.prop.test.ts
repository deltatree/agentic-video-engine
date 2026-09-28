import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EASINGS, computeLocalTime, cubicBezier, evaluateAnimated, framesToSmpte, smpteToFrames, toFrames } from '@agentic-video/timeline';

const ctx = (frame: number) => ({ frame, fps: 30, seed: 0, durationFrames: 1000 });

describe('Property-Based: Interpolation und Timeline (NFR-5)', () => {
  it('trifft jeden Keyframe exakt', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }), { minLength: 8, maxLength: 8 }),
        fc.constantFrom(...Object.keys(EASINGS)),
        (times, values, ease) => {
          const keys = times.map((t, i) => ({ t, v: values[i] ?? 0, ease }));
          const anim = { $keyframes: keys };
          for (const k of keys) expect(evaluateAnimated(anim, ctx(k.t))).toBe(k.v);
        },
      ),
    );
  });

  it('bleibt bei monotonem Easing zwischen Start und Ende', () => {
    const monotone = ['linear', 'easeInQuad', 'easeOutQuad', 'easeInOutCubic', 'easeInOutSine', 'easeOutExpo', 'easeInCirc'];
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.integer({ min: 1, max: 300 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(...monotone),
        (a, b, span, p, ease) => {
          const v = evaluateAnimated({ $keyframes: [{ t: 0, v: a }, { t: span, v: b, ease }] }, ctx(p * span));
          if (typeof v !== 'number') throw new Error('Zahl erwartet');
          expect(v).toBeGreaterThanOrEqual(Math.min(a, b) - 1e-9);
          expect(v).toBeLessThanOrEqual(Math.max(a, b) + 1e-9);
        },
      ),
    );
  });

  it('ist unabhängig von der Auswertungsreihenfolge (Determinismus)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 2, maxLength: 20 }), (frames) => {
        const anim = { $expr: 'wiggle(3, 50) + random(floor(frame / 10)) * 10' };
        const forward = frames.map((f) => evaluateAnimated(anim, { ...ctx(f), seed: 99 }));
        const backward = [...frames].reverse().map((f) => evaluateAnimated(anim, { ...ctx(f), seed: 99 })).reverse();
        expect(backward).toEqual(forward);
      }),
    );
  });

  it('cubic-bezier ist monoton für x1, x2 in [0, 1] und y in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })),
        ([x1, y1, x2, y2]) => {
          const f = cubicBezier(x1, y1, x2, y2);
          let prev = -1e-6;
          for (let i = 0; i <= 50; i++) {
            const v = f(i / 50);
            expect(v).toBeGreaterThanOrEqual(prev - 1e-5);
            prev = v;
          }
        },
      ),
    );
  });

  it('Zeiteinheiten sind konsistent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), fc.constantFrom(24, 25, 30, 50, 60), (frames, fps) => {
        expect(toFrames(`${String(frames / fps)}s`, { fps })).toBeCloseTo(frames, 6);
        expect(smpteToFrames(framesToSmpte(frames, fps, false), fps)).toBe(frames);
      }),
    );
  });

  it('Time Stretch ist linear und Zeitfenster sind halboffen', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 1, max: 100 }), fc.double({ min: 0.1, max: 10, noNaN: true }), fc.integer({ min: 0, max: 300 }), (from, duration, speed, frame) => {
        const t = computeLocalTime({ from, duration, speed }, frame, { fps: 30, seed: 0, parentStart: 0, parentDuration: 1000 });
        expect(t.active).toBe(frame >= from && frame < from + duration);
        expect(t.localFrame).toBeCloseTo((frame - from) * speed, 6);
      }),
    );
  });
});
