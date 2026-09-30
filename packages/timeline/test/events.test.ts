import { describe, expect, it } from 'vitest';
import { compileExpression, evaluateAnimated } from '@agentic-video/timeline';

describe('event() in Expressions (Story 17.10)', () => {
  const events = new Map([['beat', { time: 1.5, data: { strength: 0.8, name: 'kick', accent: false } }]]);
  const scope = { frame: 60, time: 2, fps: 30, seed: 0, duration: 4, progress: 0.5, events };

  it('liefert die Zeit und Datenfelder eines Events', () => {
    expect(compileExpression('event("beat")').evaluate(scope)).toBe(1.5);
    expect(compileExpression('time - event("beat")').evaluate(scope)).toBe(0.5);
    expect(compileExpression('event("beat", "strength") * 10').evaluate(scope)).toBe(8);
    expect(compileExpression('event("beat", "accent")').evaluate(scope)).toBe(0);
    expect(compileExpression('ease("linear", event("beat", "strength"))').evaluate(scope)).toBeCloseTo(0.8, 10);
  });

  it('meldet unbekannte Events und Felder', () => {
    expect(() => compileExpression('event("nope")').evaluate(scope)).toThrow(/Event "nope" does not exist/u);
    expect(() => compileExpression('event("beat", "x")').evaluate(scope)).toThrow(/no data field "x"/u);
    expect(() => compileExpression('event("beat", "constructor")').evaluate(scope)).toThrow(/no data field/u);
  });

  it('rechnet Events aus Composition-Frames in die lokale Zeit um', () => {
    const value = evaluateAnimated({ $expr: 'event("beat")' }, { frame: 0, fps: 30, seed: 0, durationFrames: 90, markerOffset: 30, events: new Map([['beat', { frame: 75, data: {} }]]) });
    expect(value).toBe(1.5);
  });
});
