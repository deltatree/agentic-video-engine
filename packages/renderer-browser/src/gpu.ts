/**
 * GPU im Browser-Renderer (T5, ADR 0019) und gemeinsame GPU-Proben für `openvideo doctor`,
 * das Render-Manifest und die Telemetrie (Story 21.5).
 *
 * Standard ist SwiftShader (CPU): bitgleich auf jeder Maschine. `OPENVIDEO_BROWSER_GPU=1`
 * (Option `gpu`) startet Chromium mit nativem ANGLE auf der GPU des Hosts. GPU-Ergebnisse sind
 * nicht bitgleich zu SwiftShader; darum steht der Modus in den Versionen (Cache-Schlüssel) und im
 * Manifest.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, type Page } from 'playwright-core';
import { minimalChildEnv } from '@agentic-video/core';
import { probeWebGPU } from '@agentic-video/renderer-three';

/** Grafik-Modus von Chromium: `swiftshader` (CPU, Standard) oder `native` (ANGLE auf der Host-GPU). */
export type BrowserGpuMode = 'swiftshader' | 'native';

/**
 * Schalter für nativen ANGLE statt SwiftShader. `--use-angle=default` wählt das native Backend der
 * Plattform (Linux: OpenGL/EGL, mit NVIDIA-Treiber auch Vulkan), `--ignore-gpu-blocklist` erlaubt
 * Treiber, die Chromium sonst sperrt (z. B. in Containern ohne X). Die Rasterung von HTML bleibt auf
 * der CPU (`--disable-gpu-rasterization` aus `CHROMIUM_ARGS`).
 */
export const CHROMIUM_NATIVE_GPU_ARGS: readonly string[] = ['--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu'];

/** Umgebungsvariablen der GPU-Treiber, die Chromium im Modus `native` sehen muss (NVIDIA, Mesa, Vulkan). */
const GPU_ENV_PREFIXES: readonly string[] = ['NVIDIA_', 'CUDA_', '__NV_', '__GLX_', '__EGL_', 'VK_', 'MESA_', 'LIBGL_'];
const GPU_ENV_NAMES: readonly string[] = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'];

/**
 * Liest den Modus: Option `gpu` hat Vorrang, sonst `OPENVIDEO_BROWSER_GPU` (`1`/`true`/`native` →
 * `native`). Alles andere ergibt `swiftshader`.
 *
 * @example
 * ```ts
 * browserGpuMode(undefined, { OPENVIDEO_BROWSER_GPU: '1' }); // 'native'
 * browserGpuMode(false, { OPENVIDEO_BROWSER_GPU: '1' }); // 'swiftshader'
 * ```
 */
export function browserGpuMode(gpu?: boolean, env: Readonly<Record<string, string | undefined>> = process.env): BrowserGpuMode {
  if (gpu !== undefined) return gpu ? 'native' : 'swiftshader';
  const raw = env['OPENVIDEO_BROWSER_GPU']?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'native' ? 'native' : 'swiftshader';
}

/**
 * Ersetzt `--use-angle=swiftshader` im Modus `native` durch {@link CHROMIUM_NATIVE_GPU_ARGS}.
 *
 * @example
 * ```ts
 * chromiumArgsFor(['--use-angle=swiftshader', '--mute-audio'], 'native'); // ['--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio']
 * ```
 */
export function chromiumArgsFor(base: readonly string[], mode: BrowserGpuMode): string[] {
  if (mode === 'swiftshader') return [...base];
  return [...CHROMIUM_NATIVE_GPU_ARGS, ...base.filter((a) => !a.startsWith('--use-angle='))];
}

/**
 * Grafik-Schalter für WebGL/WebGPU-Layer je Modus. SwiftShader braucht `--enable-unsafe-swiftshader`;
 * im Modus `native` bleibt nur `--enable-unsafe-webgpu` (WebGPU ist unter Linux noch hinter dem Schalter).
 *
 * @example
 * ```ts
 * graphicsArgsFor('native'); // ['--enable-unsafe-webgpu']
 * ```
 */
export function graphicsArgsFor(mode: BrowserGpuMode): string[] {
  return mode === 'native' ? ['--enable-unsafe-webgpu'] : ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu'];
}

/**
 * Minimale Umgebung für Chromium (N1). Im Modus `native` kommen die Variablen der GPU-Treiber dazu
 * (`NVIDIA_*`, `VK_*`, `__EGL_*`, `DISPLAY` …), nie Tokens oder S3-Schlüssel.
 *
 * @example
 * ```ts
 * chromiumGpuEnv({ PATH: '/usr/bin', NVIDIA_VISIBLE_DEVICES: 'all', OPENVIDEO_WORKER_TOKEN: 'x' }, 'native'); // { PATH, NVIDIA_VISIBLE_DEVICES }
 * ```
 */
export function chromiumGpuEnv(source: Readonly<Record<string, string | undefined>>, mode: BrowserGpuMode): Record<string, string> {
  return mode === 'native' ? minimalChildEnv(source, { names: GPU_ENV_NAMES, prefixes: GPU_ENV_PREFIXES }) : minimalChildEnv(source);
}

/** Grafik-Fähigkeiten einer Chromium-Seite. */
export interface PageGraphics {
  /** `UNMASKED_RENDERER_WEBGL` oder `unavailable`. */
  readonly webgl2: string;
  /**
   * `MAX_TEXTURE_SIZE` von WebGL2 (0 ohne WebGL2). Hängt von der GPU ab (SwiftShader 8192, viele
   * GPUs 16384–32768) und bestimmt, ab wann `three` Texturen verkleinert (Review Q10). WebGPU nutzt
   * die Standardgrenzen des Geräts (`maxTextureDimension2D` 8192) und ist davon unabhängig.
   */
  readonly webgl2MaxTextureSize: number;
  /**
   * Beschreibung des WebGPU-Adapters, `no adapter`, `unavailable` oder `<adapter> (unusable: …)`,
   * wenn der Mini-Render auf dem Pfad von Three.js scheitert.
   */
  readonly webgpu: string;
  /** Gelingt der WebGPU-Mini-Render (`probeWebGPU`)? Genau diese Prüfung nutzt `three` bei `backend: 'auto'`. */
  readonly webgpuAvailable: boolean;
}

/** WebGL2-Teil von {@link PageGraphics}. */
export type PageWebGL2 = Pick<PageGraphics, 'webgl2' | 'webgl2MaxTextureSize'>;

/**
 * Läuft in der Seite (per `page.evaluate`): WebGL2-Renderer und `MAX_TEXTURE_SIZE`. Die Funktion
 * darf nichts von außen referenzieren, weil Playwright nur ihren Quelltext überträgt.
 *
 * @example
 * ```ts
 * const gl = await page.evaluate(pageWebGL2); // { webgl2: 'ANGLE (…)', webgl2MaxTextureSize: 8192 }
 * ```
 */
export function pageWebGL2(): PageWebGL2 {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const webgl2 = gl !== null && info !== null && info !== undefined ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : gl !== null ? 'WebGL2' : 'unavailable';
  const maxTexture: unknown = gl?.getParameter(gl.MAX_TEXTURE_SIZE);
  const webgl2MaxTextureSize = typeof maxTexture === 'number' ? maxTexture : 0;
  return { webgl2, webgl2MaxTextureSize };
}

/**
 * Grafik-Fähigkeiten einer geladenen Seite: WebGL2 ({@link pageWebGL2}) und WebGPU per Mini-Render
 * auf dem Pfad von Three.js (`probeWebGPU` aus `@agentic-video/renderer-three`, dieselbe Prüfung
 * wie `backend: 'auto'` im Renderer). Ein Adapter mit unvollständiger API zählt als nicht verfügbar.
 *
 * @example
 * ```ts
 * const info = await readPageGraphics(page); // { webgl2: 'ANGLE (…)', webgl2MaxTextureSize: 8192, webgpu: '…', webgpuAvailable: true }
 * ```
 */
export async function readPageGraphics(page: Pick<Page, 'evaluate'>): Promise<PageGraphics> {
  const gl = await page.evaluate(pageWebGL2);
  const gpu = await page.evaluate(probeWebGPU);
  return { ...gl, webgpu: gpu.adapter, webgpuAvailable: gpu.available };
}

/** Ergebnis von {@link probeBrowserGraphics}. */
export interface BrowserGraphicsProbe extends PageGraphics {
  /** Tatsächliche Version aus `browser.version()`. */
  readonly chromium: string;
  readonly mode: BrowserGpuMode;
}

/**
 * Startet Chromium mit denselben Schaltern wie der Render-Host (plus Grafik-Schalter) auf einer
 * statischen Probe-Seite unter einer HTTP-Origin und liest Version, WebGL2 und WebGPU. Genutzt von
 * `openvideo doctor`.
 *
 * @example
 * ```ts
 * const probe = await probeBrowserGraphics({ baseArgs: CHROMIUM_ARGS, mode: 'swiftshader' });
 * probe.webgpuAvailable; // false auf alten Chromium-Versionen
 * ```
 */
export async function probeBrowserGraphics(options: { readonly baseArgs: readonly string[]; readonly mode?: BrowserGpuMode; readonly executablePath?: string }): Promise<BrowserGraphicsProbe> {
  const mode = options.mode ?? browserGpuMode();
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>probe</title>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const fromEnv = process.env['OPENVIDEO_CHROMIUM'];
  const executablePath = options.executablePath ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : chromium.executablePath());
  try {
    const browser = await chromium.launch({
      executablePath,
      args: [...chromiumArgsFor(options.baseArgs, mode), ...graphicsArgsFor(mode)],
      env: chromiumGpuEnv(process.env, mode),
      ...(mode === 'native' ? { ignoreDefaultArgs: ['--enable-unsafe-swiftshader'] } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${String(port)}/`);
      const r = await readPageGraphics(page);
      return { chromium: browser.version(), mode, ...r };
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
}

/** Eine erkannte GPU des Hosts. */
export interface HostGpu {
  /** Z. B. `NVIDIA A10G` oder `DRM render node renderD128`. */
  readonly name: string;
  readonly source: 'nvidia-smi' | 'dri';
  readonly memoryTotalBytes?: number;
  readonly memoryUsedBytes?: number;
}

/** Werkzeuge der GPU-Probe (für Tests austauschbar). */
export interface HostGpuProbeTools {
  /** Führt ein Programm aus und liefert stdout; wirft, wenn es fehlt oder scheitert. */
  readonly run?: (command: string, args: readonly string[]) => Promise<string>;
  /** Einträge in `/dev/dri`. */
  readonly driNodes?: () => readonly string[];
}

const MIB = 1024 * 1024;

function defaultRun(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 5000, env: minimalChildEnv(process.env, { prefixes: ['NVIDIA_', 'CUDA_'] }) }, (error, stdout) => {
      if (error !== null) reject(error instanceof Error ? error : new Error(`${command} failed`));
      else resolve(stdout);
    });
  });
}

function defaultDriNodes(): readonly string[] {
  return existsSync('/dev/dri') ? readdirSync('/dev/dri') : [];
}

/**
 * Erkennt die GPU des Hosts: zuerst `nvidia-smi` (Name, Speicher gesamt und belegt), sonst
 * DRM-Render-Knoten unter `/dev/dri`. Ohne GPU `undefined`. Gemeinsam genutzt von `openvideo doctor`,
 * dem Render-Manifest (`gpu`) und der Metrik `gpu_memory`.
 *
 * @example
 * ```ts
 * const gpu = await probeHostGpu();
 * gpu?.name; // 'NVIDIA A10G'
 * ```
 */
export async function probeHostGpu(tools: HostGpuProbeTools = {}): Promise<HostGpu | undefined> {
  const run = tools.run ?? defaultRun;
  try {
    const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits']);
    const first = out.split('\n').map((l) => l.trim()).find((l) => l !== '');
    if (first !== undefined) {
      const [name = '', total = '', used = ''] = first.split(',').map((p) => p.trim());
      const totalMib = Number(total);
      const usedMib = Number(used);
      if (name !== '') {
        return {
          name,
          source: 'nvidia-smi',
          ...(total !== '' && Number.isFinite(totalMib) ? { memoryTotalBytes: totalMib * MIB } : {}),
          ...(used !== '' && Number.isFinite(usedMib) ? { memoryUsedBytes: usedMib * MIB } : {}),
        };
      }
    }
  } catch (error) {
    // Kein nvidia-smi oder kein Treiber: weiter mit /dev/dri.
    if (!(error instanceof Error)) throw error;
  }
  const dri = (tools.driNodes ?? defaultDriNodes)().filter((f) => f.startsWith('renderD'));
  if (dri.length > 0) return { name: `DRM render node ${dri.join(', ')}`, source: 'dri' };
  return undefined;
}

/**
 * Beschreibung einer GPU für Manifest und `doctor`, z. B. `NVIDIA A10G (23028 MiB)`.
 *
 * @example
 * ```ts
 * describeHostGpu({ name: 'NVIDIA A10G', source: 'nvidia-smi', memoryTotalBytes: 23028 * 1024 * 1024 }); // 'NVIDIA A10G (23028 MiB)'
 * ```
 */
export function describeHostGpu(gpu: HostGpu): string {
  return gpu.memoryTotalBytes !== undefined ? `${gpu.name} (${String(Math.round(gpu.memoryTotalBytes / MIB))} MiB)` : gpu.name;
}
