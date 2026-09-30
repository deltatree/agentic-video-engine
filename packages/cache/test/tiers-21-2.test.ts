/**
 * Story 21.2 (T7, ADR 0021): genutzte Cache-Ebenen und Meldung jedes Zugriffs.
 */
import { describe, expect, it } from 'vitest';
import { CACHE_TIERS, MemoryStore, createCache, perTier, type CacheTierName } from '@agentic-video/cache';

describe('Cache-Ebenen (Story 21.2)', () => {
  it('führt nur genutzte Ebenen: compiled und encoding ja, font/geometry/shader nicht', () => {
    expect([...CACHE_TIERS]).toEqual(['asset', 'compiled', 'frame', 'layer', 'audio', 'encoding']);
    expect(Object.keys(perTier(() => 0)).sort()).toEqual([...CACHE_TIERS].sort());
    for (const removed of ['font', 'geometry', 'shader', 'composition']) expect(CACHE_TIERS.some((t) => t === removed)).toBe(false);
  });

  it('meldet Treffer und Fehlgriffe jeder Ebene an Beobachter; has() zählt nicht', async () => {
    const cache = createCache(new MemoryStore());
    const events: [CacheTierName, 'hit' | 'miss'][] = [];
    const stop = cache.observe((tier, outcome) => events.push([tier, outcome]));
    await cache.tier('compiled').get('a');
    await cache.tier('compiled').put('a', new Uint8Array([1]));
    await cache.tier('compiled').get('a');
    await cache.tier('encoding').getOrCreate('b', () => Promise.resolve(new Uint8Array([2])));
    await cache.tier('encoding').getOrCreate('b', () => Promise.resolve(new Uint8Array([3])));
    await cache.tier('asset').has('a');
    expect(events).toEqual([
      ['compiled', 'miss'],
      ['compiled', 'hit'],
      ['encoding', 'miss'],
      ['encoding', 'hit'],
    ]);
    stop();
    await cache.tier('audio').get('x');
    expect(events).toHaveLength(4);
    expect(cache.stats().compiled).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  it('ein werfender Beobachter bricht den Zugriff nicht ab und wird abgemeldet', async () => {
    const cache = createCache(new MemoryStore());
    let calls = 0;
    cache.observe(() => {
      calls++;
      throw new Error('telemetry down');
    });
    await expect(cache.tier('frame').get('k')).resolves.toBeUndefined();
    await expect(cache.tier('frame').get('k')).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });
});
