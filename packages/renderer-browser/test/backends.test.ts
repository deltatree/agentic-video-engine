import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvaluatedNode, EvaluatedScene, LayerRequest, RgbaImage } from '@agentic-video/core';
import { createBrowserBackends, type BrowserBackends } from '../src/backends.js';
import { buildRuntime, expectGolden, memoryAssets, node, pixel, testFonts, TEST_FONT } from './helpers.js';

const W = 320;
const H = 180;
const FPS = 30;
const assets = memoryAssets(
  { clip: { path: 'store/clip.mp4', bytes: new Uint8Array([0]), type: 'video' } },
  // Video-Ersatz: Farbe hängt von der Quellzeit ab (rot bei 0 s, grün ab 1 s).
  (_id, seconds): RgbaImage => {
    const data = new Uint8Array(64 * 36 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = seconds < 1 ? 255 : 0;
      data[i + 1] = seconds < 1 ? 0 : 255;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
    return { width: 64, height: 36, data };
  },
);

function scene(frame: number, nodes: EvaluatedNode[]): EvaluatedScene {
  return {
    compositionId: 'test',
    width: W,
    height: H,
    fps: FPS,
    frame,
    time: frame / FPS,
    seed: 3,
    durationFrames: 60,
    background: '#000000',
    colorSpace: 'srgb',
    safeArea: { action: 0.9, title: 0.8 },
    nodes,
    diagnostics: [],
  };
}

function request(frame: number, nodes: EvaluatedNode[], extra: Partial<LayerRequest> = {}): LayerRequest {
  return { layerId: 'l1', scene: scene(frame, nodes), nodes, width: W, height: H, scale: 1, assets, fonts: testFonts(), ...extra };
}

function ev(type: string, props: Record<string, unknown>, children: EvaluatedNode[] = [], frame = 0, id: string = type): EvaluatedNode {
  return { ...node(id, type, props, frame), children };
}

function threeScene(frame: number): EvaluatedNode {
  return ev(
    'scene3d',
    { width: 200, height: 150, x: 60, y: 15, rotation: 8 },
    [
      ev('camera3d', { position: [0, 0, 4], target: [0, 0, 0] }, [], frame, 'cam'),
      ev('light3d', { kind: 'ambient', intensity: 0.4 }, [], frame, 'amb'),
      ev('light3d', { kind: 'directional', position: [3, 4, 5], intensity: 2.5 }, [], frame, 'sun'),
      ev('mesh3d', { geometry: { type: 'box', width: 1.4, height: 1.4, depth: 1.4 }, rotation: [25, 35 + frame * 3, 0], material: { color: '#4C9BE8', roughness: 0.5 } }, [], frame, 'box'),
    ],
    frame,
    'scene',
  );
}

let backends: BrowserBackends;

beforeAll(async () => {
  buildRuntime();
  backends = await createBrowserBackends({ assets, fonts: testFonts(), width: W, height: H, allowHtmlScripts: true });
});

afterAll(async () => {
  await backends.browser.dispose();
  await backends.three.dispose();
  await backends.pixi.dispose();
});

describe('three-Backend', () => {
  it('rendert eine Beispielszene über den Host (Golden)', async () => {
    const image = await backends.three.renderLayer(request(10, [threeScene(10)]));
    expect([image.width, image.height]).toEqual([W, H]);
    expect(pixel(image, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 160, 90)[3]).toBe(255);
    expectGolden('three-scene', image);
  });

  it('ist nicht fusionierbar und meldet Versionen und Fähigkeiten', () => {
    expect(backends.three.fusable).toBe(false);
    expect(backends.three.nodeTypes).toEqual(['scene3d']);
    expect(Object.keys(backends.three.versions())).toEqual(['chromium', 'three']);
    expect(backends.three.capabilities.length).toBeGreaterThan(0);
  });

  it('check() nutzt checkThreeNode', () => {
    expect(backends.three.check({ id: 's', type: 'scene3d', width: 10, height: 10, children: [] }).supported).toBe(true);
  });
});

describe('pixi-Backend', () => {
  it('rendert eine Beispielszene über den Host inklusive Video-Frame (Golden)', async () => {
    const frame = 30;
    const nodes = [
      ev('rect', { x: 20, y: 20, width: 120, height: 80, cornerRadius: 12, fill: '#E63946' }, [], frame, 'r'),
      ev('ellipse', { x: 170, y: 20, width: 120, height: 80, fill: '#457B9D', opacity: 0.8 }, [], frame, 'e'),
      ev('text', { x: 20, y: 120, text: 'PixiJS', fontFamily: TEST_FONT, fontSize: 32, fontWeight: 700, fill: '#1D3557' }, [], frame, 't'),
      ev('video', { x: 200, y: 120, width: 96, height: 54, asset: 'clip' }, [], frame, 'v'),
    ];
    const image = await backends.pixi.renderLayer(request(frame, nodes));
    expect([image.width, image.height]).toEqual([W, H]);
    // Video bei lokaler Zeit 1 s → grün (Frame kam über /video/<asset>/<sekunden>).
    expect(pixel(image, 248, 147)).toEqual([0, 255, 0, 255]);
    expectGolden('pixi-scene', image);
  });

  it('ist fusionierbar und meldet Versionen', () => {
    expect(backends.pixi.fusable).toBe(true);
    expect(Object.keys(backends.pixi.versions())).toEqual(['chromium', 'pixi']);
  });

  it('check() meldet fehlende Features über checkPixiNode', () => {
    const result = backends.pixi.check({ id: 'l', type: 'lottie', asset: 'x', width: 10, height: 10 });
    expect(result.diagnostics.some((d) => d.code === 'OV_PIXI_UNSUPPORTED')).toBe(true);
  });
});

describe('browser-Backend', () => {
  it('rendert html über renderLayer', async () => {
    const n = node('h', 'html', { width: 100, height: 50, html: '', background: '#123456' });
    const image = await backends.browser.renderLayer(request(0, [n]));
    expect(pixel(image, 10, 10)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(Object.keys(backends.browser.versions())).toEqual(['chromium']);
  });

  it('lehnt Node-Masken ab und respektiert Abbruch', async () => {
    const mask = node('m', 'rect', { width: 10, height: 10 });
    const masked = node('h', 'html', { width: 100, height: 50, html: '' }, 0, 60, { mask: { node: mask, mode: 'alpha', invert: false } });
    await expect(backends.browser.renderLayer(request(0, [masked]))).rejects.toMatchObject({ diagnostic: { code: 'OV_BROWSER_UNSUPPORTED' } });
    await expect(backends.browser.renderLayer(request(0, [], { signal: { aborted: true } }))).rejects.toMatchObject({ diagnostic: { code: 'OV_BROWSER_ABORTED' } });
  });
});

describe('Freigabe', () => {
  it('schließt den Host erst, wenn alle drei Backends freigegeben sind', async () => {
    const own = await createBrowserBackends({ assets, fonts: testFonts(), width: 64, height: 64 });
    const html = node('h', 'html', { width: 10, height: 10, html: '' });
    await own.browser.dispose();
    await own.three.dispose();
    await expect(own.host.render('html', { nodes: [html], width: 64, height: 64, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 })).resolves.toMatchObject({ width: 64 });
    await own.pixi.dispose();
    await expect(own.host.render('html', { nodes: [html], width: 64, height: 64, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 })).rejects.toMatchObject({ diagnostic: { code: 'OV_BROWSER_CLOSED' } });
  });
});
