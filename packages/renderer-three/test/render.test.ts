/**
 * Golden-Tests des Three.js-Renderers in Chromium (SwiftShader, WebGPU und WebGL2).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THREE_CASES } from './fixtures/three-cases.js';
import { bundle, fromPage, hashImage, matchGolden, openPage, serve, writeContactSheet, type Rgba } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden');

interface PageResult {
  width: number;
  height: number;
  data: string;
  backend: string | undefined;
}

let server: { url: string; close: () => Promise<void> };
let browser: Browser;
let page: Page;
const sheet: { name: string; img: Rgba }[] = [];

async function renderCase(p: Page, name: string, backend: string, frame?: number): Promise<{ img: Rgba; backend: string | undefined }> {
  const result = await p.evaluate(([n, b, f]) => (window as unknown as { ovRender: (n: string, b: string, f?: number) => Promise<PageResult> }).ovRender(n, b, f), [name, backend, frame] as const);
  return { img: fromPage(result), backend: result.backend };
}

async function freshPage(): Promise<{ browser: Browser; page: Page }> {
  return openPage(server.url);
}

beforeAll(async () => {
  const js = await bundle(join(HERE, 'fixtures', 'three-entry.ts'));
  server = await serve({
    '/index.html': { body: '<!doctype html><html><body><script type="module" src="/entry.js"></script></body></html>', type: 'text/html' },
    '/entry.js': { body: js, type: 'text/javascript' },
  });
  ({ browser, page } = await freshPage());
}, 180_000);

afterAll(async () => {
  const target = process.env['CONTACT_SHEET'];
  if (target !== undefined) writeContactSheet(target, sheet);
  await browser.close();
  await server.close();
});

describe('Golden Images', () => {
  for (const [name, c] of Object.entries(THREE_CASES)) {
    for (const backend of c.backends ?? ['webgpu', 'webgl2']) {
      it(`${name} (${backend})`, async () => {
        const { img, backend: active } = await renderCase(page, name, backend);
        expect(active).toBe(backend);
        sheet.push({ name: `${name}-${backend}`, img });
        const result = matchGolden(GOLDEN, `${name}-${backend}`, img);
        expect(result.ok, result.message).toBe(true);
      });
    }
  }
});

describe('Semantik', () => {
  it('liefert ein Canvas in Größe width·scale × height·scale', async () => {
    const { img } = await renderCase(page, 'preview-scale', 'webgl2');
    expect([img.width, img.height]).toEqual([80, 60]);
  });

  it('lässt den Hintergrund ohne background transparent', async () => {
    for (const backend of ['webgpu', 'webgl2']) {
      const { img } = await renderCase(page, 'transparent-background', backend);
      expect(img.data[3]).toBe(0);
      expect(img.data[img.data.length - 1]).toBe(0);
      const opaque = img.data.filter((_, i) => i % 4 === 3 && img.data[i] === 255).length;
      expect(opaque).toBeGreaterThan(1000);
    }
  });

  it('wählt mit auto WebGPU und fällt für GLSL auf WebGL2 zurück', async () => {
    expect((await renderCase(page, 'geometry-box', 'auto')).backend).toBe('webgpu');
    const shader = await page.evaluate(() =>
      (window as unknown as { ovRender: (n: string, b: string) => Promise<PageResult> }).ovRender('shader-material', 'auto').then((r) => r.backend),
    );
    expect(shader).toBe('webgl2');
  });

  it('meldet GLSL unter erzwungenem WebGPU als OV_THREE_BACKEND_FEATURE', async () => {
    const code = await page.evaluate(() => (window as unknown as { ovRenderError: (n: string, b: string) => Promise<string> }).ovRenderError('shader-material-webgpu', 'webgpu'));
    expect(code).toBe('OV_THREE_BACKEND_FEATURE');
  });
});

describe('Determinismus', () => {
  it('Animation Clip bei Frame n in frischem Browser gleich wie nach Frames 0..n', async () => {
    const n = 20;
    for (const backend of ['webgpu', 'webgl2']) {
      const fresh = await freshPage();
      try {
        const direct = hashImage((await renderCase(fresh.page, 'gltf-animation', backend, n)).img);
        const seq = await freshPage();
        try {
          let last = '';
          for (let f = 0; f <= n; f++) last = hashImage((await renderCase(seq.page, 'gltf-animation', backend, f)).img);
          expect(last).toBe(direct);
        } finally {
          await seq.browser.close();
        }
      } finally {
        await fresh.browser.close();
      }
    }
  }, 240_000);

  it('rendert in zwei frischen Browsern bitgleich', async () => {
    for (const backend of ['webgpu', 'webgl2']) {
      const hashes: string[] = [];
      for (let i = 0; i < 2; i++) {
        const p = await freshPage();
        try {
          hashes.push(hashImage((await renderCase(p.page, 'pbr', backend)).img) + hashImage((await renderCase(p.page, 'particles', backend)).img));
        } finally {
          await p.browser.close();
        }
      }
      expect(hashes[0]).toBe(hashes[1]);
    }
  }, 240_000);
});
