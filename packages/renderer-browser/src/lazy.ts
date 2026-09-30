/**
 * Träge Browser-Backends: Prüfung und Versionen stehen sofort bereit, Chromium startet erst
 * beim ersten Layer, der den Browser braucht. So kostet ein reines 2D-Projekt keinen Browserstart.
 *
 * Versionen (Cache-Schlüssel): `chromium` ist ohne eigenen Pfad die zu playwright-core gehörende
 * Version (vor dem Start bekannt, Schlüssel wie bisher). Mit `executablePath` bzw.
 * `OPENVIDEO_CHROMIUM` ist es die tatsächliche Version dieses Programms (`chrome --version`,
 * einmal je Pfad und Prozess, ohne Browserstart; Politur P1). `browser-gpu: 'native'` steht nur im
 * GPU-Modus darin (T5; SwiftShader-Schlüssel bleiben unverändert). Das `three`-Backend trägt nach
 * {@link LazyBrowserBackends.prepareGraphics} zusätzlich `three-webgpu` (`available`/`unavailable`):
 * davon hängt ab, ob `backend: 'auto'` WebGPU oder WebGL2 nutzt (Story 21.5) – und
 * `three-max-texture` (`MAX_TEXTURE_SIZE` von WebGL2): ab dieser Kante verkleinert `three` Texturen
 * mit `textureDownscale` (Review Q10). Das Ergebnis der Probe kann in einem Speicher
 * (`graphicsCache`) je Chromium-Version, Grafik-Schaltern und Modus liegen; dann startet
 * `prepareGraphics` kein Chromium. Die tatsächliche Chromium-Version steht nach dem Start in
 * {@link LazyBrowserBackends.runtimeVersions}.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpenVideoError, contentHash, isRecord, minimalChildEnv, sha256Hex, type BackendCheck, type LayerRequest, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { checkPixiNode, PIXI_CAPABILITIES, PIXI_VERSION } from '@agentic-video/renderer-pixi';
import { checkThreeNode, THREE_CAPABILITIES, THREE_VERSION } from '@agentic-video/renderer-three';
import { createBrowserBackends, PIXI_NODE_TYPES, type BrowserBackends } from './backends.js';
import { browserGpuMode, chromiumArgsFor, graphicsArgsFor, type BrowserGpuMode, type PageGraphics } from './gpu.js';
import { checkHtmlNode, HTML_CAPABILITIES } from './html-check.js';
import { CHROMIUM_ARGS, chromiumExecutable, type BrowserHostOptions } from './host.js';

/**
 * Chromium-Version, die zur installierten playwright-core-Version gehört (aus `browsers.json`).
 *
 * @example
 * ```ts
 * expectedChromiumVersion(); // '153.0.8010.12'
 * ```
 */
export function expectedChromiumVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('playwright-core/package.json');
  const raw: unknown = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8'));
  const browsers = isRecord(raw) && Array.isArray(raw['browsers']) ? raw['browsers'].filter(isRecord) : [];
  const chromium = browsers.find((b) => b['name'] === 'chromium');
  return typeof chromium?.['browserVersion'] === 'string' ? chromium['browserVersion'] : 'unknown';
}

/** Gelesene Versionen eigener Chromium-Programme je Pfad (einmal je Prozess). */
const customVersions = new Map<string, string>();

/** Ersatz-Version ohne `--version`: Hash über echten Pfad, Größe und Änderungszeit der Programmdatei. */
function binaryFingerprint(path: string): string {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return `custom-${sha256Hex(`${real}|${String(st.size)}|${String(st.mtimeMs)}`).slice(0, 16)}`;
  } catch (error) {
    // Fehlt die Datei, scheitert später der Start mit OV_BROWSER_CHROMIUM_MISSING; der Schlüssel bleibt eindeutig.
    if (!(error instanceof Error)) throw error;
    return `missing-${sha256Hex(path).slice(0, 16)}`;
  }
}

/**
 * Chromium-Version für Cache-Schlüssel, ohne Chromium zu starten. Ohne eigenen Pfad (Option oder
 * `OPENVIDEO_CHROMIUM`) die erwartete Version von playwright-core – Schlüssel bleiben bitgleich zu
 * früher. Mit eigenem Pfad die tatsächliche Version aus `<chrome> --version` (einmal je Pfad
 * gemerkt); gibt das Programm keine Version aus, ein Fingerabdruck der Programmdatei
 * (`custom-<hash>`), damit fremde Programme nie unter der erwarteten Version cachen.
 *
 * @example
 * ```ts
 * chromiumVersionFor(undefined, {}); // '153.0.8010.12' (playwright-core)
 * chromiumVersionFor('/usr/bin/chromium'); // '141.0.7390.37'
 * ```
 */
export function chromiumVersionFor(executablePath?: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const exe = chromiumExecutable(executablePath, env);
  if (!exe.custom) return expectedChromiumVersion();
  const known = customVersions.get(exe.path);
  if (known !== undefined) return known;
  let version: string;
  try {
    const out = execFileSync(exe.path, ['--version'], { encoding: 'utf8', timeout: 10_000, env: minimalChildEnv(process.env), stdio: ['ignore', 'pipe', 'ignore'] });
    version = /\b(\d+\.\d+\.\d+\.\d+)\b/u.exec(out)?.[1] ?? binaryFingerprint(exe.path);
  } catch (error) {
    // Programm fehlt, ist kein Chromium oder hängt: Fingerabdruck statt Version.
    if (!(error instanceof Error)) throw error;
    version = binaryFingerprint(exe.path);
  }
  customVersions.set(exe.path, version);
  return version;
}

/** Speicher für das Ergebnis der Grafik-Probe, z. B. eine Cache-Ebene (`get`/`put` über Inhalts-Hashes). */
export interface GraphicsProbeStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** Optionen für {@link createLazyBrowserBackends}. */
export interface LazyBrowserBackendsOptions extends BrowserHostOptions {
  /**
   * Speicher für das Ergebnis der Grafik-Probe (Politur P1). Schlüssel: Chromium-Version,
   * Grafik-Modus, Chromium- und Grafik-Schalter, Three.js-Version und im Modus `native` die GPU
   * des Hosts. Ein Treffer spart den Browserstart in {@link LazyBrowserBackends.prepareGraphics}.
   */
  readonly graphicsCache?: GraphicsProbeStore;
  /**
   * Beschreibung der Host-GPU (z. B. `NVIDIA A10G (23028 MiB)`). Im Modus `native` Teil des
   * Probe-Schlüssels; fehlt sie dort, wird die Probe nicht gespeichert (immer live geprüft).
   */
  readonly hostGpu?: string;
  /** Umgebungsvariablen für `OPENVIDEO_CHROMIUM` (Standard `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Liest die gespeicherte Probe; ein nicht erreichbarer Speicher zählt als Fehlgriff (die Probe läuft dann live). */
async function readProbe(store: GraphicsProbeStore, key: string): Promise<Uint8Array | undefined> {
  try {
    return await store.get(key);
  } catch (error) {
    if (!(error instanceof OpenVideoError)) throw error;
    return undefined;
  }
}

/** Speichert die Probe; scheitert der Speicher, bleibt nur der nächste Start ohne Treffer. */
async function writeProbe(store: GraphicsProbeStore, key: string, info: PageGraphics): Promise<void> {
  try {
    await store.put(key, new TextEncoder().encode(JSON.stringify(info)));
  } catch (error) {
    if (!(error instanceof OpenVideoError)) throw error;
  }
}

/** Liest ein gespeichertes Probe-Ergebnis; Unlesbares zählt als Fehlgriff. */
function parseGraphics(bytes: Uint8Array | undefined): PageGraphics | undefined {
  if (bytes === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(raw)) return undefined;
  const { webgl2, webgl2MaxTextureSize, webgpu, webgpuAvailable } = raw;
  if (typeof webgl2 !== 'string' || typeof webgl2MaxTextureSize !== 'number' || typeof webgpu !== 'string' || typeof webgpuAvailable !== 'boolean') return undefined;
  return { webgl2, webgl2MaxTextureSize, webgpu, webgpuAvailable };
}

function toCheck(diagnostics: ReturnType<typeof checkThreeNode>): BackendCheck {
  return { supported: diagnostics.every((d) => d.severity !== 'error'), diagnostics };
}

/** Träge Backends mit gemeinsamem Aufräumen. */
export interface LazyBrowserBackends {
  readonly browser: RenderBackend;
  readonly three: RenderBackend;
  readonly pixi: RenderBackend;
  /** Wurde Chromium gestartet? */
  started(): boolean;
  /** Grafik-Modus der Backends (`swiftshader` oder `native`). */
  readonly gpuMode: BrowserGpuMode;
  /**
   * Liefert WebGL2/WebGPU der Render-Seite: aus `graphicsCache`, wenn dort ein Ergebnis für diese
   * Chromium-Version und diese Schalter liegt (kein Browserstart), sonst startet Chromium mit den
   * Grafik-Schaltern, prüft (WebGPU per Mini-Render) und speichert das Ergebnis. Danach trägt
   * `three.versions()` den Eintrag `three-webgpu`. Für Projekte mit `scene3d` vor dem ersten
   * Cache-Schlüssel aufrufen, damit die WebGPU/WebGL2-Wahl im Schlüssel steht.
   */
  prepareGraphics(): Promise<PageGraphics>;
  /** Ergebnis von {@link prepareGraphics}, sonst `undefined`. */
  graphicsInfo(): PageGraphics | undefined;
  /** Tatsächliche Versionen nach dem Start (`chromium` aus `browser.version()`), vorher `undefined`. */
  runtimeVersions(): Readonly<Record<string, string>> | undefined;
  dispose(): Promise<void>;
}

/**
 * Erzeugt die drei Browser-Backends (`browser`, `three`, `pixi`), ohne Chromium sofort zu starten.
 *
 * @example
 * ```ts
 * const lazy = createLazyBrowserBackends({ assets, fonts, width: 1920, height: 1080, graphicsCache: cache.tier('layer') });
 * registry.registerBackend(lazy.browser);
 * ```
 */
export function createLazyBrowserBackends(options: LazyBrowserBackendsOptions): LazyBrowserBackends {
  const { graphicsCache, hostGpu, env, ...hostOptions } = options;
  let real: Promise<BrowserBackends> | undefined;
  let started: BrowserBackends | undefined;
  let graphics: PageGraphics | undefined;
  let probing: Promise<PageGraphics> | undefined;
  // Host und Schlüssel nutzen denselben Pfad: Option, dann OPENVIDEO_CHROMIUM aus `env`, dann playwright-core.
  const executable = chromiumExecutable(options.executablePath, env);
  const chromium = chromiumVersionFor(options.executablePath, env);
  const gpuMode = browserGpuMode(options.gpu, env);
  // Schlüssel der Probe; im Modus `native` nur mit bekannter Host-GPU (sonst immer live prüfen).
  const probeKey = gpuMode === 'native' && hostGpu === undefined ? undefined : contentHash({ v: 'openvideo-graphics-probe-2', chromium, mode: gpuMode, args: [...chromiumArgsFor(CHROMIUM_ARGS, gpuMode), ...graphicsArgsFor(gpuMode)], three: THREE_VERSION, hostGpu: gpuMode === 'native' ? (hostGpu ?? null) : null });
  const ensure = (): Promise<BrowserBackends> => {
    if (real === undefined) {
      const created = createBrowserBackends({ ...hostOptions, executablePath: executable.path, gpu: gpuMode === 'native' });
      real = created;
      created.then(
        (b) => {
          started = b;
        },
        () => {
          // Ein gescheiterter Start wird beim nächsten Layer erneut versucht.
          if (real === created) real = undefined;
        },
      );
    }
    return real;
  };
  const make = (id: 'browser' | 'three' | 'pixi', nodeTypes: readonly string[], capabilities: readonly string[], fusable: boolean, check: (node: Readonly<Record<string, unknown>>) => BackendCheck, versions: Readonly<Record<string, string>>): RenderBackend => ({
    id,
    nodeTypes,
    capabilities,
    fusable,
    // `browser-gpu` nur im GPU-Modus: Schlüssel im Standardmodus (SwiftShader) bleiben wie bisher.
    versions: () => ({ chromium, ...(gpuMode === 'native' ? { 'browser-gpu': 'native' } : {}), ...versions, ...(id === 'three' && graphics !== undefined ? { 'three-webgpu': graphics.webgpuAvailable ? 'available' : 'unavailable', 'three-max-texture': String(graphics.webgl2MaxTextureSize) } : {}) }),
    check,
    async renderLayer(request: LayerRequest): Promise<RgbaImage> {
      const backends = await ensure();
      return backends[id].renderLayer(request);
    },
    async dispose() {
      if (real === undefined) return;
      await (await real)[id].dispose();
    },
  });
  const browser = make('browser', ['html'], HTML_CAPABILITIES, true, (n) => checkHtmlNode(n, { allowScripts: options.allowHtmlScripts === true }), {});
  const three = make('three', ['scene3d'], THREE_CAPABILITIES, false, (n) => toCheck(checkThreeNode(n)), { three: THREE_VERSION });
  const pixi = make('pixi', PIXI_NODE_TYPES, PIXI_CAPABILITIES, true, (n) => toCheck(checkPixiNode(n)), { 'pixi.js': PIXI_VERSION });
  return {
    browser,
    three,
    pixi,
    started: () => real !== undefined,
    gpuMode,
    prepareGraphics() {
      if (graphics !== undefined) return Promise.resolve(graphics);
      probing ??= (async () => {
        if (graphicsCache !== undefined && probeKey !== undefined) {
          const stored = parseGraphics(await readProbe(graphicsCache, probeKey));
          if (stored !== undefined) return stored;
        }
        const info = await (await ensure()).host.graphics();
        if (graphicsCache !== undefined && probeKey !== undefined) await writeProbe(graphicsCache, probeKey, info);
        return info;
      })().then(
        (info) => {
          graphics = info;
          return info;
        },
        (error: unknown) => {
          probing = undefined;
          throw error;
        },
      );
      return probing;
    },
    graphicsInfo: () => graphics,
    runtimeVersions: () => (started === undefined ? undefined : { ...started.host.versions() }),
    async dispose() {
      if (real === undefined) return;
      try {
        const r = await real;
        await Promise.all([r.browser.dispose(), r.three.dispose(), r.pixi.dispose()]);
      } catch (error) {
        if (!(error instanceof OpenVideoError)) throw error;
      }
    },
  };
}
