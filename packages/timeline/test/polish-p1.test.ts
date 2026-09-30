/**
 * Politur P1: `addTime` meldet unaddierbare Zeitwerte als OpenVideoError (erreichbar aus TSX).
 */
import { describe, expect, it } from 'vitest';
import { OpenVideoError } from '@agentic-video/schema';
import { addTime, animate } from '@agentic-video/timeline';

describe('addTime ohne fps (Politur P1)', () => {
  it('wirft OV_TIME_ADD mit Vorschlägen statt TypeError', () => {
    let caught: unknown;
    try {
      addTime(30, '1s');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenVideoError);
    if (caught instanceof OpenVideoError) {
      expect(caught.diagnostic.code).toBe('OV_TIME_ADD');
      expect(caught.diagnostic.suggestions.length).toBeGreaterThan(0);
    }
    expect(() => animate(0, 1, { from: 12, duration: '1s' })).toThrow(OpenVideoError);
  });
});
