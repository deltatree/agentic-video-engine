/**
 * Regressionstests für die Befunde D1–D5 (Review 2026-09-28, Gruppe D).
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenVideoError, type EvaluatedNode, type RgbaImage } from '@agentic-video/core';
import { CHROMIUM_ARGS, createBrowserHost, type BrowserHost } from '../src/host.js';
import { startHostServer } from '../src/server.js';
import { buildRuntime, memoryAssets, node, pixel, testFonts } from './helpers.js';

const W = 80;
const H = 40;
const FPS = 30;
const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];

function html(id: string, markup: string, css = '', frame = 0): EvaluatedNode {
  return node(id, 'html', { width: W, height: H, html: markup, css }, frame);
}

function render(host: BrowserHost, n: EvaluatedNode, frame = 0): Promise<RgbaImage> {
  return host.render('html', { nodes: [n], width: W, height: H, scale: 1, frame, time: frame / FPS, fps: FPS, seed: 1 });
}

/** Jede Variante färbt den Layer rot, sobald ihr Skript läuft. */
const PAINT = "document.documentElement.style.background='red'";
const SCRIPT_VARIANTS: Readonly<Record<string, { html: string; css?: string }>> = {
  'img onerror': { html: `<img src="missing.png" onerror="${PAINT}">` },
  'svg onload': { html: `<svg onload="${PAINT}"></svg>` },
  'javascript:-URL': { html: `<iframe style="display:none" src="javascript:parent.${PAINT}"></iframe>` },
  'iframe srcdoc': { html: `<iframe style="display:none" srcdoc="&lt;script&gt;parent.${PAINT}&lt;/script&gt;"></iframe>` },
  'css-Ausbruch': { html: '<p></p>', css: `p{color:blue}</style><script>${PAINT}</script><style>` },
};

let locked: BrowserHost;
let open: BrowserHost;

beforeAll(async () => {
  buildRuntime();
  locked = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
  open = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H, allowHtmlScripts: true });
});

afterAll(async () => {
  await locked.close();
  await open.close();
});

describe('D1: HTML-Skripte nur mit allowHtmlScripts', () => {
  for (const [name, variant] of Object.entries(SCRIPT_VARIANTS)) {
    it(`ohne allowHtmlScripts läuft kein Skript: ${name}`, async () => {
      const image = await render(locked, html(`d1-${name}`, variant.html, variant.css));
      expect(pixel(image, W / 2, H / 2)).not.toEqual(RED);
    });
  }

  for (const name of ['img onerror', 'svg onload', 'javascript:-URL', 'iframe srcdoc']) {
    it(`mit allowHtmlScripts läuft das Skript: ${name}`, async () => {
      const variant = SCRIPT_VARIANTS[name];
      if (variant === undefined) throw new Error(`missing variant ${name}`);
      const image = await render(open, html(`d1-open-${name}`, variant.html, variant.css));
      expect(pixel(image, W / 2, H / 2)).toEqual(RED);
    });
  }

  it('css kann das <style> auch mit allowHtmlScripts nicht verlassen', async () => {
    const variant = SCRIPT_VARIANTS['css-Ausbruch'];
    const image = await render(open, html('d1-css-open', variant?.html ?? '', variant?.css));
    expect(pixel(image, W / 2, H / 2)).not.toEqual(RED);
  });

  it('CSS-Animationen laufen ohne Skripte frame-genau weiter', async () => {
    const box = (frame: number) => html('d1-anim', '<div class="b"></div>', '@keyframes m{from{background:#f00}to{background:#00f}}.b{width:100%;height:100%;animation:m 1s linear forwards}', frame);
    expect(pixel(await render(locked, box(0)), 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(await render(locked, box(30)), 10, 10)).toEqual([0, 0, 255, 255]);
  });
});

describe('D2: Token und Frame-IDs', () => {
  it('Layer-Dokumente sehen kein Token in URL oder baseURI', async () => {
    const probe = html('d2-token', `<div id=o style="width:100%;height:100%"></div><script>
      const seen = [location.href, document.baseURI, parent.location.href, top.location.href, document.referrer].join(' ');
      o.style.background = /[0-9a-f]{32}/.test(seen) ? '#f00' : '#0f0';
    </script>`);
    expect(pixel(await render(open, probe), W / 2, H / 2)).toEqual(GREEN);
  });

  it('der Server antwortet nur mit Token-Header; Frame-IDs sind zufällig', async () => {
    const server = await startHostServer({ runtimeJs: '', assets: memoryAssets({}), fonts: testFonts() });
    try {
      expect((await fetch(`${server.origin}/index.html`)).status).toBe(404);
      expect((await fetch(`${server.origin}/index.html`, { headers: server.headers })).status).toBe(200);
      const a = server.expectFrame(4);
      const b = server.expectFrame(4);
      expect(a.url).toMatch(/^\/frame\/[0-9a-f-]{36}$/u);
      expect(a.url).not.toBe(b.url);
      a.cancel(new Error('test'));
      b.cancel(new Error('test'));
      await expect(a.bytes).rejects.toThrow('test');
      await expect(b.bytes).rejects.toThrow('test');
    } finally {
      await server.close();
    }
  });
});

describe('D3: Netz und OS-Sandbox', () => {
  it('Chromium-Schalter sperren DNS, Proxy und WebRTC-UDP', () => {
    expect(CHROMIUM_ARGS).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(CHROMIUM_ARGS.some((a) => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND'))).toBe(true);
    expect(CHROMIUM_ARGS.some((a) => a.startsWith('--proxy-server='))).toBe(true);
  });

  it('WebRTC ist in Layer-Dokumenten nicht vorhanden', async () => {
    const probe = html('d3-rtc', `<div id=o style="width:100%;height:100%"></div><script>
      const f = document.createElement('iframe'); document.body.append(f);
      const names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate'];
      const found = names.some((n) => n in window || n in f.contentWindow);
      o.style.background = found ? '#f00' : '#0f0';
    </script>`);
    expect(pixel(await render(open, probe), W / 2, H / 2)).toEqual(GREEN);
  });

  it('Chromium läuft mit OS-Sandbox, wenn die Umgebung sie erlaubt', () => {
    expect(locked.osSandbox).toBe(true);
    expect(locked.diagnostics).toEqual([]);
  });
});

describe('D4: Seiten-Cache', () => {
  it('hält höchstens maxPages Seiten (LRU)', async () => {
    const host = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: 20, height: 20, maxPages: 2 });
    try {
      for (const size of [20, 21, 22, 23, 20]) {
        await host.render('html', { nodes: [node('p', 'html', { width: size, height: size, html: '' })], width: size, height: size, scale: 1, frame: 0, time: 0, fps: FPS, seed: 1 });
        expect(host.openPages).toBeLessThanOrEqual(2);
      }
    } finally {
      await host.close();
    }
  });

  it('startet Chromium nach einem Absturz neu', async () => {
    const host = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
    try {
      const pids = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter((p) => p !== '');
      const chrome = pids.filter((pid) => execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).includes('--remote-debugging-pipe'));
      expect(chrome.length).toBeGreaterThan(0);
      for (const pid of chrome) process.kill(Number(pid), 'SIGKILL');
      await expect.poll(() => host.openPages, { timeout: 10_000 }).toBe(0);
      const image = await render(host, html('d4-crash', '<div style="width:100%;height:100%;background:#0f0"></div>'));
      expect(pixel(image, W / 2, H / 2)).toEqual(GREEN);
    } finally {
      await host.close();
    }
  });

  it('nach einem Timeout rendert die nächste Anfrage auf einer neuen Seite', async () => {
    const host = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H, timeoutMs: 1500, allowHtmlScripts: true });
    try {
      const hang = html('d4-hang', '<script>openvideo.onFrame(() => { for (;;) {} })</script>');
      await expect(render(host, hang)).rejects.toThrow(/longer than/u);
      const image = await render(host, html('d4-ok', '<div style="width:100%;height:100%;background:#0f0"></div>'));
      expect(pixel(image, W / 2, H / 2)).toEqual(GREEN);
    } finally {
      await host.close();
    }
  }, 30_000);
});

describe('D5: Virtuelle Uhr', () => {
  it('meldet das Timer-Limit als Diagnose statt still abzubrechen', async () => {
    const loop = html('d5-loop', '<script>function f() { setTimeout(f, 0); } f();</script>');
    const error: unknown = await render(open, loop).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(OpenVideoError);
    expect(error instanceof OpenVideoError ? error.diagnostic.code : '').toBe('OV_BROWSER_TIMER_LIMIT');
  });

  it('lehnt eine nicht endliche Zeit ab', async () => {
    const n = { ...html('d5-nan', '<p>x</p>'), time: { localFrame: Number.NaN, relFrame: 0, durationFrames: 60, progress: 0, compositionFrame: 0 } };
    const error: unknown = await render(open, n).then(() => undefined, (e: unknown) => e);
    expect(error instanceof OpenVideoError ? error.diagnostic.code : '').toBe('OV_BROWSER_PAYLOAD');
  });

  it('document.timeline.currentTime und Event.timeStamp folgen der virtuellen Uhr', async () => {
    const probe = (frame: number) =>
      html('d5-timeline', `<div id=o style="width:100%;height:100%"></div><script>
        openvideo.onFrame(() => {
          const ok = document.timeline.currentTime === performance.now() && new Event('x').timeStamp === performance.now();
          o.style.background = ok ? '#0f0' : '#f00';
        });
      </script>`, '', frame);
    expect(pixel(await render(open, probe(0)), W / 2, H / 2)).toEqual(GREEN);
    expect(pixel(await render(open, probe(30)), W / 2, H / 2)).toEqual(GREEN);
  });
});
