/**
 * Video-Render (FR-60..FR-69): Validierung → Frame-Schlüssel → fehlende Frames rendern →
 * Audio → Encoding → Render-Manifest. Frames liegen im Frame-Cache; nur Geändertes wird neu gerendert.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { OpenVideoError, contentHash, evaluateScene, findComposition, compositionDurationFrames, frameKey, isRecord, type Diagnostic, type RgbaImage } from '@agentic-video/core';
import { decodeRawFrame } from '@agentic-video/png';
import type { RenderEnvironment } from './environment.js';
import { assetHashes, outputSize, renderFrame } from './frame.js';
import { chunkHash, countDiagnostics, imageHash, versionOr, type RenderManifest } from './manifest.js';
import { OPENVIDEO_VERSION } from './version.js';

/** Ausgabe-Einstellungen (entspricht einem IR-`renderProfile`). */
export interface OutputProfile {
  readonly format: string;
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly quality?: number;
  readonly alpha?: boolean;
  readonly colorSpace?: 'srgb' | 'rec709' | 'linear';
  readonly audioCodec?: string;
  readonly audioBitrate?: number;
  readonly hardwareAcceleration?: string;
}

/** Ergebnis eines Chunks: Pixel-Hashes und Frame-Schlüssel. */
export interface ChunkResult {
  readonly start: number;
  readonly end: number;
  readonly frameHashes: readonly string[];
  readonly keys: readonly string[];
  readonly rendered: number;
  readonly fromCache: number;
  readonly worker?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Ein Chunk-Auftrag in Ausgabe-Frames. */
export interface ChunkRequest {
  readonly compositionId: string;
  readonly start: number;
  readonly end: number;
  readonly scale: number;
  /** Composition-Frames je Ausgabe-Frame (fps-Umrechnung). */
  readonly step: number;
  readonly offset: number;
}

/** Rendert Chunks; Standard ist lokal im selben Prozess, der Scheduler ersetzt ihn für Parallelität. */
export type ChunkRunner = (chunks: readonly ChunkRequest[], onChunkDone: (result: ChunkResult) => void) => Promise<readonly ChunkResult[]>;

/** Optionen für {@link renderVideo}. */
export interface RenderVideoOptions {
  readonly compositionId?: string;
  readonly outPath: string;
  readonly profile: OutputProfile;
  /** Bereich in Composition-Frames `[start, end)`. */
  readonly range?: { readonly start: number; readonly end: number };
  readonly chunkSize?: number;
  readonly runChunks?: ChunkRunner;
  readonly onProgress?: (progress: { readonly stage: string; readonly done: number; readonly total: number }) => void;
  readonly signal?: { readonly aborted: boolean };
  /** Audio weglassen. */
  readonly noAudio?: boolean;
}

/** Ergebnis von {@link renderVideo}. */
export interface RenderVideoResult {
  readonly outputs: readonly string[];
  readonly manifestPath: string;
  readonly manifest: RenderManifest;
  readonly diagnostics: readonly Diagnostic[];
}

/** Rechnet Profil und Composition in Ausgabegröße, Skalierung und Zeitschritt um. */
export function resolveOutput(comp: Readonly<Record<string, unknown>>, profile: OutputProfile): { width: number; height: number; scale: number; fps: number; step: number } {
  const cw = Number(comp['width']);
  const ch = Number(comp['height']);
  const cfps = Number(comp['fps']);
  const width = profile.width ?? (profile.height !== undefined ? Math.round((profile.height * cw) / ch) : cw);
  const height = profile.height ?? Math.round((width * ch) / cw);
  const scale = width / cw;
  if (Math.abs(height - ch * scale) > 1) {
    throw new OpenVideoError({
      code: 'OV_RENDER_ASPECT',
      errorClass: 'RenderError',
      problem: `Output ${String(width)}×${String(height)} does not match the composition aspect ratio ${String(cw)}:${String(ch)}.`,
      suggestions: [`Use ${String(width)}×${String(Math.round(width * (ch / cw)))}, or change the composition size.`],
    });
  }
  const fps = profile.fps ?? cfps;
  return { width, height, scale, fps, step: cfps / fps };
}

/**
 * Rendert einen Chunk lokal: fehlende Frames werden gerendert, vorhandene kommen aus dem Cache.
 *
 * @example
 * ```ts
 * const result = await renderChunk(env, project, { compositionId: 'main', start: 0, end: 30, scale: 1, step: 1, offset: 0 });
 * ```
 */
export async function renderChunk(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, chunk: ChunkRequest, signal?: { readonly aborted: boolean }): Promise<ChunkResult> {
  const hashes: string[] = [];
  const keys: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let rendered = 0;
  let fromCache = 0;
  for (let i = chunk.start; i < chunk.end; i++) {
    if (signal?.aborted === true) throw new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] });
    const frame = chunk.offset + i * chunk.step;
    const result = await renderFrame(env, project, { compositionId: chunk.compositionId, frame, scale: chunk.scale, ...(signal !== undefined ? { signal } : {}) });
    hashes.push(imageHash(result.image));
    keys.push(result.key);
    if (result.cached) fromCache++;
    else rendered++;
    for (const d of result.diagnostics) if (d.severity !== 'info') diagnostics.push(d);
  }
  return { start: chunk.start, end: chunk.end, frameHashes: hashes, keys, rendered, fromCache, diagnostics };
}

/** Teilt `[0, count)` in Chunks. */
export function splitChunks(count: number, size: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let s = 0; s < count; s += size) out.push({ start: s, end: Math.min(count, s + size) });
  return out;
}

async function fileHash(path: string): Promise<{ hash: string; bytes: number }> {
  const data = await readFile(path);
  return { hash: `sha256:${createHash('sha256').update(data).digest('hex')}`, bytes: (await stat(path)).size };
}

function packageVersionsOf(versions: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(versions).filter(([k]) => !k.startsWith('backend:')));
}

/**
 * Rendert eine Composition zu einer Videodatei und schreibt `render-manifest.json` daneben.
 *
 * @example
 * ```ts
 * const r = await renderVideo(env, project, { outPath: 'out/hero.mp4', profile: { format: 'mp4', codec: 'h264' } });
 * console.log(r.manifest.frameHashes.length);
 * ```
 */
export async function renderVideo(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, options: RenderVideoOptions): Promise<RenderVideoResult> {
  const stages: Record<string, number> = {};
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await env.telemetry.withSpan(`render.${name}`, {}, fn);
    } finally {
      stages[name] = (stages[name] ?? 0) + (performance.now() - start) / 1000;
    }
  };
  const media = env.media;
  if (media === undefined) {
    throw new OpenVideoError({ code: 'OV_FFMPEG_MISSING', errorClass: 'RenderError', problem: 'Video encoding needs FFmpeg, which is not available.', suggestions: ['Install FFmpeg and run `openvideo doctor`.'] });
  }
  const comp = findComposition(project, options.compositionId);
  const compositionId = String(comp['id']);
  const out = resolveOutput(comp, options.profile);
  const durationFrames = compositionDurationFrames(comp);
  const range = options.range ?? { start: 0, end: durationFrames };
  const outCount = Math.max(1, Math.round((range.end - range.start) / out.step));
  const chunkSize = options.chunkSize ?? Math.max(1, Math.round(out.fps * 2));
  const chunks: ChunkRequest[] = splitChunks(outCount, chunkSize).map((c) => ({ compositionId, start: c.start, end: c.end, scale: out.scale, step: out.step, offset: range.start }));
  const total = outCount;
  let done = 0;
  const runner: ChunkRunner =
    options.runChunks ??
    (async (list, onDone) => {
      const results: ChunkResult[] = [];
      for (const c of list) {
        const r = await renderChunk(env, project, c, options.signal);
        onDone(r);
        results.push(r);
      }
      return results;
    });
  const renderStart = performance.now();
  const results = await stage('renderFrames', () =>
    runner(chunks, (r) => {
      done += r.end - r.start;
      options.onProgress?.({ stage: 'render', done, total });
    }),
  );
  const ordered = [...results].sort((a, b) => a.start - b.start);
  const keys = ordered.flatMap((r) => [...r.keys]);
  const frameHashes = ordered.flatMap((r) => [...r.frameHashes]);
  const diagnostics = ordered.flatMap((r) => [...r.diagnostics]);
  if (keys.length !== outCount) {
    throw new OpenVideoError({ code: 'OV_RENDER_INCOMPLETE', errorClass: 'RenderError', problem: `Expected ${String(outCount)} frames but got ${String(keys.length)}.`, suggestions: ['Retry the failed chunks with `render.status`.'] });
  }

  await mkdir(dirname(options.outPath), { recursive: true });
  let audio: { path: string; durationSeconds: number; loudness?: number } | undefined;
  if (options.noAudio !== true && env.audio !== undefined && options.profile.format !== 'gif' && !options.profile.format.endsWith('-sequence') && options.profile.format !== 'webp') {
    const audioEngine = env.audio;
    audio = await stage('audioPipeline', () => audioEngine.renderComposition({ project, composition: comp, startFrame: range.start, endFrame: range.end, outPath: join(dirname(options.outPath), `${basename(options.outPath)}.audio.wav`) }));
  }

  const encodeStart = performance.now();
  const encoded = await stage('ffmpeg', async () => {
    const encoder = await media.createEncoder({
      outPath: options.outPath,
      format: options.profile.format,
      ...(options.profile.codec !== undefined ? { codec: options.profile.codec } : {}),
      width: out.width,
      height: out.height,
      fps: out.fps,
      alpha: options.profile.alpha === true,
      quality: options.profile.quality ?? 80,
      hardware: options.profile.hardwareAcceleration ?? 'auto',
      colorSpace: options.profile.colorSpace ?? 'srgb',
      ...(audio !== undefined ? { audioPath: audio.path } : {}),
      ...(options.profile.audioCodec !== undefined ? { audioCodec: options.profile.audioCodec } : {}),
      ...(options.profile.audioBitrate !== undefined ? { audioBitrate: options.profile.audioBitrate } : {}),
    });
    try {
      let written = 0;
      for (const key of keys) {
        const bytes = await env.cache.tier('frame').get(key);
        if (bytes === undefined) {
          throw new OpenVideoError({ code: 'OV_RENDER_FRAME_MISSING', errorClass: 'RenderError', problem: `Frame ${key} is missing from the frame cache.`, suggestions: ['Check that all workers share the same cache store (OPENVIDEO_S3_*).'] });
        }
        await encoder.write(decodeRawFrame(bytes));
        options.onProgress?.({ stage: 'encode', done: ++written, total });
      }
      return await encoder.finish();
    } catch (error) {
      await encoder.abort();
      throw error;
    }
  });
  env.telemetry.metrics.recordEncodingDuration((performance.now() - encodeStart) / 1000, { format: options.profile.format });
  env.telemetry.metrics.recordRenderDuration((performance.now() - renderStart) / 1000, { composition: compositionId });

  const mediaInfo = await media.info();
  const firstScene = evaluateScene(project, compositionId, range.start, { registry: env.registry });
  const backends = new Set<string>();
  for (const [k] of Object.entries(env.versions)) if (k.startsWith('backend:')) backends.add(k.slice('backend:'.length));
  const outputs = await Promise.all(encoded.outputs.map(async (p) => ({ path: p, ...(await fileHash(p)) })));
  const rendered = ordered.reduce((n, r) => n + r.rendered, 0);
  const fromCache = ordered.reduce((n, r) => n + r.fromCache, 0);
  const manifest: RenderManifest = {
    manifestVersion: '1.0.0',
    openvideoVersion: OPENVIDEO_VERSION,
    schemaVersion: String(project['schemaVersion']),
    compositionId,
    compositionHash: contentHash(comp),
    projectHash: contentHash(project),
    assetHashes: Object.fromEntries(Object.entries(assetHashes(env, project)).filter(([k]) => !k.startsWith('font:'))),
    fontHashes: env.fonts.all().map((f) => ({ family: f.family, weight: String(f.weight), style: f.style, hash: f.hash })),
    dependencyVersions: packageVersionsOf(env.versions),
    rendererVersions: Object.fromEntries([...env.registry.backends.values()].map((b) => [b.id, { ...b.versions() }])),
    chromiumVersion: versionOr(env.versions, 'chromium', 'The browser backend was not started.'),
    ffmpegVersion: mediaInfo.version,
    threeVersion: versionOr(env.versions, 'three', 'The Three.js backend is not available.'),
    pixiVersion: versionOr(env.versions, 'pixi.js', 'The PixiJS backend is not available.'),
    skiaVersion: versionOr(env.versions, 'canvaskit-wasm', 'The Skia backend is not available.'),
    blenderVersion: versionOr(env.versions, 'blender', 'Blender is not installed.'),
    os: env.platform.os,
    containerImage: env.platform.containerImage ?? { version: null, reason: 'Rendered outside a container.' },
    gpu: env.platform.gpu ?? { version: null, reason: 'No GPU detected; software rendering (SwiftShader/CPU).' },
    renderBackend: [...backends],
    resolution: { width: out.width, height: out.height },
    fps: out.fps,
    codec: encoded.encoder,
    format: options.profile.format,
    seed: firstScene.seed,
    colorSpace: options.profile.colorSpace ?? firstScene.colorSpace,
    timestamp: new Date().toISOString(),
    frames: { start: range.start, end: range.end, count: outCount },
    frameHashes,
    chunks: ordered.map((r) => ({ start: r.start, end: r.end, hash: chunkHash(r.frameHashes), ...(r.worker !== undefined ? { worker: r.worker } : {}) })),
    ffmpegLicense: mediaInfo.license,
    codecLicenses: { ...mediaInfo.codecLicenses },
    encoder: { name: encoded.encoder, args: [...encoded.args] },
    audio: audio === undefined ? null : { path: audio.path, durationSeconds: audio.durationSeconds, ...(audio.loudness !== undefined ? { loudness: audio.loudness } : {}) },
    outputs,
    trusted: env.trusted,
    stages,
    cache: { hitRatio: env.cache.hitRatio(), framesRendered: rendered, framesFromCache: fromCache },
    diagnostics: countDiagnostics(diagnostics),
  };
  const manifestPath = join(dirname(options.outPath), `${basename(options.outPath)}.render-manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputs: encoded.outputs, manifestPath, manifest, diagnostics };
}

/** Liest einen gerenderten Frame aus dem Cache (für Vorschau und Tests). */
export async function frameFromCache(env: RenderEnvironment, key: string): Promise<RgbaImage | undefined> {
  const bytes = await env.cache.tier('frame').get(key);
  return bytes === undefined ? undefined : decodeRawFrame(bytes);
}

/**
 * Berechnet die Frame-Schlüssel eines Bereichs ohne zu rendern (für Teil-Neurender, FR-69).
 * Gibt zurück, welche Frames im Cache fehlen.
 */
export async function missingFrames(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, compositionId: string | undefined, frames: readonly number[], scale = 1): Promise<number[]> {
  const out: number[] = [];
  for (const f of frames) {
    const scene = evaluateScene(project, compositionId, f, { registry: env.registry });
    const size = outputSize(scene, scale);
    const key = frameKey(scene, env.versions, assetHashes(env, project), { width: size.width, height: size.height, extra: { scale, debug: null } });
    if (!(await env.cache.tier('frame').has(key))) out.push(f);
  }
  return out;
}

/** Hilfsfunktion: IR-Render-Profil nach ID. */
export function profileById(project: Readonly<Record<string, unknown>>, id: string): OutputProfile | undefined {
  const list = project['renderProfiles'];
  if (!Array.isArray(list)) return undefined;
  const p = list.filter(isRecord).find((x) => x['id'] === id);
  if (p === undefined || typeof p['format'] !== 'string') return undefined;
  return {
    format: p['format'],
    ...(typeof p['codec'] === 'string' ? { codec: p['codec'] } : {}),
    ...(typeof p['width'] === 'number' ? { width: p['width'] } : {}),
    ...(typeof p['height'] === 'number' ? { height: p['height'] } : {}),
    ...(typeof p['fps'] === 'number' ? { fps: p['fps'] } : {}),
    ...(typeof p['quality'] === 'number' ? { quality: p['quality'] } : {}),
    ...(typeof p['alpha'] === 'boolean' ? { alpha: p['alpha'] } : {}),
    ...(p['colorSpace'] === 'srgb' || p['colorSpace'] === 'rec709' || p['colorSpace'] === 'linear' ? { colorSpace: p['colorSpace'] } : {}),
    ...(typeof p['audioCodec'] === 'string' ? { audioCodec: p['audioCodec'] } : {}),
    ...(typeof p['audioBitrate'] === 'number' ? { audioBitrate: p['audioBitrate'] } : {}),
    ...(typeof p['hardwareAcceleration'] === 'string' ? { hardwareAcceleration: p['hardwareAcceleration'] } : {}),
  };
}
