/**
 * Token nur aus dem Fragment; `?token=` wird verworfen (Story 16.7, N2).
 */
import { describe, expect, it } from 'vitest';
import { tokenFromLocation } from '../src/api.js';

describe('tokenFromLocation', () => {
  it('nimmt das Token aus #token= und lässt die übrige Query stehen', () => {
    expect(tokenFromLocation('#token=abc', '?project=demo')).toEqual({ token: 'abc', discarded: false, search: 'project=demo' });
  });

  it('verwirft ?token= und benutzt es nicht', () => {
    expect(tokenFromLocation('', '?token=abc&project=demo')).toEqual({ token: null, discarded: true, search: 'project=demo' });
    expect(tokenFromLocation('#token=good', '?token=bad')).toEqual({ token: 'good', discarded: true, search: '' });
  });

  it('ohne Token bleibt alles, wie es ist', () => {
    expect(tokenFromLocation('', '?project=demo')).toEqual({ token: null, discarded: false, search: 'project=demo' });
    expect(tokenFromLocation('#token=', '')).toEqual({ token: null, discarded: false, search: '' });
  });
});
