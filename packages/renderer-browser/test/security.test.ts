/**
 * Regressionstests für die Befunde D1–D5 (Review 2026-09-28, Gruppe D).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { OpenVideoError, type EvaluatedNode, type RgbaImage } from '@agentic-video/core';
import { CHROMIUM_ARGS, CHROMIUM_GRAPHICS_ARGS, chromiumEnv, createBrowserHost, type BrowserHost } from '../src/host.js';
import { startHostServer } from '../src/server.js';
import { buildRuntime, chromiumProcesses, memoryAssets, node, osSandboxAvailable, pixel, testFonts } from './helpers.js';

/** HTML-Skripte laufen nur mit OS-Sandbox (Story 16.1); Skript-Tests brauchen sie. */
const sandbox = await osSandboxAvailable();
const SANDBOX_REASON = 'OS-Sandbox für Chromium fehlt (unprivilegierte User-Namespaces): kernel.apparmor_restrict_unprivileged_userns=0 setzen';
const NEEDS_SANDBOX = ' (braucht OS-Sandbox für Skripte)';

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
  open = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H, allowHtmlScripts: sandbox });
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
    it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`mit allowHtmlScripts läuft das Skript: ${name}${NEEDS_SANDBOX}`, async () => {
      const variant = SCRIPT_VARIANTS[name];
      if (variant === undefined) throw new Error(`missing variant ${name}`);
      const image = await render(open, html(`d1-open-${name}`, variant.html, variant.css));
      expect(pixel(image, W / 2, H / 2)).toEqual(RED);
    });
  }

  it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`css kann das <style> auch mit allowHtmlScripts nicht verlassen${NEEDS_SANDBOX}`, async () => {
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
  it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`Layer-Dokumente sehen kein Token in URL oder baseURI${NEEDS_SANDBOX}`, async () => {
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

  it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`WebRTC ist in Layer-Dokumenten nicht vorhanden${NEEDS_SANDBOX}`, async () => {
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

  it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`nach einem Timeout rendert die nächste Anfrage auf einer neuen Seite${NEEDS_SANDBOX}`, async () => {
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
  it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`meldet das Timer-Limit als Diagnose statt still abzubrechen${NEEDS_SANDBOX}`, async () => {
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

  it.skipIf(skipUnless(sandbox, SANDBOX_REASON))(`document.timeline.currentTime und Event.timeStamp folgen der virtuellen Uhr${NEEDS_SANDBOX}`, async () => {
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

/**
 * Chromium-Wrapper, der ohne `--no-sandbox` nicht startet: so fehlt die OS-Sandbox in jeder Umgebung
 * reproduzierbar (auch in CI, wo sie sonst verfügbar ist).
 */
function noSandboxChromium(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ov-nosandbox-'));
  const path = join(dir, 'chromium');
  const real = process.env['OPENVIDEO_CHROMIUM'] ?? chromium.executablePath();
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--no-sandbox" ] && exec ${JSON.stringify(real)} "$@"; done\necho "No usable sandbox (test wrapper)." >&2\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('Story 16.1: Skripte nur mit OS-Sandbox, Grafik-Schalter nur bei Bedarf, minimale Umgebung', () => {
  it('bricht mit OV_BROWSER_NO_OS_SANDBOX ab, wenn Skripte verlangt sind und die OS-Sandbox fehlt', async () => {
    const error: unknown = await createBrowserHost({ executablePath: noSandboxChromium(), assets: memoryAssets({}), fonts: testFonts(), width: W, height: H, allowHtmlScripts: true }).then(
      async (host) => {
        await host.close();
        return undefined;
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenVideoError);
    expect(error instanceof OpenVideoError ? error.diagnostic.code : '').toBe('OV_BROWSER_NO_OS_SANDBOX');
  });

  it('ohne Skripte startet der Host ohne OS-Sandbox und meldet eine Warnung', async () => {
    const host = await createBrowserHost({ executablePath: noSandboxChromium(), assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
    try {
      expect(host.osSandbox).toBe(false);
      expect(host.diagnostics.map((d) => [d.code, d.severity])).toEqual([['OV_BROWSER_NO_OS_SANDBOX', 'warning']]);
      const image = await render(host, html('s161-static', '<div style="width:100%;height:100%;background:#0f0"></div>'));
      expect(pixel(image, W / 2, H / 2)).toEqual(GREEN);
    } finally {
      await host.close();
    }
  });

  it('startet Chromium für HTML ohne --enable-unsafe-swiftshader/--enable-unsafe-webgpu', async () => {
    expect(CHROMIUM_ARGS.some((a) => CHROMIUM_GRAPHICS_ARGS.includes(a))).toBe(false);
    await render(locked, html('s161-flags', '<p>x</p>'));
    const running = chromiumProcesses();
    expect(running.length).toBeGreaterThan(0);
    for (const p of running) for (const flag of CHROMIUM_GRAPHICS_ARGS) expect(p.args).not.toContain(flag);
  });

  it('Chromium erbt keine Geheimnisse aus der Umgebung (N1)', async () => {
    expect(chromiumEnv({ PATH: '/usr/bin', HOME: '/home/x', OPENVIDEO_WORKER_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'k' })).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
    process.env['OPENVIDEO_TEST_SECRET'] = 'must-not-leak';
    const host = await createBrowserHost({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
    try {
      const running = chromiumProcesses();
      expect(running.length).toBeGreaterThan(0);
      for (const p of running) expect(p.env).not.toContain('OPENVIDEO_TEST_SECRET');
    } finally {
      delete process.env['OPENVIDEO_TEST_SECRET'];
      await host.close();
    }
  });
});
