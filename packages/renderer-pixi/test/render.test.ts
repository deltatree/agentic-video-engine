/**
 * Golden-Tests des PixiJS-Renderers in Chromium (SwiftShader, WebGL): je Node-Typ und Merkmal ein Bild.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIXI_CASES } from './fixtures/pixi-cases.js';
import { bundle, fromPage, hashImage, matchGolden, openPage, serve, writeContactSheet, type Rgba } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden');
const FONT = readFileSync(join(HERE, '..', '..', 'fonts', 'assets', 'inter', 'InterVariable.ttf'));

interface PageApi {
  ovRender: (name: string, frame?: number) => Promise<{ width: number; height: number; data: string }>;
  ovRenderError: (nodes: unknown) => Promise<string>;
  ovVideoRequests: { name: string; seconds: number }[];
}

let server: { url: string; close: () => Promise<void> };
let browser: Browser;
let page: Page;
const sheet: { name: string; img: Rgba }[] = [];

async function renderCase(p: Page, name: string, frame?: number): Promise<Rgba> {
  return fromPage(await p.evaluate(([n, f]) => (window as unknown as PageApi).ovRender(n, f), [name, frame] as const));
}

beforeAll(async () => {
  const js = await bundle(join(HERE, 'fixtures', 'pixi-entry.ts'));
  server = await serve({
    '/index.html': {
      body: '<!doctype html><html><head><style>@font-face { font-family: "Inter"; src: url(/fonts/inter.ttf) format("truetype"); font-weight: 100 900; }</style></head><body><script type="module" src="/entry.js"></script></body></html>',
      type: 'text/html',
    },
    '/entry.js': { body: js, type: 'text/javascript' },
    '/fonts/inter.ttf': { body: FONT, type: 'font/ttf' },
  });
  ({ browser, page } = await openPage(server.url));
}, 180_000);

afterAll(async () => {
  const target = process.env['CONTACT_SHEET'];
  if (target !== undefined) writeContactSheet(target, sheet, 5);
  await browser.close();
  await server.close();
});

describe('Golden Images', () => {
  for (const name of Object.keys(PIXI_CASES)) {
    it(name, async () => {
      const img = await renderCase(page, name);
      sheet.push({ name, img });
      const result = matchGolden(GOLDEN, name, img);
      expect(result.ok, result.message).toBe(true);
    });
  }
});

describe('Semantik', () => {
  it('liefert ein Canvas in Größe width·scale × height·scale', async () => {
    const img = await renderCase(page, 'preview-scale');
    expect([img.width, img.height]).toEqual([100, 75]);
  });

  it('fragt Video-Frames zur Quellzeit startFrom + localTime · playbackRate an', async () => {
    await renderCase(page, 'video', 45);
    const requests = await page.evaluate(() => (window as unknown as PageApi).ovVideoRequests);
    expect(requests.at(-1)).toEqual({ name: 'clip', seconds: 1 + (45 / 30) * 2 });
  });

  it('lässt den Hintergrund transparent', async () => {
    const img = await renderCase(page, 'shader');
    expect(img.data[3]).toBe(0);
    const center = ((75 * 200) + 100) * 4;
    expect(img.data[center + 3]).toBeGreaterThan(100);
  });

  it('wirft OV_PIXI_UNSUPPORTED für nicht unterstützte Node-Typen', async () => {
    const node = { id: 'l', type: 'lottie', props: { width: 10, height: 10, asset: 'a' }, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: '' };
    expect(await page.evaluate((n) => (window as unknown as PageApi).ovRenderError([n]), node)).toBe('OV_PIXI_UNSUPPORTED');
    const sksl = { ...node, type: 'shader', props: { width: 10, height: 10, sksl: 'half4 main(float2 c) { return half4(1); }' } };
    expect(await page.evaluate((n) => (window as unknown as PageApi).ovRenderError([n]), sksl)).toBe('OV_PIXI_UNSUPPORTED');
  });
});

describe('Determinismus', () => {
  it('rendert in zwei frischen Browsern bitgleich, unabhängig von vorherigen Frames', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await openPage(server.url);
      try {
        if (i === 1) for (let f = 0; f < 10; f++) await renderCase(p.page, 'particles', f);
        hashes.push(hashImage(await renderCase(p.page, 'particles')) + hashImage(await renderCase(p.page, 'text-wrap-center')) + hashImage(await renderCase(p.page, 'mask-alpha')) + hashImage(await renderCase(p.page, 'shader')));
      } finally {
        await p.browser.close();
      }
    }
    expect(hashes[0]).toBe(hashes[1]);
  }, 120_000);
});
