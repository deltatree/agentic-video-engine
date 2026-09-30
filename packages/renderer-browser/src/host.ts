/**
 * Chromium-Render-Host (FR-36, FR-37, AD-13, ADR 0013).
 *
 * Ein Host hält einen Browser, einen Kontext und eine Seite je Ausgabegröße.
 * Die Seiten bleiben über viele Frames geladen; pro Frame lädt nichts neu.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { OpenVideoError, minimalChildEnv, premultiplyInPlace, type AssetResolver, type Diagnostic, type FontResolver, type RgbaImage } from '@agentic-video/core';
import { decodePng } from '@agentic-video/png';
import { browserGpuMode, chromiumArgsFor, chromiumGpuEnv, graphicsArgsFor, pageGraphics, type BrowserGpuMode, type PageGraphics } from './gpu.js';
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
 *
 * Netzsperre unterhalb von HTTP (D3): Der Route-Handler sieht nur HTTP und WebSocket.
 * Deshalb löst `--host-resolver-rules` keinen Namen auf (auch kein DNS-Prefetch), der Proxy
 * zeigt auf einen toten Port (nur `127.0.0.1` geht direkt), und WebRTC darf kein UDP ohne
 * Proxy senden. Zusätzlich entfernt ein Init-Skript die WebRTC-Schnittstellen.
 *
 * `--enable-unsafe-swiftshader` und `--enable-unsafe-webgpu` stehen nicht hier, sondern in
 * {@link CHROMIUM_GRAPHICS_ARGS}: Sie gelten nur, sobald ein WebGL-/WebGPU-Layer (`three`, `pixi`)
 * gerendert wird (Story 16.1). HTML-Layer rastern mit und ohne sie pixelgleich.
 *
 * Im GPU-Modus (`OPENVIDEO_BROWSER_GPU=1`, Option `gpu`, ADR 0019) ersetzt `chromiumArgsFor`
 * `--use-angle=swiftshader` durch nativen ANGLE (`CHROMIUM_NATIVE_GPU_ARGS`).
 */
export const CHROMIUM_ARGS: readonly string[] = [
  '--use-angle=swiftshader',
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
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/**
 * Zusätzliche Schalter für WebGL (SwiftShader) und WebGPU. Der Host startet Chromium erst mit
 * ihnen neu, wenn der erste `three`- oder `pixi`-Layer kommt (Story 16.1).
 */
export const CHROMIUM_GRAPHICS_ARGS: readonly string[] = ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'];

/**
 * Minimale Umgebung für den Chromium-Prozess (N1): nur die Variablen aus `CHILD_ENV_NAMES`
 * (`minimalChildEnv` in `@agentic-video/core`). Tokens und S3-Schlüssel (`OPENVIDEO_*`,
 * `AWS_*`) bleiben draußen.
 *
 * @example
 * ```ts
 * chromiumEnv({ PATH: '/usr/bin', OPENVIDEO_WORKER_TOKEN: 'secret' }); // { PATH: '/usr/bin' }
 * ```
 */
export function chromiumEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return minimalChildEnv(source);
}

/**
 * Prüft, ob Chromium mit der Sandbox des Betriebssystems startet (z. B. nicht als root ohne
 * User Namespaces). Ohne sie verweigert der Host HTML-Skripte (Story 16.1).
 *
 * Unterscheidet (Befund m9): Fehlt das Programm, wirft die Funktion `OV_BROWSER_CHROMIUM_MISSING`;
 * startet Chromium auch ohne Sandbox nicht, wirft sie `OV_BROWSER_LAUNCH`. Nur wenn Chromium ohne,
 * aber nicht mit Sandbox startet, ist das Ergebnis `false`. Gestartet wird ohne die unsicheren
 * Grafik-Schalter ({@link CHROMIUM_GRAPHICS_ARGS}).
 *
 * @example
 * ```ts
 * if (!(await probeOsSandbox())) console.warn('HTML scripts are unavailable here.');
 * ```
 */
export async function probeOsSandbox(executablePath?: string): Promise<boolean> {
  const path = resolveExecutable(executablePath);
  const attempt = async (sandbox: boolean): Promise<unknown> => {
    try {
      const browser = await chromium.launch({ executablePath: path, headless: true, chromiumSandbox: sandbox, args: [...CHROMIUM_ARGS], env: chromiumEnv(process.env), ignoreDefaultArgs: [...CHROMIUM_GRAPHICS_ARGS] });
      await browser.close();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  if ((await attempt(true)) === undefined) return true;
  const plain = await attempt(false);
  if (plain !== undefined) {
    throw hostError('OV_BROWSER_LAUNCH', `Chromium could not start from "${path}", even without the OS sandbox.`, ['Check system libraries with `npx playwright install-deps chromium`.', 'Check that Chromium matches playwright-core (`npx playwright install chromium`).'], plain);
  }
  return false;
}

/** Aufnahmebereich eines HTML-Layers (Story 18.4). */
type HtmlArea = { readonly kind: 'empty' } | { readonly kind: 'full' } | { readonly kind: 'clip'; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/**
 * Läuft in der Seite: Rechteck aller sichtbaren Node-Container unter `#ov-root` in ganzen Pixeln
 * (ein Pixel Rand), begrenzt auf den Viewport. `full`, sobald ein Container über seine Box hinaus
 * zeichnen kann (`filter`, `box-shadow`, `outline`), `empty` ohne sichtbaren Container.
 */
function htmlContentArea(size: { readonly width: number; readonly height: number }): HtmlArea {
  const root = document.getElementById('ov-root');
  if (root === null) return { kind: 'full' };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const el of Array.from(root.children)) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.filter !== 'none' || cs.boxShadow !== 'none' || cs.outlineStyle !== 'none') return { kind: 'full' };
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  }
  if (!(x1 > x0 && y1 > y0)) return { kind: 'empty' };
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return { kind: 'full' };
  const cx0 = Math.max(0, Math.floor(x0) - 1);
  const cy0 = Math.max(0, Math.floor(y0) - 1);
  const cx1 = Math.min(size.width, Math.ceil(x1) + 1);
  const cy1 = Math.min(size.height, Math.ceil(y1) + 1);
  if (cx1 <= cx0 || cy1 <= cy0) return { kind: 'empty' };
  return { kind: 'clip', x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

/** WebRTC-Schnittstellen, die das Init-Skript aus jedem Dokument entfernt (D3). */
const WEBRTC_GLOBALS: readonly string[] = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
  'RTCIceTransport',
  'RTCDtlsTransport',
  'RTCSctpTransport',
  'RTCRtpSender',
  'RTCRtpReceiver',
  'RTCRtpTransceiver',
  'RTCCertificate',
  'RTCDTMFSender',
  'RTCPeerConnectionIceEvent',
  'RTCDataChannelEvent',
  'RTCTrackEvent',
];

const NO_WEBRTC_JS = `(()=>{for(const n of ${JSON.stringify(WEBRTC_GLOBALS)})Reflect.deleteProperty(globalThis,n);})();`;

/** Standard-Obergrenze gleichzeitig offener Seiten (eine je Ausgabegröße). */
const DEFAULT_MAX_PAGES = 4;

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
  /**
   * Skripte in HTML-Layern ausführen (ADR 0008). Standard `false`: Layer-Dokumente laufen
   * in einem iframe ohne `allow-scripts` und mit CSP `script-src 'none'`.
   * Nur ausdrücklich (`--trusted`, `OPENVIDEO_ALLOW_HTML_SCRIPTS=1`) auf `true` setzen. Startet
   * Chromium dann nicht mit der OS-Sandbox, bricht der Host mit `OV_BROWSER_NO_OS_SANDBOX` ab.
   */
  readonly allowHtmlScripts?: boolean;
  /** Höchstzahl offener Seiten; die am längsten ungenutzte Größe wird geschlossen (LRU). Standard 4. */
  readonly maxPages?: number;
  /**
   * Chromium mit nativem ANGLE auf der GPU des Hosts statt SwiftShader starten (T5, ADR 0019).
   * Standard: `OPENVIDEO_BROWSER_GPU=1`, sonst `false` (SwiftShader, bitgleich auf jeder Maschine).
   */
  readonly gpu?: boolean;
}

/** Ein laufender Render-Host. */
export interface BrowserHost {
  /** Rendert einen Layer zu vormultipliziertem RGBA in Größe `payload.width × payload.height`. */
  render(kind: BrowserLayerKind, payload: BrowserLayerPayload): Promise<RgbaImage>;
  /** Versionen: `chromium` (tatsächlich, aus `browser.version()`), `three`, `pixi`, `browser-gpu` (Modus). */
  versions(): Readonly<Record<string, string>>;
  /** Grafik-Modus: `swiftshader` (Standard) oder `native` (ANGLE auf der Host-GPU). */
  readonly gpuMode: BrowserGpuMode;
  /**
   * WebGL2-Renderer und WebGPU-Adapter auf der Render-Seite, nach dem Neustart mit den
   * Grafik-Schaltern. Einmal geprüft, danach gemerkt (Story 21.5).
   */
  graphics(): Promise<PageGraphics>;
  /** Zahl der blockierten Netzanfragen seit dem Start (Sicherheits-Nachweis). */
  readonly blockedRequests: number;
  /** Zahl der offenen Seiten (höchstens `maxPages`). */
  readonly openPages: number;
  /** Läuft Chromium mit der Sandbox des Betriebssystems? */
  readonly osSandbox: boolean;
  /** Hinweise zum Start, z. B. `OV_BROWSER_NO_OS_SANDBOX`, wenn die OS-Sandbox fehlt. */
  readonly diagnostics: readonly Diagnostic[];
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
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  if (!positive(payload.fps) || !positive(payload.scale)) {
    throw hostError('OV_BROWSER_PAYLOAD', `Invalid fps (${String(payload.fps)}) or scale (${String(payload.scale)}).`, ['Pass finite values fps > 0 and scale > 0.']);
  }
  // Die virtuelle Uhr braucht endliche Zeiten (D5); NaN würde `Date.now()` vergiften.
  const bad = [payload.time, payload.frame].some((v) => !Number.isFinite(v)) ? 'the layer' : payload.nodes.find((n) => !Number.isFinite(n.time.localFrame))?.id;
  if (bad !== undefined) {
    throw hostError('OV_BROWSER_PAYLOAD', `The time of ${bad === 'the layer' ? bad : `node "${bad}"`} is not a finite number.`, ['Pass finite frame numbers and times; check the timeline evaluation for NaN or Infinity.']);
  }
}

/** Fehler-Codes, die die Seiten-Laufzeit als Präfix `OV_…:` in ihre Fehlermeldung schreibt. */
const PAGE_CODES: Readonly<Record<string, readonly string[]>> = {
  OV_BROWSER_RUNTIME: ['Rebuild the runtime with `npm run build:extra -w @agentic-video/renderer-browser`.', 'Check that no page script removes window.__ovRuntime.'],
  OV_BROWSER_TIMER_LIMIT: ['Do not reschedule timers endlessly (e.g. setTimeout(f, 0) inside f).', 'Drive animation from window.openvideo.onFrame instead of timers.'],
  OV_BROWSER_PAYLOAD: ['Pass finite frame numbers and times.'],
};

/**
 * Übersetzt einen Fehler aus `page.evaluate` in einen {@link OpenVideoError}. Meldungen mit einem
 * bekannten Präfix `OV_…: ` (z. B. `OV_BROWSER_RUNTIME`, `OV_BROWSER_TIMER_LIMIT`) behalten ihren Code.
 *
 * @example
 * ```ts
 * pageError('html', new Error('OV_BROWSER_RUNTIME: The page runtime is not loaded.')).diagnostic.code; // 'OV_BROWSER_RUNTIME'
 * ```
 */
export function pageError(kind: BrowserLayerKind, error: unknown): OpenVideoError {
  const message = error instanceof Error ? error.message : String(error);
  for (const [code, suggestions] of Object.entries(PAGE_CODES)) {
    const at = message.indexOf(`${code}: `);
    if (at >= 0) return hostError(code, message.slice(at + code.length + 2).split('\n')[0] ?? message, suggestions, error);
  }
  return hostError('OV_BROWSER_RENDER', `Chromium failed to render the ${kind} layer: ${message}`, ['Check the layer content for script errors.', 'Run the layer alone to isolate the failing node.'], error);
}

/**
 * Schließt eine Seite. Ein Fehler hier ist erwartbar (Seite oder Browser schon weg) und darf
 * den eigentlichen Fehler des Aufrufers nicht verdecken (D4); er wird deshalb nur gezählt.
 */
function closePage(page: Page, failures: { count: number }): Promise<void> {
  return page.close().catch(() => {
    failures.count++;
  });
}

/** Ein laufender Browser mit Kontext und Seiten-Cache. */
interface Session {
  readonly browser: Browser;
  readonly context: BrowserContext;
  /** Seiten je Ausgabegröße in LRU-Reihenfolge (zuletzt benutzt am Ende). */
  readonly pages: Map<string, Promise<PageEntry>>;
  alive: boolean;
  /** Laufende Aufträge, die einen Slot dieser Sitzung halten (Befund m9: der Grafik-Neustart wartet darauf). */
  readonly inflight: Set<Promise<void>>;
}

/**
 * Startet Chromium mit Netzblockade, virtueller Zeit und lokaler HTTP-Origin.
 *
 * Ohne `allowHtmlScripts` laufen in HTML-Layern keine Skripte (D1). Stürzt Chromium ab,
 * startet der Host es bei der nächsten Anfrage neu (D4).
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
  const allowScripts = options.allowHtmlScripts === true;
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
  const gpuMode = browserGpuMode(options.gpu);
  const graphicsArgs = graphicsArgsFor(gpuMode);
  const server: HostServer = await startHostServer({ runtimeJs, assets: options.assets, fonts: options.fonts });
  const diagnostics: Diagnostic[] = [];
  const closeFailures = { count: 0 };
  let osSandbox = true;
  /** Läuft Chromium mit den Schaltern für WebGL/WebGPU ({@link CHROMIUM_GRAPHICS_ARGS})? */
  let graphics = false;
  let blocked = 0;
  let closed = false;
  let current: Promise<Session> | undefined;
  let live: Session | undefined;

  const launchBrowser = async (): Promise<Browser> => {
    const args = [...chromiumArgsFor(CHROMIUM_ARGS, gpuMode), ...(graphics ? graphicsArgs : [])];
    // Playwright setzt `--enable-unsafe-swiftshader` selbst; ohne Grafik-Layer und im GPU-Modus wird es abgewählt.
    const ignore = graphics ? (gpuMode === 'native' ? ['--enable-unsafe-swiftshader'] : []) : [...CHROMIUM_GRAPHICS_ARGS];
    const launch = (sandbox: boolean) =>
      chromium.launch({ executablePath, headless: true, chromiumSandbox: sandbox, args, env: chromiumGpuEnv(process.env, gpuMode), ...(ignore.length > 0 ? { ignoreDefaultArgs: ignore } : {}) });
    if (!osSandbox) return launch(false);
    try {
      return await launch(true);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
      const suggestions = ['Allow unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=1, kernel.apparmor_restrict_unprivileged_userns=0) and do not run Chromium as root.'];
      if (allowScripts) {
        // Skripte nie ohne OS-Sandbox (Story 16.1, H1): lieber abbrechen als still ungeschützt rendern.
        throw hostError('OV_BROWSER_NO_OS_SANDBOX', `HTML scripts are enabled, but Chromium could not start with the OS sandbox: ${reason}`, [...suggestions, 'Or render without HTML scripts (drop --trusted / OPENVIDEO_ALLOW_HTML_SCRIPTS).'], error);
      }
      // Ohne Skripte ist die Seite statisch (CSP script-src 'none'); die Sandbox fehlt dann nur als zweite Wand.
      osSandbox = false;
      diagnostics.push({
        code: 'OV_BROWSER_NO_OS_SANDBOX',
        severity: 'warning',
        errorClass: 'BrowserRendererError',
        problem: `Chromium could not start with the OS sandbox and runs without it (HTML scripts stay disabled): ${reason}`,
        suggestions,
      });
      return launch(false);
    }
  };

  const startSession = async (): Promise<Session> => {
    let browser: Browser | undefined;
    try {
      browser = await launchBrowser();
      const context = await browser.newContext({
        serviceWorkers: 'block',
        deviceScaleFactor: 1,
        colorScheme: 'light',
        locale: 'en-US',
        timezoneId: 'UTC',
        acceptDownloads: false,
        viewport: { width: options.width, height: options.height },
      });
      // Netzblockade: nur die eigene Origin; sie bekommt das Token als Header (D2).
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (new URL(request.url()).origin === server.origin) {
          await route.continue({ headers: { ...request.headers(), ...server.headers } });
          return;
        }
        blocked++;
        await route.abort('blockedbyclient');
      });
      await context.routeWebSocket(/.*/u, async (ws) => {
        blocked++;
        await ws.close({ code: 1008, reason: 'Network access is blocked in the render host.' });
      });
      await context.addInitScript({ content: NO_WEBRTC_JS });
      await context.addInitScript({ content: clockJs });
      const session: Session = { browser, context, pages: new Map(), alive: true, inflight: new Set() };
      browser.on('disconnected', () => {
        // Absturz oder Ende: Cache leeren; die nächste Anfrage startet Chromium neu.
        session.alive = false;
        session.pages.clear();
      });
      return session;
    } catch (error) {
      await browser?.close();
      if (error instanceof OpenVideoError) throw error;
      throw hostError('OV_BROWSER_LAUNCH', `Chromium could not start from "${executablePath}".`, ['Check that Chromium matches playwright-core 1.63 (`npx playwright install chromium`).', 'Check system libraries with `npx playwright install-deps chromium`.'], error);
    }
  };

  const session = (): Promise<Session> => {
    if (current === undefined || live?.alive === false) {
      const started = startSession().then((s) => {
        live = s;
        return s;
      });
      current = started;
      started.catch(() => {
        if (current === started) current = undefined;
      });
    }
    return current;
  };

  /**
   * Startet Chromium einmalig mit {@link CHROMIUM_GRAPHICS_ARGS} neu, sobald ein WebGL-/WebGPU-Layer
   * kommt. Laufende Aufträge der alten Seiten laufen vorher zu Ende.
   */
  /** Laufender Neustart für Grafik-Layer; `generation` zählt Neustarts (Befund m9). */
  let restart: Promise<void> = Promise.resolve();
  let generation = 0;

  const ensureGraphics = (): Promise<void> => {
    if (graphics) return restart;
    graphics = true;
    generation++;
    const old = current;
    current = undefined;
    restart = (async () => {
      const s = await old?.then(
        (value) => value,
        () => undefined,
      );
      if (s === undefined) return;
      // Erst alle Aufträge, die schon einen Slot der alten Sitzung halten, zu Ende laufen lassen.
      await Promise.all([...s.inflight]);
      s.alive = false;
      s.pages.clear();
      await s.browser.close();
    })();
    return restart;
  };

  const openPage = async (s: Session, width: number, height: number): Promise<PageEntry> => {
    const page = await s.context.newPage();
    await page.setViewportSize({ width, height });
    const cdp = await s.context.newCDPSession(page);
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.goto(`${server.origin}/index.html`, { waitUntil: 'load' });
    const ready = await page.evaluate(() => window.__ovRuntime !== undefined && window.__ovClock !== undefined);
    if (!ready) throw hostError('OV_BROWSER_RUNTIME', 'The page runtime did not start in Chromium.', ['Rebuild the runtime with `npm run build:extra -w @agentic-video/renderer-browser`.']);
    return { page, cdp, queue: Promise.resolve() };
  };

  const pageFor = async (width: number, height: number): Promise<{ readonly session: Session; readonly key: string; readonly entry: Promise<PageEntry>; readonly release: () => void }> => {
    let s: Session;
    for (;;) {
      const gen = generation;
      s = await session();
      // Hat inzwischen ein Grafik-Neustart begonnen, gehört diese Sitzung schon zur alten Generation.
      if (gen === generation) break;
    }
    // Slot sofort (ohne `await` dazwischen) anmelden, damit ein Neustart auf diesen Auftrag wartet.
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.inflight.add(hold);
    const done = (): void => {
      s.inflight.delete(hold);
      release();
    };
    const key = `${String(width)}x${String(height)}`;
    let entry = s.pages.get(key);
    if (entry === undefined) {
      const opened = openPage(s, width, height);
      entry = opened;
      opened.catch(() => {
        if (s.pages.get(key) === opened) s.pages.delete(key);
      });
    }
    // LRU: zuletzt benutzte Größe ans Ende; die älteste schließt, sobald ihre Warteschlange leer ist.
    s.pages.delete(key);
    s.pages.set(key, entry);
    for (const [oldKey, old] of s.pages) {
      if (s.pages.size <= maxPages) break;
      s.pages.delete(oldKey);
      void old.then(
        (e) => e.queue.then(() => closePage(e.page, closeFailures)),
        () => undefined,
      );
    }
    return { session: s, key, entry, release: done };
  };

  let libraryVersions: Readonly<Record<string, string>>;
  let chromiumVersion: string;
  let graphicsInfo: Promise<PageGraphics> | undefined;
  try {
    const first = await pageFor(options.width, options.height);
    const entry = await first.entry.finally(first.release);
    chromiumVersion = first.session.browser.version();
    libraryVersions = await entry.page.evaluate(() => window.__ovRuntime?.versions() ?? {});
  } catch (error) {
    await live?.browser.close();
    await server.close();
    throw error instanceof OpenVideoError ? error : hostError('OV_BROWSER_LAUNCH', 'The render page could not be opened.', ['Rebuild the runtime with `npm run build:extra -w @agentic-video/renderer-browser`.'], error);
  }

  /**
   * Nimmt den HTML-Layer auf (Story 18.4): nur das Rechteck, in dem die sichtbaren Node-Container
   * liegen (`getBoundingClientRect` mit Transform, plus ein Pixel Rand für Kantenglättung), als PNG
   * mit `clip`; der Rest des Layers ist transparent. Container mit `filter`, `box-shadow` oder
   * `outline` zeichnen über ihre Box hinaus; dann wird wie bisher das ganze Bild aufgenommen.
   * Ohne sichtbaren Container entfällt die Aufnahme ganz.
   */
  const capture = async (entry: PageEntry, width: number, height: number): Promise<RgbaImage> => {
    const area = await entry.page.evaluate(htmlContentArea, { width, height });
    if (area.kind === 'empty') return { width, height, data: new Uint8Array(width * height * 4) };
    const clip = area.kind === 'clip' ? area : { x: 0, y: 0, w: width, h: height };
    const full = clip.x === 0 && clip.y === 0 && clip.w === width && clip.h === height;
    const shot = await entry.cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
      ...(full ? {} : { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } }),
    });
    const image = decodePng(new Uint8Array(Buffer.from(shot.data, 'base64')));
    if (image.width !== clip.w || image.height !== clip.h) {
      throw hostError('OV_BROWSER_CAPTURE', `Screenshot has size ${String(image.width)}×${String(image.height)}, expected ${String(clip.w)}×${String(clip.h)}.`, ['Check that no device scale factor is forced on the render host.']);
    }
    if (full) return image;
    const data = new Uint8Array(width * height * 4);
    const rowBytes = clip.w * 4;
    for (let y = 0; y < clip.h; y++) data.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), ((clip.y + y) * width + clip.x) * 4);
    return { width, height, data };
  };

  const renderOn = async (entry: PageEntry, kind: BrowserLayerKind, payload: BrowserLayerPayload): Promise<RgbaImage> => {
    const { width, height } = payload;
    if (kind === 'html') {
      await entry.page.evaluate(
        async ([p, scripts]) => {
          const rt = window.__ovRuntime;
          // Präfix `OV_BROWSER_RUNTIME: ` → der Host macht daraus einen OpenVideoError (PAGE_CODES).
          if (rt === undefined) throw new Error('OV_BROWSER_RUNTIME: The page runtime (window.__ovRuntime) is not loaded.');
          await rt.renderHtml(p, { allowScripts: scripts });
        },
        [payload, allowScripts] as const,
      );
      return capture(entry, width, height);
    }
    const upload = server.expectFrame(width * height * 4);
    try {
      await entry.page.evaluate(
        async ([k, p, url]) => {
          const rt = window.__ovRuntime;
          if (rt === undefined) throw new Error('OV_BROWSER_RUNTIME: The page runtime (window.__ovRuntime) is not loaded.');
          await (k === 'three' ? rt.renderThree(p, url) : rt.renderPixi(p, url));
        },
        [kind, payload, upload.url] as const,
      );
      // Der Upload-Puffer gehört uns: in place vormultiplizieren (Story 18.4), keine Kopie.
      return { width, height, data: premultiplyInPlace(await upload.bytes) };
    } catch (error) {
      // Niemand wartet mehr auf den Upload; seine Ablehnung ist erwartet und darf nicht unbehandelt bleiben.
      upload.bytes.catch(() => undefined);
      upload.cancel(error);
      throw error;
    }
  };

  return {
    get blockedRequests() {
      return blocked;
    },
    get openPages() {
      return live?.pages.size ?? 0;
    },
    get osSandbox() {
      return osSandbox;
    },
    diagnostics,
    gpuMode,
    versions: () => ({ chromium: chromiumVersion, ...libraryVersions, 'browser-gpu': gpuMode }),
    graphics() {
      if (closed) return Promise.reject(hostError('OV_BROWSER_CLOSED', 'The render host is closed.', ['Create a new host with `createBrowserHost`.']));
      graphicsInfo ??= (async () => {
        await ensureGraphics();
        const slot = await pageFor(options.width, options.height);
        try {
          const entry = await slot.entry;
          const job = entry.queue.then(() => withTimeout(entry.page.evaluate(pageGraphics), timeoutMs, 'The graphics probe'));
          entry.queue = job.catch((error: unknown) => error);
          const info = await job;
          chromiumVersion = slot.session.browser.version();
          return info;
        } finally {
          slot.release();
        }
      })();
      const pending = graphicsInfo;
      pending.catch(() => {
        if (graphicsInfo === pending) graphicsInfo = undefined;
      });
      return pending;
    },
    async render(kind, payload) {
      if (closed) throw hostError('OV_BROWSER_CLOSED', 'The render host is closed.', ['Create a new host with `createBrowserHost`.']);
      checkSize(payload);
      if (kind !== 'html') await ensureGraphics();
      const slot = await pageFor(payload.width, payload.height);
      try {
        const entry = await slot.entry;
        const run = () => withTimeout(renderOn(entry, kind, payload), timeoutMs, `Rendering the ${kind} layer`);
        const job = entry.queue.then(run, run);
        entry.queue = job.catch((error: unknown) => error);
        try {
          return await job;
        } catch (error) {
          if (error instanceof OpenVideoError) {
            if (error.diagnostic.code === 'OV_BROWSER_TIMEOUT') {
              // Eine hängende Seite ist verbraucht; die nächste Anfrage öffnet eine neue.
              // Nur den eigenen Eintrag entfernen: eine andere Anfrage kann schon eine neue Seite halten.
              if (slot.session.pages.get(slot.key) === slot.entry) slot.session.pages.delete(slot.key);
              await closePage(entry.page, closeFailures);
            }
            throw error;
          }
          throw pageError(kind, error);
        }
      } finally {
        slot.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        // Ein gescheiterter Start hat keinen Browser zum Schließen.
        const s = await current?.then(
          (value) => value,
          () => undefined,
        );
        await s?.browser.close();
      } finally {
        await server.close();
      }
    },
  };
}
