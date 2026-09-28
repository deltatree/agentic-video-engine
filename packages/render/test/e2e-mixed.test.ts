import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, planFrame, evaluateScene } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createNodeEnvironment, renderFrame, type NodeEnvironment } from '@agentic-video/render';

/** Gemischte Composition: Skia-2D, HTML/CSS (Chromium), Three.js-3D und ein Compositor-Layer (FR-45). */
const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'mixed',
      width: 640,
      height: 360,
      fps: 30,
      duration: '2s',
      background: '#101522',
      nodes: [
        { id: 'grad', type: 'rect', width: 640, height: 360, fill: { type: 'radial', stops: [{ offset: 0, color: '#2B3A67' }, { offset: 1, color: '#101522' }] } },
        {
          id: 'scene',
          type: 'scene3d',
          width: 360,
          height: 360,
          x: 280,
          backend: 'webgl2',
          camera: 'cam',
          children: [
            { id: 'cam', type: 'camera3d', position: [0, 1.2, 4], target: [0, 0, 0], fov: 45 },
            { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.4 },
            { id: 'sun', type: 'light3d', kind: 'directional', position: [3, 5, 2], intensity: 3 },
            { id: 'knot', type: 'mesh3d', geometry: { type: 'torus-knot', radius: 0.8, tube: 0.25 }, material: { color: '#FF5A1F', metalness: 0.3, roughness: 0.35 }, rotation: { $keyframes: [{ t: 0, v: [0, 0, 0] }, { t: '2s', v: [0, 180, 0] }] } },
          ],
        },
        {
          id: 'card',
          type: 'html',
          x: 32,
          y: 96,
          width: 280,
          height: 150,
          html: '<div class="card"><h1>HTML</h1><p>CSS in Chromium</p></div>',
          css: '.card{height:100%;box-sizing:border-box;padding:18px;border-radius:16px;background:linear-gradient(135deg,#7F5AF0,#2CB67D);color:white;font-family:Inter,sans-serif;box-shadow:0 10px 30px #0008}h1{margin:0;font-size:40px}p{margin:6px 0 0;font-size:18px;opacity:.9}',
        },
        { id: 'glow', type: 'layer', blendMode: 'screen', opacity: 0.8, effects: [{ type: 'blur', radius: 6 }], children: [{ id: 'bar', type: 'rect', x: 32, y: 280, width: 280, height: 12, cornerRadius: 6, fill: '#2CB67D' }] },
      ],
    },
  ],
};

let env: NodeEnvironment;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ov-mixed-'));
  env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new MemoryStore()) });
});

afterAll(async () => {
  await env.dispose();
});

describe('Gemischte Composition (FR-45)', () => {
  it('plant Skia-, Three-, Browser- und Compositor-Layer', () => {
    const plan = planFrame(evaluateScene(project, 'mixed', 0, { registry: env.registry }), env.registry);
    expect(plan.map((p) => (p.kind === 'render' ? p.backend : 'composite'))).toEqual(['skia', 'three', 'browser', 'composite']);
  });

  it('rendert alle Layer deterministisch zu einem Frame', async () => {
    const a = await renderFrame(env, project, { compositionId: 'mixed', frame: 15, useCache: false });
    writeFileSync(join(process.env['OV_E2E_OUT'] ?? dir, 'e2e-mixed-15.png'), encodePng(a.image));
    const b = await renderFrame(env, project, { compositionId: 'mixed', frame: 15, useCache: false });
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Das 3D-Objekt ist sichtbar: im Szenenbereich sind viele orange Pixel (R hoch, B niedrig).
    let orange = 0;
    for (let y = 0; y < 360; y++)
      for (let x = 280; x < 640; x++) {
        const o = (y * 640 + x) * 4;
        if ((a.image.data[o] ?? 0) > 150 && (a.image.data[o + 2] ?? 0) < 90) orange++;
      }
    expect(orange).toBeGreaterThan(5000);
  });
});
