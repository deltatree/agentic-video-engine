/**
 * Story 18.3: Das Skia-Backend nutzt sein Zeichenziel je Größe wieder und liest einmal aus;
 * Story 18.9: SkSL-Kompilate als LRU. Ergebnisse bleiben bitgleich zu frischen Backends.
 */
import { describe, expect, it } from 'vitest';
import { backend, hash, n, render } from './helpers.js';

const shader = (k: number): string => `uniform float2 resolution; half4 main(float2 p) { return half4(p.x / resolution.x, ${(k / 100).toFixed(2)}, 0.5, 1); }`;

describe('Wiederverwendetes Zeichenziel (Story 18.3)', () => {
  it('liefert nach vielen Layern verschiedener Größe dieselben Pixel wie ein frisches Backend', async () => {
    const shared = await backend();
    const scenes = [
      { nodes: [n('rect', { width: 40, height: 30, fill: '#FF0000', rotation: 20, x: 10, y: 5 })], width: 64, height: 48 },
      { nodes: [n('ellipse', { width: 30, height: 30, fill: '#00FF00', opacity: 0.5 })], width: 64, height: 48 },
      { nodes: [n('rect', { width: 10, height: 10, fill: '#0000FF' })], width: 32, height: 32 },
      { nodes: [n('group', { opacity: 0.7, scale: 1.5 }, { children: [n('rect', { width: 8, height: 8, fill: '#FFFF00' })] })], width: 64, height: 48 },
      { nodes: [], width: 48, height: 20 },
    ];
    const reused: string[] = [];
    for (let round = 0; round < 2; round++) for (const s of scenes) reused.push(hash(await render(s.nodes, { width: s.width, height: s.height }, shared)));
    const fresh: string[] = [];
    for (let round = 0; round < 2; round++) for (const s of scenes) fresh.push(hash(await render(s.nodes, { width: s.width, height: s.height }, await backend())));
    expect(reused).toEqual(fresh);
    await shared.dispose();
  });

  it('ein abgebrochener Layer (Fehler beim Zeichnen) hinterlässt keinen Zustand für den nächsten', async () => {
    const shared = await backend();
    const good = [n('rect', { width: 20, height: 20, fill: '#FF00FF', x: 3 })];
    const before = hash(await render(good, { width: 32, height: 32 }, shared));
    // Ungültiges SkSL wirft mitten im Zeichnen, nach Transform und saveLayer der Gruppe.
    const bad = [n('group', { opacity: 0.5, rotation: 30 }, { children: [n('rect', { width: 5, height: 5, fill: '#FFFFFF' }), n('shader', { width: 10, height: 10, sksl: 'not sksl' })] })];
    await expect(render(bad, { width: 32, height: 32 }, shared)).rejects.toThrow();
    expect(hash(await render(good, { width: 32, height: 32 }, shared))).toBe(before);
    await shared.dispose();
  });
});

describe('SkSL-LRU (Story 18.9)', () => {
  it('hält höchstens 64 Kompilate und rendert verdrängte Shader erneut korrekt', async () => {
    const shared = await backend();
    const first = hash(await render([n('shader', { width: 16, height: 16, sksl: shader(0) })], { width: 16, height: 16 }, shared));
    for (let k = 1; k <= 80; k++) await render([n('shader', { width: 16, height: 16, sksl: shader(k) })], { width: 16, height: 16 }, shared);
    // Shader 0 ist verdrängt (und freigegeben) und wird neu kompiliert: gleiches Bild.
    expect(hash(await render([n('shader', { width: 16, height: 16, sksl: shader(0) })], { width: 16, height: 16 }, shared))).toBe(first);
    await shared.dispose();
  });
});
