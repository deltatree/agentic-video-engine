/**
 * Verdrahtung der echten Pakete zu einer {@link RenderEnvironment} in Node.
 *
 * Browser (DOM, PixiJS, Three.js) und Blender starten erst, wenn ein Frame sie braucht.
 * So kostet ein reines 2D-Projekt keinen Browserstart.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { release, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectAssets, type ProjectAssets } from '@agentic-video/assets';
import { createCache, storeFromEnv, type Cache, type CacheTierName } from '@agentic-video/cache';
import { registerComponents } from '@agentic-video/components';
import { accumulateFrames, compositeFrame, parseCubeLut, type Lut } from '@agentic-video/compositor';
import { OUTPUT_FORMATS, OpenVideoError, Registry, VIDEO_CODECS, contentHash, isRecord, type RgbaImage } from '@agentic-video/core';
import { HARDWARE_FAMILIES, codecLicenses, createEncoder, probeCapabilities, type CustomCodec, type FfmpegCapabilities } from '@agentic-video/ffmpeg';
import { loadFontSet } from '@agentic-video/fonts';
import { createSkiaBackend, createSkiaTextMeasurer, loadCanvasKitNode, renderContactSheet, renderDebugOverlay } from '@agentic-video/renderer-skia';
import { createEspeakProvider, createPiperProvider, createWhisperCppProvider, registerSpeechProviders, resolveFromAudioTracks, synthesizeVoices, type FromAudioTranscript } from '@agentic-video/speech';
import { registerSubtitles } from '@agentic-video/subtitles';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';
import { browserGpuMode, createLazyBrowserBackends, describeHostGpu, probeHostGpu, type HostGpu } from '@agentic-video/renderer-browser';
import { createBlenderBackend } from '@agentic-video/renderer-blender';
import { createAudioEngine, type SynthesizedVoice } from './audio-engine.js';
import type { EncodeOptions, FrameEncoder, GraphicsInfoLike, MediaTools, RenderEnvironment, RuntimeInfo } from './environment.js';
import { OPENVIDEO_VERSION } from './version.js';
import { PLUGIN_PREFIX, exporterEncoder, loadProjectPlugins, pluginExporter, pluginPolicyFromEnv, type PluginPolicy } from './plugins.js';

/** Zusätzliche Backends, die ein Host bereitstellt (Browser, Blender), jeweils mit eigenem Aufräumen. */
export interface BackendProvider {
  readonly ids: readonly string[];
  register(registry: Registry, ctx: { readonly assets: ProjectAssets; readonly fonts: Awaited<ReturnType<typeof loadFontSet>>; readonly telemetry: Telemetry }): Promise<Readonly<Record<string, string>>>;
  /** Tatsächliche Versionen gestarteter Prozesse und Grafik-Probe (Story 21.5); optional. */
  runtime?(): { readonly versions: Readonly<Record<string, string>>; readonly graphics?: GraphicsInfoLike };
  dispose(): Promise<void>;
}

/** Optionen für {@link createNodeEnvironment}. */
export interface NodeEnvironmentOptions {
  readonly projectDir: string;
  readonly project: Readonly<Record<string, unknown>>;
  readonly cache?: Cache;
  readonly telemetry?: Telemetry;
  /** Vorhandenes Register (z. B. mit Plugins); Standard-Backends werden ergänzt. */
  readonly registry?: Registry;
  /** Host-Ausführung nicht vertrauenswürdigen Codes erlaubt (`--trusted`, ADR 0008). */
  readonly trusted?: boolean;
  /**
   * Skripte in HTML-Layern ausführen (ADR 0008). Standard `false`: Der Browser-Host sperrt
   * Skripte per iframe-Sandbox und CSP. Nur im Container oder mit `--trusted` setzen.
   */
  readonly allowHtmlScripts?: boolean;
  readonly offline?: boolean;
  readonly allowOutsidePaths?: boolean;
  /** Weitere Backends; Standard: Browser (träge) und Blender. */
  readonly providers?: readonly BackendProvider[];
  /** Standard-Backends für Browser und Blender weglassen (z. B. in Tests). */
  readonly skipDefaultProviders?: boolean;
  /** Ordner für erzeugte Stimmen (Standard `<projekt>/.openvideo/voices`). */
  readonly voicesDir?: string;
  /**
   * Plugins aus `settings.plugins` (Story 21.1, ADR 0012). Standard: laden nur mit `trusted` oder
   * `OPENVIDEO_ALLOW_PLUGINS=1`; Rechte nur aus `OPENVIDEO_PLUGIN_PERMISSIONS`.
   */
  readonly plugins?: PluginPolicy;
  /** Umgebungsvariablen (Standard `process.env`), z. B. für Plugin-Rechte. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Chromium mit nativem ANGLE auf der GPU starten statt SwiftShader (T5, ADR 0019). Standard:
   * `OPENVIDEO_BROWSER_GPU=1` aus `env`. Der Modus steht in den Versionen (Cache-Schlüssel) und im
   * Manifest. Worker-Prozesse lesen nur die Umgebungsvariable.
   */
  readonly browserGpu?: boolean;
  /** GPU-Probe ersetzen (Tests); Standard `probeHostGpu` (`nvidia-smi`, `/dev/dri`). */
  readonly probeGpu?: () => Promise<HostGpu | undefined>;
}

/** Umgebung mit Aufräumfunktion. */
export interface NodeEnvironment extends RenderEnvironment {
  /** Projektordner, für den die Umgebung gilt (z. B. für Worker-Prozesse). */
  readonly projectDir: string;
  dispose(): Promise<void>;
  readonly assetDiagnostics: ProjectAssets['diagnostics'];
}

function pick<T extends string>(values: readonly T[], value: string | undefined, what: string): T | undefined {
  if (value === undefined) return undefined;
  const hit = values.find((v) => v === value);
  if (hit === undefined) throw new OpenVideoError({ code: 'OV_RENDER_PROFILE', errorClass: 'RenderError', problem: `Unknown ${what} "${value}".`, suggestions: [`Use one of: ${values.join(', ')}.`] });
  return hit;
}

/** Codec `plugin:<id>` aus dem Register als FFmpeg-Codec (Story 21.1). */
function pluginCodec(registry: Registry, codec: string | undefined, quality: number, alpha: boolean): CustomCodec | undefined {
  if (codec === undefined || !codec.startsWith(PLUGIN_PREFIX)) return undefined;
  const id = codec.slice(PLUGIN_PREFIX.length);
  const def = registry.codecs.get(id);
  if (def === undefined) {
    throw new OpenVideoError({
      code: 'OV_RENDER_PROFILE',
      errorClass: 'RenderError',
      problem: `Codec "${codec}" is not registered by any loaded plugin.`,
      suggestions: [registry.codecs.size > 0 ? `Use one of: ${[...registry.codecs.keys()].map((k) => PLUGIN_PREFIX + k).join(', ')}.` : 'Add the plugin that provides it to settings.plugins.', `Or use a built-in codec: ${VIDEO_CODECS.join(', ')}.`],
    });
  }
  return { id, formats: def.formats, args: def.encoderArgs({ quality, alpha }) };
}

function mediaTools(registry: Registry): MediaTools {
  let caps: Promise<FfmpegCapabilities> | undefined;
  return {
    createEncoder(options: EncodeOptions): Promise<FrameEncoder> {
      // Exporter aus Plugins schreiben ein eigenes Ausgabeformat (`format: 'plugin:<id>'`).
      const exporter = pluginExporter(registry, options.format);
      if (exporter !== undefined) return Promise.resolve(exporterEncoder(exporter, options));
      const format = pick(OUTPUT_FORMATS, options.format, 'format') ?? 'mp4';
      const customCodec = pluginCodec(registry, options.codec, options.quality, options.alpha);
      const codec = customCodec === undefined ? pick(VIDEO_CODECS, options.codec, 'codec') : undefined;
      const hardware = options.hardware === 'auto' || options.hardware === 'none' ? options.hardware : pick(HARDWARE_FAMILIES, options.hardware, 'hardware encoder');
      const audioCodec = pick(['aac', 'opus', 'pcm'] as const, options.audioCodec, 'audio codec');
      const encoder = createEncoder({
        output: options.outPath,
        format,
        ...(codec !== undefined ? { codec } : {}),
        ...(customCodec !== undefined ? { customCodec } : {}),
        width: options.width,
        height: options.height,
        fps: options.fps,
        quality: options.quality,
        alpha: options.alpha,
        colorSpace: options.colorSpace,
        ...(options.threads !== undefined ? { threads: options.threads } : {}),
        ...(hardware !== undefined ? { hardware } : {}),
        ...(options.audioPath !== undefined ? { audioPath: options.audioPath } : {}),
        ...(audioCodec !== undefined ? { audioCodec } : {}),
        ...(options.audioBitrate !== undefined ? { audioBitrate: options.audioBitrate } : {}),
      });
      return Promise.resolve({
        write: (image: RgbaImage) => encoder.write(image),
        abort: () => encoder.abort(),
        finish: async () => {
          const r = await encoder.finish();
          return { outputs: r.paths, frames: r.frames, encoder: r.encoder, args: r.args };
        },
      });
    },
    async info() {
      caps ??= probeCapabilities();
      const c = await caps;
      return {
        version: c.version,
        license: c.license,
        configuration: c.configuration,
        codecLicenses: { ...Object.fromEntries(Object.entries(codecLicenses).map(([k, v]) => [k, v.license])), ...Object.fromEntries([...registry.codecs.values()].map((c) => [PLUGIN_PREFIX + c.id, c.license])) },
      };
    },
  };
}

function localPath(...parts: string[]): string | undefined {
  const p = join(homedir(), '.local', 'opt', ...parts);
  return existsSync(p) ? p : undefined;
}

/**
 * Registriert lokal verfügbare Sprach-Engines (Piper, espeak-ng, whisper.cpp).
 * Pfade kommen aus `OPENVIDEO_PIPER`, `OPENVIDEO_PIPER_MODEL`, `OPENVIDEO_ESPEAK`,
 * `OPENVIDEO_WHISPER`, `OPENVIDEO_WHISPER_MODEL` oder aus `~/.local/opt`.
 */
export async function registerLocalSpeech(registry: Registry, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ registered: string[]; skipped: string[] }> {
  const piperModel = env['OPENVIDEO_PIPER_MODEL'] ?? localPath('piper-voices', 'en_US-lessac-low.onnx');
  const piperBinary = env['OPENVIDEO_PIPER'] ?? localPath('piper-venv', 'bin', 'piper');
  const whisperModel = env['OPENVIDEO_WHISPER_MODEL'] ?? localPath('whisper.cpp', 'models', 'ggml-tiny.en.bin');
  const whisperBinary = env['OPENVIDEO_WHISPER'] ?? localPath('whisper.cpp', 'build', 'bin', 'whisper-cli');
  const espeak = env['OPENVIDEO_ESPEAK'] ?? localPath('espeak-ng', 'espeak-ng');
  return registerSpeechProviders(registry, {
    voice: [
      ...(piperModel !== undefined ? [createPiperProvider({ model: piperModel, ...(piperBinary !== undefined ? { binary: piperBinary } : {}) })] : []),
      createEspeakProvider(espeak !== undefined ? { binary: espeak } : {}),
    ],
    asr: whisperModel !== undefined ? [createWhisperCppProvider({ model: whisperModel, ...(whisperBinary !== undefined ? { binary: whisperBinary } : {}) })] : [],
  });
}

/** Größte Composition eines Projekts (für die Seitengröße des Browsers). */
function largestComposition(project: Readonly<Record<string, unknown>>): { width: number; height: number } {
  const comps = Array.isArray(project['compositions']) ? project['compositions'].filter(isRecord) : [];
  return comps.reduce<{ width: number; height: number }>((acc, c) => ({ width: Math.max(acc.width, Number(c['width']) || 0), height: Math.max(acc.height, Number(c['height']) || 0) }), { width: 1, height: 1 });
}

/** Enthält das Projekt eine `scene3d`-Node (in irgendeiner Composition)? */
export function projectUsesScene3d(project: Readonly<Record<string, unknown>>): boolean {
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk);
    if (!isRecord(value)) return false;
    if (value['type'] === 'scene3d') return true;
    return walk(value['children']) || walk(value['nodes']);
  };
  return walk(project['compositions']);
}

/**
 * Standard-Provider: Browser-Backends (`browser`, `three`, `pixi`, Chromium startet erst bei Bedarf)
 * und Blender (startet pro Chunk einen Prozess, nur wenn eine `blender`-Node gerendert wird).
 *
 * Enthält das Projekt `scene3d`-Nodes, startet Chromium schon beim Registrieren mit den
 * Grafik-Schaltern und prüft WebGPU (Story 21.5): Ob `backend: 'auto'` WebGPU oder WebGL2 nutzt,
 * steht dann als `three-webgpu` in den Versionen und damit in jedem Frame- und Layer-Schlüssel.
 */
export function defaultProviders(projectDir: string, project: Readonly<Record<string, unknown>>, options: { readonly allowHtmlScripts?: boolean; readonly browserGpu?: boolean } = {}): BackendProvider[] {
  let lazy: ReturnType<typeof createLazyBrowserBackends> | undefined;
  let blender: ReturnType<typeof createBlenderBackend> | undefined;
  return [
    {
      ids: ['browser', 'three', 'pixi'],
      async register(registry, ctx) {
        const size = largestComposition(project);
        const created = createLazyBrowserBackends({
          assets: ctx.assets,
          fonts: ctx.fonts,
          width: size.width,
          height: size.height,
          allowHtmlScripts: options.allowHtmlScripts === true,
          ...(options.browserGpu !== undefined ? { gpu: options.browserGpu } : {}),
          ...(process.env['OPENVIDEO_CHROMIUM'] !== undefined ? { executablePath: process.env['OPENVIDEO_CHROMIUM'] } : {}),
        });
        lazy = created;
        for (const b of [created.browser, created.three, created.pixi]) if (!registry.backends.has(b.id)) registry.registerBackend(b);
        if (projectUsesScene3d(project)) {
          try {
            await created.prepareGraphics();
          } catch (error) {
            // Ohne Chromium scheitert erst der Render des 3D-Layers mit seiner eigenen Diagnose.
            if (!(error instanceof OpenVideoError)) throw error;
            ctx.telemetry.logger.warn('browser graphics probe failed', { code: error.diagnostic.code, problem: error.diagnostic.problem });
          }
        }
        return { chromium: created.browser.versions()['chromium'] ?? 'unknown' };
      },
      runtime() {
        const versions = lazy?.runtimeVersions();
        const graphics = lazy?.graphicsInfo();
        return { versions: versions !== undefined && versions['chromium'] !== undefined ? { chromium: versions['chromium'] } : {}, ...(graphics !== undefined ? { graphics } : {}) };
      },
      async dispose() {
        await lazy?.dispose();
      },
    },
    {
      ids: ['blender'],
      register(registry) {
        blender = createBlenderBackend({ workDir: join(projectDir, '.openvideo', 'blender') });
        if (!registry.backends.has('blender')) registry.registerBackend(blender);
        return Promise.resolve({});
      },
      async dispose() {
        await blender?.dispose();
      },
    },
  ];
}

/**
 * Die `fromAudio`-Deklarationen eines Projekts (Composition, Track, Quelle, Provider, Sprache) –
 * ändern sie sich, werden die Transkripte neu aufgelöst (Review Q3).
 *
 * @example
 * ```ts
 * fromAudioDeclarations(project); // [{ composition: 'main', track: 'subs', fromAudio: { source: 'vo' }, language: 'en' }]
 * ```
 */
export function fromAudioDeclarations(project: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const comps = Array.isArray(project['compositions']) ? project['compositions'].filter(isRecord) : [];
  for (const c of comps) {
    const tracks = Array.isArray(c['tracks']) ? c['tracks'].filter(isRecord) : [];
    for (const t of tracks) {
      if (t['kind'] !== 'subtitle' || !isRecord(t['fromAudio']) || t['cues'] !== undefined || t['asset'] !== undefined) continue;
      out.push({ composition: c['id'], track: t['id'], fromAudio: t['fromAudio'], language: t['language'] ?? null });
    }
  }
  return out;
}

/** Beobachtete Paare aus Cache und Telemetrie: jeder Zugriff wird nur einmal gezählt. */
const observedCaches = new WeakMap<Cache, WeakSet<Telemetry>>();

/**
 * Ebenen, deren Treffer `frame.ts` selbst meldet (inklusive Treffern im Arbeitsspeicher); der
 * Beobachter zählt sie nicht doppelt.
 */
const SELF_REPORTED_TIERS: ReadonlySet<CacheTierName> = new Set(['frame', 'layer']);

/**
 * Meldet Treffer und Fehlgriffe aller Cache-Ebenen an die Telemetrie (Story 21.2, Metriken
 * `cache_hits`/`cache_misses` mit Attribut `tier`). Pro Cache und Telemetrie nur einmal.
 *
 * @example
 * ```ts
 * observeCacheTelemetry(cache, telemetry);
 * ```
 */
export function observeCacheTelemetry(cache: Cache, telemetry: Telemetry): void {
  let seen = observedCaches.get(cache);
  if (seen === undefined) {
    seen = new WeakSet();
    observedCaches.set(cache, seen);
  }
  if (seen.has(telemetry)) return;
  seen.add(telemetry);
  cache.observe((tier, outcome) => {
    if (SELF_REPORTED_TIERS.has(tier)) return;
    if (outcome === 'hit') telemetry.metrics.cacheHit(tier);
    else telemetry.metrics.cacheMiss(tier);
  });
}

/** Einmalige GPU-Probe je Prozess (Name und Gesamtspeicher ändern sich nicht). */
let hostGpu: Promise<HostGpu | undefined> | undefined;

/**
 * Baut die Render-Umgebung eines Projekts.
 *
 * @example
 * ```ts
 * const env = await createNodeEnvironment({ projectDir: '.', project });
 * try { await renderFrame(env, project, { frame: 0 }); } finally { await env.dispose(); }
 * ```
 */
export async function createNodeEnvironment(options: NodeEnvironmentOptions): Promise<NodeEnvironment> {
  const { projectDir, project } = options;
  const telemetry = options.telemetry ?? createTelemetry({ serviceName: 'openvideo', exporter: 'none' });
  const cache = options.cache ?? createCache(storeFromEnv(process.env, projectDir));
  observeCacheTelemetry(cache, telemetry);
  const registry = options.registry ?? new Registry();
  // Plugins vor den Assets: Asset Loader aus Plugins gelten schon beim Auflösen (Story 21.1).
  const env = options.env ?? process.env;
  await loadProjectPlugins(registry, { projectDir, project, env, policy: options.plugins ?? pluginPolicyFromEnv(env, options.trusted === true), ...(options.allowOutsidePaths !== undefined ? { allowOutsidePaths: options.allowOutsidePaths } : {}) });
  const assets = await resolveProjectAssets(projectDir, project, {
    cache,
    ...(registry.assetLoaders.size > 0 ? { loaders: [...registry.assetLoaders.values()] } : {}),
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
    ...(options.allowOutsidePaths !== undefined ? { allowOutsidePaths: options.allowOutsidePaths } : {}),
  });
  const fonts = await loadFontSet({
    projectDir,
    ...(Array.isArray(project['fonts']) ? { fonts: project['fonts'].filter(isRecord).map((f) => ({ family: String(f['family']), ...(typeof f['src'] === 'string' ? { src: f['src'] } : {}), ...(typeof f['asset'] === 'string' ? { asset: f['asset'] } : {}), ...(typeof f['faceIndex'] === 'number' ? { faceIndex: f['faceIndex'] } : {}) })) } : {}),
    resolveAsset: async (id) => {
      const a = assets.get(id);
      if (a === undefined) throw new OpenVideoError({ code: 'OV_ASSET_MISSING', errorClass: 'FontError', problem: `Font asset "${id}" is not available.`, suggestions: ['Declare the font file in project.assets.'] });
      return { path: a.path, bytes: await assets.bytes(id) };
    },
  });
  const settings = isRecord(project['settings']) ? project['settings'] : {};
  const defaultFont = typeof settings['defaultFont'] === 'string' ? settings['defaultFont'] : undefined;
  const canvasKit = await loadCanvasKitNode();
  const versions: Record<string, string> = { openvideo: OPENVIDEO_VERSION, compositor: 'openvideo-compositor-3' };
  if (!registry.backends.has('skia')) registry.registerBackend(createSkiaBackend({ canvasKit, fonts, ...(defaultFont !== undefined ? { defaultFont } : {}) }));
  if (registry.components.size === 0) registerComponents(registry);
  if (registry.voiceProviders.size === 0) await registerLocalSpeech(registry);
  const measurer = createSkiaTextMeasurer(canvasKit, fonts, defaultFont);
  // Transkripte der fromAudio-Tracks: erst bei `prepare`, je Stand der Deklarationen (Review Q3).
  const transcripts: { current: ReadonlyMap<string, FromAudioTranscript>; key: string | undefined; readonly pending: Map<string, Promise<void>> } = { current: new Map(), key: undefined, pending: new Map() };
  if (!registry.expanders.has('subtitles')) {
    const texts = new Map<string, string>();
    for (const a of assets.all()) if (a.type === 'subtitle') texts.set(a.id, await readFile(a.path, 'utf8'));
    registerSubtitles(registry, {
      loadTrackText: (id) => texts.get(id),
      // fromAudio-Tracks transkribiert `prepare` vor dem Render (Cache je Audio-Hash, Story 17.8, Review Q3).
      transcript: (compositionId, trackId) => transcripts.current.get(`${compositionId}/${trackId}`),
      // Umbruch mit echter Textmessung statt geschätzter Zeichenbreite.
      measureText: (text, style) =>
        measurer.measure({ id: '__subtitle-measure', type: 'text', props: { text, ...style }, children: [], time: { localFrame: 0, relFrame: 0, durationFrames: 1, progress: 0, compositionFrame: 0 }, pointer: '' }).width,
    });
  }
  const gpuMode = browserGpuMode(options.browserGpu, env);
  const prepare = async (p: Readonly<Record<string, unknown>>): Promise<void> => {
    const declarations = fromAudioDeclarations(p);
    if (declarations.length === 0) return;
    const key = contentHash(declarations);
    if (transcripts.key === key) return;
    let job = transcripts.pending.get(key);
    if (job === undefined) {
      job = resolveFromAudioTracks(p, { registry, assets, cache }).then((map) => {
        transcripts.current = map;
        transcripts.key = key;
      });
      transcripts.pending.set(key, job);
    }
    try {
      await job;
    } finally {
      transcripts.pending.delete(key);
    }
  };
  const providers: BackendProvider[] = [...(options.providers ?? [])];
  if (options.skipDefaultProviders !== true) providers.push(...defaultProviders(projectDir, project, { allowHtmlScripts: options.allowHtmlScripts === true, browserGpu: gpuMode === 'native' }));
  for (const provider of providers) Object.assign(versions, await provider.register(registry, { assets, fonts, telemetry }));
  for (const b of registry.backends.values()) {
    versions[`backend:${b.id}`] = Object.values(b.versions()).join('+') || '1';
    Object.assign(versions, b.versions());
  }
  const media = mediaTools(registry);
  for (const p of registry.plugins) versions[`plugin:${p.name}`] = p.version;
  try {
    versions['ffmpeg'] = (await media.info()).version;
  } catch (error) {
    if (!(error instanceof OpenVideoError)) throw error;
  }
  const luts = new Map<string, Lut>();
  for (const a of assets.all()) if (a.type === 'lut') luts.set(a.id, parseCubeLut(await readFile(a.path, 'utf8')));
  const voicesDir = options.voicesDir ?? join(projectDir, '.openvideo', 'voices');
  // Stimmen je Projekt-Objekt: das Manifest nennt ihre Hashes (Story 21.5).
  const voicesOf = new WeakMap<Readonly<Record<string, unknown>>, ReadonlyMap<string, SynthesizedVoice>>();
  const synthesize = async (p: Readonly<Record<string, unknown>>): Promise<ReadonlyMap<string, SynthesizedVoice>> => {
    const result = await synthesizeVoices(p, { registry, cache, outDir: voicesDir });
    const voices = new Map(result.map((v) => [v.id, { path: v.path, duration: v.duration, hash: v.cacheKey }]));
    voicesOf.set(p, voices);
    return voices;
  };
  const audioEngine = createAudioEngine({ assets, cache, synthesizeVoices: synthesize, registry });
  const probeGpu = options.probeGpu ?? (() => (hostGpu ??= probeHostGpu()));
  const gpu = await probeGpu();
  if (gpu?.memoryUsedBytes !== undefined) telemetry.metrics.setGpuMemory(gpu.memoryUsedBytes);
  const runtime = async (): Promise<RuntimeInfo> => {
    const out: Record<string, string> = {};
    let graphics: GraphicsInfoLike | undefined;
    for (const p of providers) {
      const r = p.runtime?.();
      if (r === undefined) continue;
      Object.assign(out, r.versions);
      graphics ??= r.graphics;
    }
    // Belegter Speicher ändert sich: bei jedem Aufruf neu lesen (nur mit erkannter NVIDIA-GPU).
    const now = gpu?.source === 'nvidia-smi' ? await (options.probeGpu ?? probeHostGpu)() : undefined;
    const used = now?.memoryUsedBytes ?? gpu?.memoryUsedBytes;
    if (used !== undefined) telemetry.metrics.setGpuMemory(used);
    return { versions: out, ...(used !== undefined ? { gpuMemoryBytes: used } : {}), ...(graphics !== undefined ? { graphics } : {}) };
  };
  return {
    projectDir,
    registry,
    assets,
    fonts,
    cache,
    telemetry,
    measurer,
    assetDiagnostics: assets.diagnostics,
    overlays: {
      debugOverlay: (scene, bounds, debug, size) => renderDebugOverlay(canvasKit, fonts, scene, bounds, debug, size),
      contactSheet: (frames, o) => renderContactSheet(canvasKit, fonts, frames, o),
    },
    media,
    audio: {
      async renderComposition(input) {
        const r = await audioEngine.renderComposition(input);
        const voices = voicesOf.get(input.project);
        if (r === undefined || voices === undefined || voices.size === 0) return r;
        return { ...r, voices: Object.fromEntries([...voices].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => [id, v.hash])) };
      },
    },
    composite: (request) => {
      // LUTs kommen immer aus den Assets dieses Projekts, nicht aus der Anfrage.
      const { resolveLut: _fromRequest, ...rest } = request;
      return compositeFrame({ ...rest, resolveLut: (id: string) => luts.get(id) });
    },
    accumulate: (images) => accumulateFrames(images),
    resolveLut: (id) => luts.get(id),
    versions,
    trusted: options.trusted === true,
    platform: {
      os: `${process.platform} ${release()} ${process.arch}`,
      ...(process.env['OPENVIDEO_CONTAINER_IMAGE'] !== undefined ? { containerImage: process.env['OPENVIDEO_CONTAINER_IMAGE'] } : {}),
      ...(gpu !== undefined ? { gpu: describeHostGpu(gpu) } : {}),
      browserGpu: gpuMode,
    },
    runtime,
    prepare,
    async dispose() {
      measurer.dispose();
      await assets.close();
      for (const provider of providers) await provider.dispose();
      for (const b of registry.backends.values()) if (!providers.some((p) => p.ids.includes(b.id))) await b.dispose();
    },
  };
}
