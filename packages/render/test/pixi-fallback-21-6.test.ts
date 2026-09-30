/**
 * Story 21.6 mit echten Backends: Mit `renderer2d: 'pixi'` meldet die Prüfung nicht darstellbare
 * Nodes als Info `OV_PIXI_FALLBACK` statt als Fehler, und ein Frame, dessen Nodes alle auf Skia
 * zurückfallen, rendert ohne Browser genauso wie mit Skia.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { checkProject, createNodeEnvironment, renderFrame } from '@agentic-video/render';

function project(renderer2d: 'skia' | 'pixi'): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { renderer2d },
    compositions: [
      {
        id: 'main',
        width: 64,
        height: 48,
        fps: 30,
        duration: 1,
        background: '#101820',
        nodes: [
          { id: 'shadowed', type: 'rect', x: 8, y: 8, width: 30, height: 20, fill: '#FF6B6B', shadow: { color: '#000000', blur: 4, offsetX: 2, offsetY: 2 } },
          { id: 'sk', type: 'shader', x: 34, y: 20, width: 24, height: 20, sksl: 'half4 main(float2 p) { return half4(p.x / 24.0, 0.5, 0.2, 1.0); }' },
        ],
      },
    ],
  };
}

describe('Pixi-Rückfall mit echten Backends (21.6)', () => {
  it('meldet OV_PIXI_FALLBACK (info) statt OV_PIXI_UNSUPPORTED und rendert wie Skia', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-pixi-fallback-'));
    const env = await createNodeEnvironment({ projectDir: dir, project: project('pixi'), cache: createCache(new MemoryStore()) });
    try {
      const diagnostics = checkProject({ registry: env.registry, assets: env.assets, fonts: env.fonts }, project('pixi'));
      expect(diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
      expect(diagnostics.filter((d) => d.code === 'OV_PIXI_FALLBACK').map((d) => [d.nodeId, d.details?.['features']])).toEqual([
        ['shadowed', 'shadow'],
        ['sk', 'shader.sksl'],
      ]);
      const pixi = await renderFrame(env, project('pixi'), { frame: 0, useCache: false });
      const skia = await renderFrame(env, project('skia'), { frame: 0, useCache: false });
      expect(Buffer.from(pixi.image.data).equals(Buffer.from(skia.image.data))).toBe(true);
    } finally {
      await env.dispose();
    }
  }, 120_000);
});
