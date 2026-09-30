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

  it('meldet Text-Daten in Arithmetik mit klarer Diagnose (Review m6)', () => {
    const codeOf = (src: string): unknown => {
      try {
        compileExpression(src).evaluate(scope);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : error;
      }
    };
    expect(codeOf('event("beat", "name") * 2')).toMatch(/Operator "\*" cannot use the string "kick".*event\(id, key\)/u);
    expect(codeOf('sin(event("beat", "name"))')).toMatch(/got the string "kick"/u);
    expect(codeOf('clamp(event("beat", "name"), 0, 1)')).toMatch(/must be a number, got the string "kick"/u);
    expect(codeOf('[event("beat", "name"), 1]')).toMatch(/got the string "kick"/u);
    // Vergleich und Ausgabe als Text bleiben erlaubt.
    expect(compileExpression('event("beat", "name") == "kick"').evaluate(scope)).toBe(1);
    expect(compileExpression('event("beat", "name")').evaluate(scope)).toBe('kick');
  });

  it('rechnet Events aus Composition-Frames in die lokale Zeit um', () => {
    const value = evaluateAnimated({ $expr: 'event("beat")' }, { frame: 0, fps: 30, seed: 0, durationFrames: 90, markerOffset: 30, events: new Map([['beat', { frame: 75, data: {} }]]) });
    expect(value).toBe(1.5);
  });
});
