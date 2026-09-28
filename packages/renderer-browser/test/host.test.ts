import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvaluatedNode } from '@agentic-video/core';
import { createBrowserHost, type BrowserHost } from '../src/host.js';
import { checkHtmlNode } from '../src/html-check.js';
import { cssBlendMode, cssFilter, cssMatrix, htmlNodeStyle } from '../src/runtime/style.js';
import { fontFaceCss, mimeType, startHostServer } from '../src/server.js';
import { buildRuntime, hashImage, memoryAssets, node, pixel, testFonts, TEST_FONT } from './helpers.js';

const W = 240;
const H = 135;
const FPS = 30;

/** Inhalt, der nur von Zeit, Frame und Seed abhängt: CSS-Animation, Date, Math.random, rAF, setInterval, Canvas. */
function scene(frame: number): EvaluatedNode[] {
  const anim = node('anim', 'html', {
    width: W,
    height: H,
    html: '<div class="spin"></div>',
    css: '@keyframes s{to{transform:rotate(360deg);border-radius:50%}}.spin{position:absolute;left:20px;top:30px;width:70px;height:70px;background:linear-gradient(#f72585,#4361ee);animation:s 2s ease-in-out infinite}',
  }, frame);
  const script = node('script', 'html', {
    width: 120,
    height: 120,
    x: 110,
    y: 10,
    rotation: 5,
    html: `<canvas id="c" width="120" height="120"></canvas><div id="t" style="position:absolute;left:4px;top:4px;font:12px '${TEST_FONT}'"></div><script>
      const ctx = c.getContext('2d');
      let ticks = 0;
      setInterval(() => { ticks = Math.floor(performance.now() / 100); }, 100);
      function draw(now) {
        ctx.clearRect(0, 0, 120, 120);
        for (let i = 0; i < 12; i++) {
          ctx.fillStyle = 'hsl(' + Math.floor(Math.random() * 360) + ',80%,50%)';
          ctx.fillRect(Math.random() * 100, Math.random() * 100, 20, 20);
        }
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 110, (now / 1000) * 60, 10);
        t.textContent = new Date().toISOString().slice(11, 23) + ' ' + ticks;
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);
    </script>`,
  }, frame);
  return [anim, script];
}

async function renderAll(host: BrowserHost, frames: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const f of frames) {
    const image = await host.render('html', { nodes: scene(f), width: W, height: H, scale: 1, frame: f, time: f / FPS, fps: FPS, seed: 42 });
    out.set(f, hashImage(image));
  }
  return out;
}

describe('Determinismus', () => {
  beforeAll(() => {
    buildRuntime();
  });

  it('zwei getrennte Hosts, Frames in unterschiedlicher Reihenfolge → gleiche Hashes', async () => {
    const frames = [0, 7, 15, 30, 45];
    const a = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H, allowHtmlScripts: true });
    const b = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H, allowHtmlScripts: true });
    try {
      const first = await renderAll(a, frames);
      const second = await renderAll(b, [...frames].reverse());
      for (const f of frames) expect(second.get(f), `frame ${String(f)}`).toBe(first.get(f));
      expect(new Set(first.values()).size).toBe(frames.length);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe('Sicherheit', () => {
  let host: BrowserHost;
  beforeAll(async () => {
    buildRuntime();
    host = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: 100, height: 60, allowHtmlScripts: true });
  });
  afterAll(async () => {
    await host.close();
  });

  it('blockiert externe Anfragen (Zähler im Route-Handler); der Frame rendert trotzdem', async () => {
    const before = host.blockedRequests;
    const n = node('net', 'html', {
      width: 100,
      height: 60,
      html: '<img src="https://example.com/x.png" style="display:none"><link rel="stylesheet" href="https://example.com/x.css"><div style="width:100px;height:60px;background:#0a0"></div><script>fetch("http://example.org/data").catch(() => {});</script>',
    });
    const image = await host.render('html', { nodes: [n], width: 100, height: 60, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 });
    expect(host.blockedRequests - before).toBeGreaterThanOrEqual(3);
    expect(pixel(image, 50, 30)).toEqual([0, 170, 0, 255]);
  });

  it('meldet die Chromium-Version', () => {
    expect(host.versions()['chromium']).toMatch(/^\d+\./u);
  });
});

describe('HTTP-Server', () => {
  it('liefert nur mit Token-Header aus, mit korrektem MIME-Typ', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const server = await startHostServer({ runtimeJs: '/* rt */', assets: memoryAssets({ logo: { path: 'store/logo.png', bytes: png } }), fonts: testFonts() });
    try {
      const headers = server.headers;
      expect((await fetch(`${server.origin}/assets/logo`)).status).toBe(404);
      expect((await fetch(`${server.origin}/assets/logo`, { headers: { 'x-openvideo-token': 'wrong' } })).status).toBe(404);
      const ok = await fetch(`${server.origin}/assets/logo`, { headers });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png);
      expect((await fetch(`${server.origin}/assets/missing`, { headers })).status).toBe(404);
      const css = await (await fetch(`${server.origin}/fonts.css`, { headers })).text();
      expect(css).toContain(`font-family:"${TEST_FONT}"`);
      const font = testFonts().all()[0];
      const fontResponse = await fetch(`${server.origin}/fonts/${font?.hash ?? ''}`, { headers });
      expect(fontResponse.headers.get('content-type')).toBe('font/ttf');
    } finally {
      await server.close();
    }
  });

  it('nimmt Pixel per POST /frame/<id> an und prüft die Größe', async () => {
    const server = await startHostServer({ runtimeJs: '', assets: memoryAssets({}), fonts: testFonts() });
    try {
      const good = server.expectFrame(8);
      const res = await fetch(`${server.origin}${good.url}`, { method: 'POST', headers: server.headers, body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
      expect(res.status).toBe(204);
      expect(await good.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      const bad = server.expectFrame(8);
      const rejected = expect(bad.bytes).rejects.toThrow(/wrong size/u);
      expect((await fetch(`${server.origin}${bad.url}`, { method: 'POST', headers: server.headers, body: new Uint8Array([1, 2]) })).status).toBe(413);
      await rejected;
      expect((await fetch(`${server.origin}/frame/unknown`, { method: 'POST', headers: server.headers, body: new Uint8Array(8) })).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('mimeType und fontFaceCss', () => {
    expect(mimeType('a/b/model.GLB')).toBe('model/gltf-binary');
    expect(mimeType('x.unknown')).toBe('application/octet-stream');
    expect(fontFaceCss(testFonts())).toMatch(/font-weight:100 900;font-style:normal;font-display:block/u);
  });
});

describe('Stil-Berechnung', () => {
  it('Matrix mit Vorschau-Skalierung', () => {
    const n = node('m', 'html', { width: 100, height: 50, x: 10, y: 20 });
    expect(htmlNodeStyle(n, 0.5, () => 'x').transform).toBe(cssMatrix([0.5, 0, 0, 0.5, 5, 10]));
  });

  it('Filterkette, Schatten und Farbmatrix', () => {
    const f = cssFilter(
      [
        { type: 'blur', radius: 3 },
        { type: 'brightness', amount: 1.2 },
        { type: 'hue-rotate', degrees: 45 },
        { type: 'color-matrix', matrix: Array.from({ length: 20 }, (_, i) => (i % 6 === 0 ? 1 : 0)) },
      ],
      { color: '#000', blur: 2, offsetX: 1, offsetY: 2 },
      (i) => `cm${String(i)}`,
    );
    expect(f.filter).toBe('blur(3px) brightness(1.2) hue-rotate(45deg) url(#cm0) drop-shadow(1px 2px 2px #000)');
    expect(f.colorMatrices).toHaveLength(1);
    expect(cssFilter(undefined, undefined, () => 'x').filter).toBe('none');
  });

  it('Blend Modes', () => {
    expect(cssBlendMode('add')).toBe('plus-lighter');
    expect(cssBlendMode(undefined)).toBe('normal');
    expect(cssBlendMode('bogus')).toBeUndefined();
  });

  it('Reveal als clip-path', () => {
    const n = node('r', 'html', { width: 100, height: 40 }, 0, 60, { reveal: { shape: 'rect', direction: 'right', progress: 0.25 } });
    expect(htmlNodeStyle(n, 1, () => 'x').clipPath).toBe('inset(0px 0px 0px 75px)');
  });
});

describe('check()', () => {
  it('meldet <script> als Info OV_HTML_SCRIPT', () => {
    const result = checkHtmlNode({ id: 'h', type: 'html', width: 10, height: 10, html: '<p>x</p><SCRIPT>1</SCRIPT>' });
    expect(result.supported).toBe(true);
    expect(result.diagnostics.map((d) => [d.code, d.severity, d.nodeId])).toEqual([['OV_HTML_SCRIPT', 'info', 'h']]);
  });

  it('ohne Skript keine Diagnose', () => {
    expect(checkHtmlNode({ id: 'h', type: 'html', html: '<p>no scripts</p>' })).toEqual({ supported: true, diagnostics: [] });
  });

  it('Node-Maske ist nicht unterstützt', () => {
    const result = checkHtmlNode({ id: 'h', type: 'html', html: '', mask: { node: {} } });
    expect(result.supported).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('OV_BROWSER_UNSUPPORTED');
  });
});
