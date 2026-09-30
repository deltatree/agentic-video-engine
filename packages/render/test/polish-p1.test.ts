/**
 * Politur P1 im Render: Projekte mit `scene3d` starten Chromium beim Anlegen der Umgebung nur,
 * solange die Grafik-Probe nicht im Cache liegt; die Schlüssel bleiben dabei gleich.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { createNodeEnvironment, renderFrame } from '@agentic-video/render';

const scene3d = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 32,
      height: 32,
      fps: 10,
      duration: 2,
      nodes: [
        { id: 'bg', type: 'rect', width: 32, height: 32, fill: '#203040' },
        { id: 'world', type: 'scene3d', width: 32, height: 32, backend: 'webgl2', children: [{ id: 'cube', type: 'mesh3d', geometry: { type: 'box' }, material: { type: 'standard', color: '#FF3366' } }] },
      ],
    },
  ],
};

describe('Grafik-Probe aus dem Cache (Politur P1)', () => {
  it('startet Chromium beim zweiten Anlegen der Umgebung nicht; Versionen und Frame-Schlüssel bleiben gleich', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-p1-probe-'));
    const cacheDir = join(dir, 'cache');
    const noGpu = () => Promise.resolve(undefined);
    const first = await createNodeEnvironment({ projectDir: dir, project: scene3d, cache: createCache(new FileStore(cacheDir)), probeGpu: noGpu, env: {} });
    let key: string;
    let versions: Readonly<Record<string, string>>;
    try {
      expect(first.versions['three-webgpu']).toMatch(/^(available|unavailable)$/u);
      // Die erste Umgebung hat Chromium für die Probe gestartet.
      expect((await first.runtime?.())?.versions['chromium']).toBeDefined();
      key = (await renderFrame(first, scene3d, { frame: 0 })).key;
      versions = { ...first.versions };
    } finally {
      await first.dispose();
    }
    const second = await createNodeEnvironment({ projectDir: dir, project: scene3d, cache: createCache(new FileStore(cacheDir)), probeGpu: noGpu, env: {} });
    try {
      expect(second.versions).toEqual(versions);
      expect((await second.runtime?.())?.versions['chromium']).toBeUndefined();
      const again = await renderFrame(second, scene3d, { frame: 0 });
      expect(again.key).toBe(key);
      // Der Frame kam aus dem Cache: Chromium lief auch jetzt nicht.
      expect((await second.runtime?.())?.versions['chromium']).toBeUndefined();
    } finally {
      await second.dispose();
    }
  }, 120_000);
});
