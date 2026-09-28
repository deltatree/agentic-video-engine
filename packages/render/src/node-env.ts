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
import { createCache, storeFromEnv, type Cache } from '@agentic-video/cache';
import { registerComponents } from '@agentic-video/components';
import { accumulateFrames, compositeFrame, parseCubeLut, type Lut } from '@agentic-video/compositor';
import { OUTPUT_FORMATS, OpenVideoError, Registry, VIDEO_CODECS, isRecord, type RgbaImage } from '@agentic-video/core';
import { HARDWARE_FAMILIES, codecLicenses, createEncoder, probeCapabilities, type FfmpegCapabilities } from '@agentic-video/ffmpeg';
import { loadFontSet } from '@agentic-video/fonts';
import { createSkiaBackend, createSkiaTextMeasurer, loadCanvasKitNode, renderContactSheet, renderDebugOverlay } from '@agentic-video/renderer-skia';
import { createEspeakProvider, createPiperProvider, createWhisperCppProvider, registerSpeechProviders, synthesizeVoices } from '@agentic-video/speech';
import { registerSubtitles } from '@agentic-video/subtitles';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';
import { createAudioEngine, type SynthesizedVoice } from './audio-engine.js';
import type { EncodeOptions, FrameEncoder, MediaTools, RenderEnvironment } from './environment.js';
import { OPENVIDEO_VERSION } from './version.js';

/** Zusätzliche Backends, die ein Host bereitstellt (Browser, Blender), jeweils mit eigenem Aufräumen. */
export interface BackendProvider {
  readonly ids: readonly string[];
  register(registry: Registry, ctx: { readonly assets: ProjectAssets; readonly fonts: Awaited<ReturnType<typeof loadFontSet>>; readonly telemetry: Telemetry }): Promise<Readonly<Record<string, string>>>;
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
  readonly offline?: boolean;
  readonly allowOutsidePaths?: boolean;
  /** Weitere Backends (Browser, Blender). */
  readonly providers?: readonly BackendProvider[];
  /** Ordner für erzeugte Stimmen (Standard `<projekt>/.openvideo/voices`). */
  readonly voicesDir?: string;
}

/** Umgebung mit Aufräumfunktion. */
export interface NodeEnvironment extends RenderEnvironment {
  dispose(): Promise<void>;
  readonly assetDiagnostics: ProjectAssets['diagnostics'];
}

function pick<T extends string>(values: readonly T[], value: string | undefined, what: string): T | undefined {
  if (value === undefined) return undefined;
  const hit = values.find((v) => v === value);
  if (hit === undefined) throw new OpenVideoError({ code: 'OV_RENDER_PROFILE', errorClass: 'RenderError', problem: `Unknown ${what} "${value}".`, suggestions: [`Use one of: ${values.join(', ')}.`] });
  return hit;
}

function mediaTools(): MediaTools {
  let caps: Promise<FfmpegCapabilities> | undefined;
  return {
    createEncoder(options: EncodeOptions): Promise<FrameEncoder> {
      const format = pick(OUTPUT_FORMATS, options.format, 'format') ?? 'mp4';
      const codec = pick(VIDEO_CODECS, options.codec, 'codec');
      const hardware = options.hardware === 'auto' || options.hardware === 'none' ? options.hardware : pick(HARDWARE_FAMILIES, options.hardware, 'hardware encoder');
      const audioCodec = pick(['aac', 'opus', 'pcm'] as const, options.audioCodec, 'audio codec');
      const encoder = createEncoder({
        output: options.outPath,
        format,
        ...(codec !== undefined ? { codec } : {}),
        width: options.width,
        height: options.height,
        fps: options.fps,
        quality: options.quality,
        alpha: options.alpha,
        colorSpace: options.colorSpace,
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
        codecLicenses: Object.fromEntries(Object.entries(codecLicenses).map(([k, v]) => [k, v.license])),
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
  const registry = options.registry ?? new Registry();
  const assets = await resolveProjectAssets(projectDir, project, {
    cache,
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
    ...(options.allowOutsidePaths !== undefined ? { allowOutsidePaths: options.allowOutsidePaths } : {}),
  });
  const fonts = await loadFontSet({
    projectDir,
    ...(Array.isArray(project['fonts']) ? { fonts: project['fonts'].filter(isRecord).map((f) => ({ family: String(f['family']), ...(typeof f['src'] === 'string' ? { src: f['src'] } : {}), ...(typeof f['asset'] === 'string' ? { asset: f['asset'] } : {}) })) } : {}),
    resolveAsset: async (id) => {
      const a = assets.get(id);
      if (a === undefined) throw new OpenVideoError({ code: 'OV_ASSET_MISSING', errorClass: 'FontError', problem: `Font asset "${id}" is not available.`, suggestions: ['Declare the font file in project.assets.'] });
      return { path: a.path, bytes: await assets.bytes(id) };
    },
  });
  const settings = isRecord(project['settings']) ? project['settings'] : {};
  const defaultFont = typeof settings['defaultFont'] === 'string' ? settings['defaultFont'] : undefined;
  const canvasKit = await loadCanvasKitNode();
  const versions: Record<string, string> = { openvideo: OPENVIDEO_VERSION, compositor: 'openvideo-compositor-1' };
  if (!registry.backends.has('skia')) registry.registerBackend(createSkiaBackend({ canvasKit, fonts, ...(defaultFont !== undefined ? { defaultFont } : {}) }));
  if (registry.components.size === 0) registerComponents(registry);
  if (!registry.expanders.has('subtitles')) {
    const texts = new Map<string, string>();
    for (const a of assets.all()) if (a.type === 'subtitle') texts.set(a.id, await readFile(a.path, 'utf8'));
    registerSubtitles(registry, { loadTrackText: (id) => texts.get(id) });
  }
  if (registry.voiceProviders.size === 0) await registerLocalSpeech(registry);
  for (const provider of options.providers ?? []) Object.assign(versions, await provider.register(registry, { assets, fonts, telemetry }));
  for (const b of registry.backends.values()) {
    versions[`backend:${b.id}`] = Object.values(b.versions()).join('+') || '1';
    Object.assign(versions, b.versions());
  }
  const measurer = createSkiaTextMeasurer(canvasKit, fonts, defaultFont);
  const media = mediaTools();
  try {
    versions['ffmpeg'] = (await media.info()).version;
  } catch (error) {
    if (!(error instanceof OpenVideoError)) throw error;
  }
  const luts = new Map<string, Lut>();
  for (const a of assets.all()) if (a.type === 'lut') luts.set(a.id, parseCubeLut(await readFile(a.path, 'utf8')));
  const voicesDir = options.voicesDir ?? join(projectDir, '.openvideo', 'voices');
  const synthesize = async (p: Readonly<Record<string, unknown>>): Promise<ReadonlyMap<string, SynthesizedVoice>> => {
    const result = await synthesizeVoices(p, { registry, cache, outDir: voicesDir });
    return new Map(result.map((v) => [v.id, { path: v.path, duration: v.duration, hash: v.cacheKey }]));
  };
  return {
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
    audio: createAudioEngine({ assets, cache, synthesizeVoices: synthesize }),
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
    },
    async dispose() {
      measurer.dispose();
      await assets.close();
      for (const provider of options.providers ?? []) await provider.dispose();
      for (const b of registry.backends.values()) await b.dispose();
    },
  };
}
