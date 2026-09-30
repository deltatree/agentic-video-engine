/**
 * Story 17.1: Gruppen, Blend Modes, Masken und Reveals über Backend-Grenzen.
 *
 * Planner, Skia und Compositor sind echt. Die Backends `three` und `browser` sind Test-Backends
 * mit demselben Vertrag wie die echten (genau eine `scene3d` bzw. nur `html`-Nodes je Layer,
 * Node-Matrix und Opacity werden angewendet, Blend Mode, Maske und Reveal nicht), damit der Test
 * ohne Chromium läuft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, applyToPoint, getTransform, localMatrix, multiply, parseColor, scale as scaleMatrix, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { createNodeEnvironment, renderFrame, sceneTree, type BackendProvider, type NodeEnvironment } from '@agentic-video/render';

const W = 160;
const H = 90;

/** Test-Backend: füllt die (achsenparallele) Box jeder Node mit `props.background`, mit Opacity. */
function boxBackend(id: 'three' | 'browser', nodeType: 'scene3d' | 'html', fusable: boolean): RenderBackend {
  return {
    id,
    nodeTypes: [nodeType],
    capabilities: [],
    fusable,
    versions: () => ({ [`test-${id}`]: '1' }),
    check: () => ({ supported: true, diagnostics: [] }),
    renderLayer: (req) => {
      if (id === 'three' && (req.nodes.length !== 1 || req.nodes[0]?.type !== 'scene3d')) {
        return Promise.reject(new TypeError('The three backend renders exactly one "scene3d" node per layer.'));
      }
      const data = new Uint8Array(req.width * req.height * 4);
      for (const node of req.nodes) {
        if (node.type !== nodeType) return Promise.reject(new TypeError(`Node "${node.id}" has type "${node.type}"; the ${id} backend renders only "${nodeType}" nodes.`));
        const m = multiply(scaleMatrix(req.scale, req.scale), localMatrix(node));
        const w = typeof node.props['width'] === 'number' ? node.props['width'] : 0;
        const h = typeof node.props['height'] === 'number' ? node.props['height'] : 0;
        const a = applyToPoint(m, 0, 0);
        const b = applyToPoint(m, w, h);
        const c = parseColor(typeof node.props['background'] === 'string' ? node.props['background'] : '#FFFFFF');
        const alpha = c.a * getTransform(node).opacity;
        for (let y = Math.max(0, Math.round(Math.min(a.y, b.y))); y < Math.min(req.height, Math.round(Math.max(a.y, b.y))); y++) {
          for (let x = Math.max(0, Math.round(Math.min(a.x, b.x))); x < Math.min(req.width, Math.round(Math.max(a.x, b.x))); x++) {
            const o = (y * req.width + x) * 4;
            data[o] = Math.round(c.r * alpha * 255);
            data[o + 1] = Math.round(c.g * alpha * 255);
            data[o + 2] = Math.round(c.b * alpha * 255);
            data[o + 3] = Math.round(alpha * 255);
          }
        }
      }
      return Promise.resolve({ width: req.width, height: req.height, data });
    },
    dispose: () => Promise.resolve(),
  };
}

const testProvider: BackendProvider = {
  ids: ['three', 'browser'],
  register(registry) {
    registry.registerBackend(boxBackend('three', 'scene3d', false));
    registry.registerBackend(boxBackend('browser', 'html', true));
    return Promise.resolve({});
  },
  dispose: () => Promise.resolve(),
};

function project(nodes: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, compositions: [{ id: 'main', width: W, height: H, fps: 30, duration: '1s', background: '#000000', nodes }], ...extra };
}

function px(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o] ?? 0, image.data[o + 1] ?? 0, image.data[o + 2] ?? 0, image.data[o + 3] ?? 0];
}

const scene3d = (extra: Record<string, unknown> = {}) => ({ id: 's', type: 'scene3d', width: 80, height: 60, background: '#FF0000', ...extra });

let env: NodeEnvironment;

beforeAll(async () => {
  env = await createNodeEnvironment({ projectDir: mkdtempSync(join(tmpdir(), 'ov-comp-')), project: project([]), cache: createCache(new MemoryStore()), skipDefaultProviders: true, providers: [testProvider] });
});

afterAll(async () => {
  await env.dispose();
});

async function render(p: Record<string, unknown>, frame = 0): Promise<RgbaImage> {
  const r = await renderFrame(env, p, { frame, useCache: false });
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.image;
}

describe('Compositing über Backend-Grenzen (Story 17.1)', () => {
  it('rendert group{scene3d} mit der Transform der Gruppe', async () => {
    const image = await render(project([{ id: 'g', type: 'group', x: 40, y: 20, children: [scene3d()] }]));
    expect(px(image, 45, 25)).toEqual([255, 0, 0, 255]);
    expect(px(image, 20, 10)).toEqual([0, 0, 0, 255]);
  });

  it('rendert group{html} mit Opacity der Gruppe', async () => {
    const image = await render(project([{ id: 'g', type: 'group', x: 10, opacity: 0.5, children: [{ id: 'h', type: 'html', html: '<b>x</b>', width: 40, height: 40, background: '#00FF00' }] }]));
    const [r, g, b] = px(image, 20, 20);
    expect(r).toBe(0);
    expect(g).toBeGreaterThan(120);
    expect(g).toBeLessThan(135);
    expect(b).toBe(0);
    expect(px(image, 5, 20)).toEqual([0, 0, 0, 255]);
  });

  it('mischt eine 2D-Node mit Blend Mode über scene3d (multiply)', async () => {
    const image = await render(project([scene3d(), { id: 'r', type: 'rect', width: 160, height: 90, fill: '#808080', blendMode: 'multiply' }]));
    // Rot × Grau = dunkles Rot; ohne Blend Mode wäre es Grau.
    const [r, g, b] = px(image, 10, 10);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(135);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // Außerhalb der Szene ist der schwarze Composition-Hintergrund der Backdrop: Grau × Schwarz = Schwarz.
    expect(px(image, 120, 80)).toEqual([0, 0, 0, 255]);
  });

  it('mischt Text mit overlay über scene3d', async () => {
    const text = { id: 't', type: 'text', text: 'MMMM', fontSize: 40, fill: '#FFFFFF', x: 0, y: 5 };
    const normal = await render(project([scene3d(), text]));
    const overlay = await render(project([scene3d(), { ...text, blendMode: 'overlay' }]));
    let whiteNormal = 0;
    let whiteOverlay = 0;
    for (let y = 0; y < 60; y++)
      for (let x = 0; x < 80; x++) {
        if (px(normal, x, y)[1] > 200) whiteNormal++;
        if (px(overlay, x, y)[1] > 200) whiteOverlay++;
      }
    // Overlay von Weiß über Rot bleibt rot (G = 0); normal wäre weiß.
    expect(whiteNormal).toBeGreaterThan(100);
    expect(whiteOverlay).toBe(0);
  });

  it('mischt scene3d selbst mit Blend Mode (screen) über 2D-Inhalt', async () => {
    const image = await render(project([{ id: 'bg', type: 'rect', width: 160, height: 90, fill: '#0000FF' }, scene3d({ blendMode: 'screen' })]));
    expect(px(image, 10, 10)).toEqual([255, 0, 255, 255]);
  });

  it('wendet einen Wipe auf scene3d an', async () => {
    const p = project([scene3d({ transition: { in: { type: 'wipe-left', duration: 10, ease: 'linear' } } })]);
    const image = await render(p, 5);
    // wipe-left deckt von rechts auf: bei p = 0.5 ist die rechte Hälfte sichtbar.
    expect(px(image, 70, 30)).toEqual([255, 0, 0, 255]);
    expect(px(image, 10, 30)).toEqual([0, 0, 0, 255]);
  });

  it('wendet eine Iris auf eine Gruppe mit scene3d an', async () => {
    const p = project([{ id: 'g', type: 'group', width: 80, height: 60, transition: { in: { type: 'iris', duration: 10, ease: 'linear' } }, children: [scene3d()] }]);
    const image = await render(p, 2);
    expect(px(image, 40, 30)).toEqual([255, 0, 0, 255]);
    expect(px(image, 2, 2)).toEqual([0, 0, 0, 255]);
  });

  it('maskiert scene3d mit einer 2D-Maske im lokalen Raum der Node', async () => {
    const image = await render(project([scene3d({ x: 40, mask: { node: { id: 'm', type: 'rect', width: 40, height: 60, fill: '#FFFFFF' } } })]));
    expect(px(image, 50, 30)).toEqual([255, 0, 0, 255]);
    expect(px(image, 100, 30)).toEqual([0, 0, 0, 255]);
  });

  it('maskiert eine 2D-Node mit einer scene3d-Maske', async () => {
    const mask = { node: { id: 'm', type: 'scene3d', width: 40, height: 90, background: '#FFFFFF' } };
    const image = await render(project([{ id: 'r', type: 'rect', width: 160, height: 90, fill: '#00FF00', mask }]));
    expect(px(image, 10, 30)).toEqual([0, 255, 0, 255]);
    expect(px(image, 100, 30)).toEqual([0, 0, 0, 255]);
  });

  it('beschneidet eine hochgestufte Gruppe mit clip', async () => {
    const image = await render(project([{ id: 'g', type: 'group', width: 40, height: 40, clip: true, children: [scene3d()] }]));
    expect(px(image, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(px(image, 60, 30)).toEqual([0, 0, 0, 255]);
  });

  it('wendet filters an Gruppen an, die der Compositor zusammensetzt (Story 17.11)', async () => {
    const r = await renderFrame(env, project([{ id: 'g', type: 'group', filters: [{ type: 'grayscale', amount: 1 }], children: [scene3d()] }]), { frame: 0, useCache: false });
    expect(r.diagnostics.map((d) => d.code)).not.toContain('OV_COMPOSITE_UNSUPPORTED');
    // Rot → Grau (Luma-Gewicht 0,213 in sRGB-Kodierung).
    const [red, green, blue] = px(r.image, 10, 10);
    expect(red).toBe(green);
    expect(green).toBe(blue);
    expect(red).toBeGreaterThan(50);
    expect(red).toBeLessThan(60);
  });

  it('wendet shadow an einer hochgestuften Gruppe an (Story 17.11)', async () => {
    const image = await render(project([{ id: 'g', type: 'group', x: 10, y: 10, shadow: { color: '#00FF00', offsetX: 20, offsetY: 0 }, children: [scene3d({ width: 40, height: 40 })] }]));
    expect(px(image, 20, 20)).toEqual([255, 0, 0, 255]);
    // Schatten rechts neben dem Inhalt: 10 + 40 … 10 + 40 + 20.
    expect(px(image, 60, 20)).toEqual([0, 255, 0, 255]);
    expect(px(image, 75, 20)).toEqual([0, 0, 0, 255]);
  });

  it('filtert eine hochgestufte Gruppe wie Skia die gleiche Gruppe (Story 17.11)', async () => {
    const filters = [{ type: 'blur', radius: 3 }, { type: 'hue-rotate', degrees: 90 }, { type: 'contrast', amount: 1.4 }];
    const shadow = { color: '#0000FFAA', blur: 2, offsetX: 6, offsetY: 4 };
    const rect = { id: 'r', type: 'rect', x: 30, y: 20, width: 50, height: 30, fill: '#FF8800' };
    // Skia zeichnet die Gruppe selbst; mit einem leeren html-Kind setzt der Compositor sie zusammen.
    const skia = await render(project([{ id: 'g', type: 'group', x: 5, y: 3, filters, shadow, children: [rect] }]));
    const composite = await render(project([{ id: 'g', type: 'group', x: 5, y: 3, filters, shadow, children: [rect, { id: 'h', type: 'html', html: '', width: 1, height: 1, background: '#00000000' }] }]));
    let worst = 0;
    let sum = 0;
    for (let i = 0; i < skia.data.length; i++) {
      const d = Math.abs((skia.data[i] ?? 0) - (composite.data[i] ?? 0));
      worst = Math.max(worst, d);
      sum += d;
    }
    expect(sum / skia.data.length).toBeLessThan(1);
    expect(worst).toBeLessThanOrEqual(12);
  });

  it('wendet filters an scene3d an, auch ohne Gruppe und isoliert (Story 17.11)', async () => {
    const plain = await render(project([scene3d({ filters: [{ type: 'invert', amount: 1 }] })]));
    expect(px(plain, 10, 10)).toEqual([0, 255, 255, 255]);
    const isolated = await render(project([scene3d({ blendMode: 'screen', filters: [{ type: 'invert', amount: 1 }] })]));
    expect(px(isolated, 10, 10)).toEqual([0, 255, 255, 255]);
  });

});

describe('Farbräume im Frame-Render (Story 17.2)', () => {
  const layers = [
    { id: 'red', type: 'rect', width: 160, height: 90, fill: '#FF0000' },
    { id: 'green', type: 'rect', width: 160, height: 90, fill: '#00FF00', opacity: 0.5 },
  ];

  it('mischt im Arbeitsfarbraum aus settings.workingColorSpace', async () => {
    const srgb = await render(project([{ id: 'l', type: 'layer', children: [layers[0]] }, { id: 'l2', type: 'layer', children: [layers[1]] }]));
    const linear = await render(project([{ id: 'l', type: 'layer', children: [layers[0]] }, { id: 'l2', type: 'layer', children: [layers[1]] }], { settings: { workingColorSpace: 'linear' } }));
    // Halbes Grün über Rot: in sRGB R ≈ 128, in linearem Licht R ≈ 188.
    expect(Math.abs(px(srgb, 5, 5)[0] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(px(linear, 5, 5)[0] - 188)).toBeLessThanOrEqual(2);
  });

  it('kodiert die Ausgabe mit outputColorSpace "linear"', async () => {
    const p = project([{ id: 'r', type: 'rect', width: 160, height: 90, fill: '#BCBCBC' }], { settings: { outputColorSpace: 'linear' } });
    const r = await renderFrame(env, p, { frame: 0, useCache: false });
    expect(px(r.image, 5, 5)).toEqual([128, 128, 128, 255]);
    const srgb = await renderFrame(env, project([{ id: 'r', type: 'rect', width: 160, height: 90, fill: '#BCBCBC' }]), { frame: 0, useCache: false });
    expect(r.key).not.toBe(srgb.key);
  });

  it('liest layer.colorSpace "linear" als lineares Licht', async () => {
    const image = await render(project([{ id: 'l', type: 'layer', colorSpace: 'linear', children: [{ id: 'r', type: 'rect', width: 160, height: 90, fill: '#808080' }] }]));
    expect(px(image, 5, 5)).toEqual([188, 188, 188, 255]);
  });
});

describe('zIndex im Frame-Render (Story 17.3)', () => {
  it('zeichnet nach zIndex und zeigt die effektive Reihenfolge im Szenenbaum', async () => {
    const p = project([
      { id: 'front', type: 'rect', width: 160, height: 90, fill: '#00FF00', zIndex: 1 },
      { id: 'back', type: 'rect', width: 160, height: 90, fill: '#FF0000' },
    ]);
    const r = await renderFrame(env, p, { frame: 0, useCache: false });
    expect(px(r.image, 5, 5)).toEqual([0, 255, 0, 255]);
    expect(sceneTree(r.scene, r.bounds).map((n) => [n.id, n.zIndex])).toEqual([
      ['back', undefined],
      ['front', 1],
    ]);
  });
});
