/**
 * Golden-Bilder: jede Komponente mit ihrem Beispiel, gerendert mit dem Skia-Backend.
 * Neu erzeugen: `UPDATE_GOLDENS=1 npx vitest run packages/components` und jedes Bild visuell prüfen.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Registry, SCHEMA_VERSION, evaluateScene, type AssetResolver, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { loadFontSet, type FontSet } from '@agentic-video/fonts';
import { decodePng, encodePng } from '@agentic-video/png';
import { createSkiaBackend, loadCanvasKitNode } from '@agentic-video/renderer-skia';
import { COMPONENTS, DEFAULT_THEME, registerComponents } from '@agentic-video/components';

const here = dirname(fileURLToPath(import.meta.url));
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 0.5;
const FRAME = 60;

/** Position je Komponente, damit das Beispiel gut im Bild liegt. */
const PLACEMENT: Readonly<Record<string, { x: number; y: number }>> = {
  Callout: { x: 520, y: 200 },
  Phone: { x: 480, y: 30 },
  DeviceFrame: { x: 400, y: 30 },
  Grid: { x: 0, y: 0 },
  ParticleField: { x: 0, y: 0 },
  GradientBackground: { x: 0, y: 0 },
  Spotlight: { x: 0, y: 0 },
};

/** Bunter Hintergrund für Komponenten, die das Bild darunter verändern. */
const BACKDROP = { type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [{ offset: 0, color: '#4F7CFF' }, { offset: 0.5, color: '#8B5CF6' }, { offset: 1, color: '#22D3EE' }] };

const noAssets: AssetResolver = {
  get: () => undefined,
  bytes: (id) => Promise.reject(new Error(`unknown asset ${id}`)),
  videoFrame: () => Promise.reject(new Error('no video')),
  all: () => [],
};

let skia: Promise<{ backend: RenderBackend; fonts: FontSet }> | undefined;
function setup(): Promise<{ backend: RenderBackend; fonts: FontSet }> {
  skia ??= (async () => {
    const fonts = await loadFontSet({ fonts: [] });
    return { backend: createSkiaBackend({ canvasKit: await loadCanvasKitNode(), fonts }), fonts };
  })();
  return skia;
}

async function renderComponent(name: string, props: Record<string, unknown>): Promise<RgbaImage> {
  const registry = new Registry();
  registerComponents(registry);
  const at = PLACEMENT[name] ?? { x: 80, y: 80 };
  const project = {
    schemaVersion: SCHEMA_VERSION,
    compositions: [
      {
        id: 'main',
        width: WIDTH,
        height: HEIGHT,
        fps: 30,
        duration: 90,
        nodes: [
          { id: 'bg', type: 'rect', width: WIDTH, height: HEIGHT, fill: name === 'Spotlight' || name === 'GlassPanel' ? BACKDROP : DEFAULT_THEME.colors.background },
          { id: 'c', type: 'component', component: name, props, ...at },
        ],
      },
    ],
  };
  const scene = evaluateScene(project, 'main', FRAME, { registry });
  expect(scene.diagnostics).toEqual([]);
  const { backend, fonts } = await setup();
  return backend.renderLayer({ layerId: 'layer-0', scene, nodes: scene.nodes, width: WIDTH * SCALE, height: HEIGHT * SCALE, scale: SCALE, assets: noAssets, fonts });
}

function expectGolden(name: string, image: RgbaImage): void {
  const file = join(here, 'golden', `${name}.png`);
  const png = encodePng(image);
  if (process.env['UPDATE_GOLDENS'] === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return;
  }
  expect(existsSync(file), `golden ${name}.png is missing; run with UPDATE_GOLDENS=1 and review it`).toBe(true);
  const expected = decodePng(new Uint8Array(readFileSync(file)));
  const actual = decodePng(png);
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
  let count = 0;
  for (let i = 0; i < actual.data.length; i++) if (Math.abs((actual.data[i] ?? 0) - (expected.data[i] ?? 0)) > 1) count++;
  expect({ name, differingChannels: count }).toEqual({ name, differingChannels: 0 });
}

describe('Golden-Bilder der Komponenten (Skia)', () => {
  it.each(COMPONENTS.map((c) => [c.name, c.example] as const))('%s', async (name, example) => {
    expectGolden(name, await renderComponent(name, { ...example }));
  });
});
