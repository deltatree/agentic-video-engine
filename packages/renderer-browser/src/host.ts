/**
 * Chromium-Render-Host (FR-36, FR-37, AD-13, ADR 0013).
 *
 * Ein Host hält einen Browser, einen Kontext und eine Seite je Ausgabegröße.
 * Die Seiten bleiben über viele Frames geladen; pro Frame lädt nichts neu.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { OpenVideoError, type AssetResolver, type FontResolver, type RgbaImage } from '@agentic-video/core';
import { decodePng, premultiply } from '@agentic-video/png';
import type { BrowserLayerKind, BrowserLayerPayload } from './protocol.js';
import { startHostServer, type HostServer } from './server.js';

/**
 * Chromium-Schalter des Hosts. Alle sind in Chromium 153 vorhanden (per Suche in der
 * Programmdatei geprüft). `--font-render-hinting=none` und `--deterministic-mode` kennt nur
 * die Headless Shell, nicht das volle Chromium aus `chromium.executablePath()`; sie fehlen daher.
 * Graustufen-Kantenglättung sichert `--disable-lcd-text`.
 * `--disable-partial-raster`, `--disable-threaded-animation`, `--disable-checker-imaging` und
 * `--run-all-compositor-stages-before-draw` machen das Rastern unabhängig vom vorigen Frame;
 * ohne sie wich im Test etwa jeder achte Frame einer animierten Kante um 2 Stufen ab.
 */
export const CHROMIUM_ARGS: readonly string[] = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--disable-lcd-text',
  '--force-color-profile=srgb',
  '--disable-gpu-rasterization',
  '--disable-partial-raster',
  '--disable-threaded-animation',
  '--disable-checker-imaging',
  '--run-all-compositor-stages-before-draw',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-breakpad',
  '--metrics-recording-only',
  '--no-first-run',
  '--mute-audio',
];

/** Optionen für {@link createBrowserHost}. */
export interface BrowserHostOptions {
  /** Pfad zu Chromium. Vorrang: Option, dann `OPENVIDEO_CHROMIUM`, dann `chromium.executablePath()`. */
  readonly executablePath?: string;
  readonly assets: AssetResolver;
  readonly fonts: FontResolver;
  /** Ausgabegröße der ersten Seite; weitere Größen bekommen bei Bedarf eine eigene Seite. */
  readonly width: number;
  readonly height: number;
  /** Zeitlimit je Layer in Millisekunden. Standard 60 000. */
  readonly timeoutMs?: number;
}

/** Ein laufender Render-Host. */
export interface BrowserHost {
  /** Rendert einen Layer zu vormultipliziertem RGBA in Größe `payload.width × payload.height`. */
  render(kind: BrowserLayerKind, payload: BrowserLayerPayload): Promise<RgbaImage>;
  /** Versionen: `chromium`, `three`, `pixi`. */
  versions(): Readonly<Record<string, string>>;
  /** Zahl der blockierten Netzanfragen seit dem Start (Sicherheits-Nachweis). */
  readonly blockedRequests: number;
  /** Schließt Browser und Server. Mehrfacher Aufruf ist erlaubt. */
  close(): Promise<void>;
}

interface PageEntry {
  readonly page: Page;
  readonly cdp: CDPSession;
  queue: Promise<unknown>;
}

function hostError(code: string, problem: string, suggestions: readonly string[], cause?: unknown): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'BrowserRendererError', problem, suggestions, ...(cause === undefined ? {} : { cause }) });
}

/** Liest eine gebündelte Datei aus `dist/` (auch wenn der Host aus `src/` läuft, z. B. in Tests). */
function readBundle(name: string): string {
  const candidates = [new URL(`./${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url)];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw hostError('OV_BROWSER_RUNTIME_MISSING', `The page runtime bundle "${name}" was not found.`, ['Run `npm run build:extra -w @agentic-video/renderer-browser` to bundle the page runtime.']);
}

function resolveExecutable(option: string | undefined): string {
  const fromEnv = process.env['OPENVIDEO_CHROMIUM'];
  const path = option ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : chromium.executablePath());
  if (!existsSync(path)) {
    throw hostError('OV_BROWSER_CHROMIUM_MISSING', `Chromium was not found at "${path}".`, [
      'Install Chromium with `npx playwright install chromium`.',
      'Or set OPENVIDEO_CHROMIUM to the path of a Chromium executable.',
    ]);
  }
  return path;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(hostError('OV_BROWSER_TIMEOUT', `${what} took longer than ${String(ms)} ms.`, ['Simplify the layer content or raise `timeoutMs`.', 'Make sure page scripts do not wait for real time or network.']));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function checkSize(payload: BrowserLayerPayload): void {
  const ok = (v: number) => Number.isInteger(v) && v > 0 && v <= 16384;
  if (!ok(payload.width) || !ok(payload.height)) {
    throw hostError('OV_BROWSER_SIZE', `Invalid output size ${String(payload.width)}×${String(payload.height)}.`, ['Use integer output sizes between 1 and 16384 pixels.']);
  }
  if (!(payload.fps > 0) || !(payload.scale > 0)) {
    throw hostError('OV_BROWSER_PAYLOAD', `Invalid fps (${String(payload.fps)}) or scale (${String(payload.scale)}).`, ['Pass fps > 0 and scale > 0.']);
  }
}

/**
 * Startet Chromium mit Netzblockade, virtueller Zeit und lokaler HTTP-Origin.
 *
 * @example
 * ```ts
 * const host = await createBrowserHost({ assets, fonts, width: 1920, height: 1080 });
 * const image = await host.render('html', { nodes: [htmlNode], width: 1920, height: 1080, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 });
 * await host.close();
 * ```
 */
export async function createBrowserHost(options: BrowserHostOptions): Promise<BrowserHost> {
  const runtimeJs = readBundle('runtime.js');
  const clockJs = readBundle('clock.js');
  const executablePath = resolveExecutable(options.executablePath);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const server: HostServer = await startHostServer({ runtimeJs, assets: options.assets, fonts: options.fonts });
  let browser: Browser | undefined;
  let blocked = 0;
  let frameCounter = 0;
  let closed = false;
  const pages = new Map<string, Promise<PageEntry>>();
  let context: BrowserContext;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: [...CHROMIUM_ARGS] });
    context = await browser.newContext({
      serviceWorkers: 'block',
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
      acceptDownloads: false,
      viewport: { width: options.width, height: options.height },
    });
    // Netzblockade: nur die eigene Origin; Pfade ohne Token werden auf das Token umgeschrieben.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === server.origin) {
        if (url.pathname.startsWith(server.prefix)) await route.continue();
        else await route.continue({ url: `${server.origin}${server.prefix}${url.pathname.slice(1)}${url.search}` });
        return;
      }
      blocked++;
      await route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/u, async (ws) => {
      blocked++;
      await ws.close({ code: 1008, reason: 'Network access is blocked in the render host.' });
    });
    await context.addInitScript({ content: clockJs });
  } catch (error) {
    await browser?.close();
    await server.close();
    throw hostError('OV_BROWSER_LAUNCH', `Chromium could not start from "${executablePath}".`, ['Check that Chromium matches playwright-core 1.63 (`npx playwright install chromium`).', 'Check system libraries with `npx playwright install-deps chromium`.'], error);
  }
  const chromiumVersion = browser.version();

  const openPage = async (width: number, height: number): Promise<PageEntry> => {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.goto(`${server.origin}${server.prefix}index.html`, { waitUntil: 'load' });
    const ready = await page.evaluate(() => window.__ovRuntime !== undefined && window.__ovClock !== undefined);
    if (!ready) throw hostError('OV_BROWSER_RUNTIME', 'The page runtime did not start in Chromium.', ['Rebuild the runtime with `npm run build:extra -w @agentic-video/renderer-browser`.']);
    return { page, cdp, queue: Promise.resolve() };
  };
  const pageFor = (width: number, height: number): Promise<PageEntry> => {
    const key = `${String(width)}x${String(height)}`;
    let entry = pages.get(key);
    if (entry === undefined) {
      entry = openPage(width, height);
      pages.set(key, entry);
      entry.catch(() => pages.delete(key));
    }
    return entry;
  };

  let libraryVersions: Readonly<Record<string, string>>;
  try {
    const first = await pageFor(options.width, options.height);
    libraryVersions = await first.page.evaluate(() => window.__ovRuntime?.versions() ?? {});
  } catch (error) {
    await browser.close();
    await server.close();
    throw error instanceof OpenVideoError ? error : hostError('OV_BROWSER_LAUNCH', 'The render page could not be opened.', ['Rebuild the runtime with `npm run build:extra -w @agentic-video/renderer-browser`.'], error);
  }

  const capture = async (entry: PageEntry, width: number, height: number): Promise<RgbaImage> => {
    const shot = await entry.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const image = decodePng(new Uint8Array(Buffer.from(shot.data, 'base64')));
    if (image.width !== width || image.height !== height) {
      throw hostError('OV_BROWSER_CAPTURE', `Screenshot has size ${String(image.width)}×${String(image.height)}, expected ${String(width)}×${String(height)}.`, ['Check that no device scale factor is forced on the render host.']);
    }
    return image;
  };

  const renderOn = async (entry: PageEntry, kind: BrowserLayerKind, payload: BrowserLayerPayload): Promise<RgbaImage> => {
    const { width, height } = payload;
    if (kind === 'html') {
      await entry.page.evaluate(async (p) => {
        const rt = window.__ovRuntime;
        if (rt === undefined) throw new Error('Page runtime missing.');
        await rt.renderHtml(p);
      }, payload);
      return capture(entry, width, height);
    }
    const upload = server.expectFrame(String(++frameCounter), width * height * 4);
    try {
      await entry.page.evaluate(
        async ([k, p, url]) => {
          const rt = window.__ovRuntime;
          if (rt === undefined) throw new Error('Page runtime missing.');
          await (k === 'three' ? rt.renderThree(p, url) : rt.renderPixi(p, url));
        },
        [kind, payload, upload.url] as const,
      );
      return { width, height, data: premultiply(await upload.bytes) };
    } catch (error) {
      upload.cancel(error);
      throw error;
    }
  };

  return {
    get blockedRequests() {
      return blocked;
    },
    versions: () => ({ chromium: chromiumVersion, ...libraryVersions }),
    async render(kind, payload) {
      if (closed) throw hostError('OV_BROWSER_CLOSED', 'The render host is closed.', ['Create a new host with `createBrowserHost`.']);
      checkSize(payload);
      const entry = await pageFor(payload.width, payload.height);
      const job = entry.queue.then(
        () => withTimeout(renderOn(entry, kind, payload), timeoutMs, `Rendering the ${kind} layer`),
        () => withTimeout(renderOn(entry, kind, payload), timeoutMs, `Rendering the ${kind} layer`),
      );
      entry.queue = job.catch((error: unknown) => error);
      try {
        return await job;
      } catch (error) {
        if (error instanceof OpenVideoError) {
          if (error.diagnostic.code === 'OV_BROWSER_TIMEOUT') {
            // Eine hängende Seite ist verbraucht; die nächste Anfrage öffnet eine neue.
            pages.delete(`${String(payload.width)}x${String(payload.height)}`);
            await entry.page.close();
          }
          throw error;
        }
        throw hostError('OV_BROWSER_RENDER', `Chromium failed to render the ${kind} layer: ${error instanceof Error ? error.message : String(error)}`, ['Check the layer content for script errors.', 'Run the layer alone to isolate the failing node.'], error);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
      await server.close();
    },
  };
}
