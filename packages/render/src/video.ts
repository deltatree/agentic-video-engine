/**
 * Video-Render (FR-60..FR-69): Validierung → Frame-Schlüssel → fehlende Frames rendern →
 * Audio → Encoding → Render-Manifest. Frames liegen im Frame-Cache; nur Geändertes wird neu gerendert.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { OpenVideoError, contentHash, evaluateScene, findComposition, compositionDurationFrames, isRecord, type Diagnostic, type RgbaImage } from '@agentic-video/core';
import { decodeRawFrameAsync } from '@agentic-video/png';
import type { RenderEnvironment } from './environment.js';
import { assetHashes, evaluateFrameKey, renderFrame } from './frame.js';
import type { EncodeOptions, RenderEnvironment as Env } from './environment.js';
import { chunkHash, countDiagnostics, frameBackendUsage, imageHash, manifestChromium, manifestGpu, manifestGraphics, versionOr, type RenderManifest } from './manifest.js';
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
  /** Tatsächlich genutzte Backends der Frame-Pläne dieses Chunks (Story 21.5). */
  readonly backends?: readonly string[];
  /** Gewählte Three.js-Backends (`webgpu`/`webgl2`, `auto` ohne Probe) der `scene3d`-Nodes. */
  readonly threeBackends?: readonly string[];
  /** Tatsächliche Chromium-Version des Prozesses, der den Chunk gerendert hat (falls gestartet). */
  readonly chromiumVersion?: string;
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

/** Abbruch-Signal (Story 18.8): wird abgefragt; `true` heißt „aufhören“. Ein `AbortSignal` passt. */
export interface CancelSignal {
  readonly aborted: boolean;
}

/**
 * Fingerabdruck eines Chunk-Runners für den Schlüssel der Ebene `encoding` (Review M2): Wer die
 * Frames rendert (lokal, Worker-Prozesse, Docker-Image mit GPU-Quota …), bestimmt ihre Pixel mit.
 */
export type RunnerFingerprint = Readonly<Record<string, string | number | boolean | null>>;

/** Fingerabdruck des Standard-Runners (Frames im eigenen Prozess). */
export const LOCAL_RUNNER_FINGERPRINT: RunnerFingerprint = { kind: 'local' };

/** Fingerabdrücke beschriebener Runner (`null`: Ausgabe dieses Runners nie wiederverwenden). */
const runnerFingerprints = new WeakMap<ChunkRunner, RunnerFingerprint | null>();

/**
 * Hängt einem Chunk-Runner seinen Fingerabdruck an (Review M2). Nur beschriebene Runner nutzen die
 * Cache-Ebene `encoding`; ein Runner ohne Beschreibung oder mit `null` (z. B. entfernte Worker,
 * deren Versionen vor dem Render unbekannt sind) rendert und kodiert immer frisch.
 *
 * @example
 * ```ts
 * const runChunks = describeChunkRunner(createDockerChunkRunner(options), { kind: 'docker', image: 'openvideo/worker:0.1.0', gpus: null, browserGpu: false });
 * ```
 */
export function describeChunkRunner<T extends ChunkRunner>(runner: T, fingerprint: RunnerFingerprint | null): T {
  runnerFingerprints.set(runner, fingerprint);
  return runner;
}

/**
 * Fingerabdruck eines Runners: ohne Runner {@link LOCAL_RUNNER_FINGERPRINT}, sonst der mit
 * {@link describeChunkRunner} angehängte; unbeschriebene Runner liefern `null` (kein Ausgabe-Cache).
 *
 * @example
 * ```ts
 * chunkRunnerFingerprint(undefined); // { kind: 'local' }
 * ```
 */
export function chunkRunnerFingerprint(runner: ChunkRunner | undefined): RunnerFingerprint | null {
  if (runner === undefined) return LOCAL_RUNNER_FINGERPRINT;
  return runnerFingerprints.get(runner) ?? null;
}

/** Laufzeit-Optionen eines Chunk-Runners. */
export interface ChunkRunOptions {
  /** Bricht laufende und wartende Chunks ab (Worker bekommen `cancel`). */
  readonly signal?: CancelSignal;
}

/**
 * Rendert Chunks; Standard ist lokal im selben Prozess, der Scheduler ersetzt ihn für Parallelität.
 * `onChunkDone` kann Chunks in beliebiger Reihenfolge melden. Mit `options.signal` bricht der
 * Runner ab (Story 18.8) und wirft `OV_RENDER_CANCELLED`.
 */
export type ChunkRunner = (chunks: readonly ChunkRequest[], onChunkDone: (result: ChunkResult) => void, options?: ChunkRunOptions) => Promise<readonly ChunkResult[]>;

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
  /**
   * Threads des Encoders (Story 18.6). Standard: `OPENVIDEO_ENCODER_THREADS`, sonst die freien
   * Kerne neben den lokalen Render-Prozessen (mindestens 2, höchstens 16). Die Frame-Hashes hängen
   * nicht davon ab, die Bytes der Videodatei schon: Für bitgleiche Dateien über Maschinen hinweg
   * eine feste Zahl setzen (bis Epic 18 galt fest 4).
   */
  readonly encoderThreads?: number;
  /** Anzahl der lokal gleichzeitig rendernden Prozesse (für die Encoder-Threads; Standard 1). */
  readonly localRenderProcesses?: number;
  /**
   * Ganze Ausgabe aus der Cache-Ebene `encoding` wiederverwenden (Story 21.2, ADR 0021). Ein Treffer
   * setzt gleiche Eingaben voraus (Frame-Schlüssel aller Ausgabe-Frames, Projekt, Assets,
   * Versionen, Bereich, Profil, Encoder-Einstellungen samt Hardware-Wahl, Tonspur, Runner) und
   * liefert die Bytes der früheren Kodierung, ohne zu rendern oder zu kodieren. Standard `true`;
   * `OPENVIDEO_OUTPUT_CACHE=0` schaltet ab. Nur für Formate mit genau einer Ausgabedatei (keine
   * Bildfolgen) und für beschriebene Runner ({@link describeChunkRunner}).
   */
  readonly reuseOutput?: boolean;
  /**
   * Obergrenze des lokalen Caches in Bytes; nach dem Render wird bis dahin aufgeräumt (LRU,
   * Story 18.9). Standard `OPENVIDEO_CACHE_MAX_BYTES`; ohne Wert kein Aufräumen.
   */
  readonly cacheMaxBytes?: number;
}

/** Wirft `OV_RENDER_CANCELLED`, wenn das Signal gesetzt ist. */
function throwIfCancelled(signal: CancelSignal | undefined): void {
  if (signal?.aborted === true) throw new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] });
}

/** Standard-Threadzahl des Encoders; fest, damit die Videodatei auf jeder Maschine bitgleich ist (§20). */
export const DEFAULT_ENCODER_THREADS = 4;

/**
 * Encoder-Threads (Story 18.6). Standard ist {@link DEFAULT_ENCODER_THREADS}: x264 teilt die Arbeit
 * je Thread auf, eine von der Maschine abhängige Zahl würde die Bytes der Videodatei ändern.
 * `OPENVIDEO_ENCODER_THREADS=<n>` legt die Zahl fest; `OPENVIDEO_ENCODER_THREADS=auto` nutzt die
 * freien Kerne (Kerne minus lokale Render-Prozesse, 2–16) und tauscht Reproduzierbarkeit der Datei
 * gegen Geschwindigkeit; die Frame-Hashes bleiben in jedem Fall gleich.
 *
 * @example
 * ```ts
 * encoderThreadsFor(4, {}, 8); // 4
 * encoderThreadsFor(1, { OPENVIDEO_ENCODER_THREADS: 'auto' }, 8); // 7
 * encoderThreadsFor(1, { OPENVIDEO_ENCODER_THREADS: '8' }); // 8
 * ```
 */
export function encoderThreadsFor(localRenderProcesses: number, env: Readonly<Record<string, string | undefined>> = process.env, cores: number = availableParallelism()): number {
  const raw = env['OPENVIDEO_ENCODER_THREADS']?.trim();
  if (raw === 'auto') return Math.max(2, Math.min(16, cores - Math.max(0, Math.floor(localRenderProcesses))));
  const fixed = Number(raw);
  if (raw !== undefined && raw !== '' && Number.isInteger(fixed) && fixed > 0) return Math.min(64, fixed);
  return DEFAULT_ENCODER_THREADS;
}

/** Liest `OPENVIDEO_CACHE_MAX_BYTES` (Bytes, auch mit Exponent wie `5e10`); ungültig oder leer: keine Grenze. */
export function cacheMaxBytesFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = env['OPENVIDEO_CACHE_MAX_BYTES'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
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
export async function renderChunk(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, chunk: ChunkRequest, signal?: CancelSignal, onFrame?: (image: RgbaImage, index: number) => Promise<void>): Promise<ChunkResult> {
  const hashes: string[] = [];
  const keys: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let rendered = 0;
  let fromCache = 0;
  const backends = new Set<string>();
  const threeBackends = new Set<string>();
  // Layer-Historie über die Frames des Chunks: animierte Layer werden nicht komprimiert (Story 18.3).
  const layerHistory = new Map<string, string>();
  for (let i = chunk.start; i < chunk.end; i++) {
    throwIfCancelled(signal);
    const frame = chunk.offset + i * chunk.step;
    const result = await renderFrame(env, project, { compositionId: chunk.compositionId, frame, scale: chunk.scale, layerHistory, ...(signal !== undefined ? { signal } : {}) });
    hashes.push(imageHash(result.image));
    if (onFrame !== undefined) await onFrame(result.image, i);
    keys.push(result.key);
    if (result.cached) fromCache++;
    else rendered++;
    for (const d of result.diagnostics) if (d.severity !== 'info') diagnostics.push(d);
    // Genutzte Backends aus dem Frame-Plan, auch für Frames aus dem Cache (Story 21.5).
    const usage = frameBackendUsage(env, project, result.scene);
    for (const b of usage.backends) backends.add(b);
    for (const b of usage.threeBackends) threeBackends.add(b);
  }
  const runtime = await env.runtime?.();
  const chromiumVersion = runtime?.versions['chromium'];
  return {
    start: chunk.start,
    end: chunk.end,
    frameHashes: hashes,
    keys,
    rendered,
    fromCache,
    diagnostics,
    backends: [...backends].sort(),
    threeBackends: [...threeBackends].sort(),
    ...(chromiumVersion !== undefined ? { chromiumVersion } : {}),
  };
}

/**
 * Liest `OPENVIDEO_OUTPUT_CACHE`: `0`/`false`/`off` schaltet die Wiederverwendung ganzer Ausgaben ab.
 *
 * @example
 * ```ts
 * outputCacheFromEnv({ OPENVIDEO_OUTPUT_CACHE: '0' }); // false
 * ```
 */
export function outputCacheFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env['OPENVIDEO_OUTPUT_CACHE']?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/** Eintrag der Cache-Ebene `encoding`: Verweis auf die Bytes und alles, was das Manifest braucht. */
interface OutputEntry {
  readonly v: 1;
  /** Schlüssel der Bytes in derselben Ebene (`file-<sha256>`). */
  readonly file: string;
  readonly hash: string;
  readonly encoder: string;
  readonly args: readonly string[];
  readonly frameHashes: readonly string[];
  readonly chunks: readonly { readonly start: number; readonly end: number; readonly hash: string; readonly worker?: string }[];
  readonly backends: readonly string[];
  readonly threeBackends: readonly string[];
  readonly chromiumVersion?: string;
  readonly diagnostics: readonly Diagnostic[];
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isOutputEntry(value: unknown): value is OutputEntry {
  if (!isRecord(value)) return false;
  const chunks = value['chunks'];
  return (
    value['v'] === 1 &&
    typeof value['file'] === 'string' &&
    typeof value['hash'] === 'string' &&
    typeof value['encoder'] === 'string' &&
    isStrings(value['args']) &&
    isStrings(value['frameHashes']) &&
    isStrings(value['backends']) &&
    isStrings(value['threeBackends']) &&
    (value['chromiumVersion'] === undefined || typeof value['chromiumVersion'] === 'string') &&
    Array.isArray(value['diagnostics']) &&
    Array.isArray(chunks) &&
    chunks.every((c) => isRecord(c) && typeof c['start'] === 'number' && typeof c['end'] === 'number' && typeof c['hash'] === 'string' && (c['worker'] === undefined || typeof c['worker'] === 'string'))
  );
}

/** Ergebnis von Rendern und Kodieren (frisch oder aus der Ebene `encoding`). */
interface Produced {
  readonly outputs: readonly string[];
  readonly encoder: string;
  readonly args: readonly string[];
  readonly frameHashes: readonly string[];
  readonly chunks: RenderManifest['chunks'];
  readonly backends: readonly string[];
  readonly threeBackends: readonly string[];
  readonly chromiumVersions: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly rendered: number;
  readonly fromCache: number;
  readonly output: 'hit' | 'miss' | 'off';
}

/** Eingaben des Schlüssels der Ebene `encoding` neben Projekt und Umgebung. */
interface OutputKeyInput {
  readonly compositionId: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly count: number;
  readonly step: number;
  readonly scale: number;
  readonly encoder: Omit<EncodeOptions, 'outPath' | 'audioPath'>;
  /** Verfügbare Hardware-Encoder, wenn `hardware` nicht `none` ist (bestimmen die tatsächliche Wahl). */
  readonly hardwareEncoders: Readonly<Record<string, boolean>> | null;
  readonly audioHash: string | null;
  readonly runner: RunnerFingerprint;
}

/**
 * Schlüssel der Ebene `encoding` für eine ganze Ausgabe (ADR 0021, Review M1/M2). Er enthält die
 * Frame-Schlüssel aller Ausgabe-Frames (reine Auswertung nach `prepare`, ohne Rendern): Sie tragen
 * die expandierte Szene – auch Untertitel aus Transkripten – sowie Versionen und Asset-Hashes.
 */
function outputKey(env: Env, project: Readonly<Record<string, unknown>>, input: OutputKeyInput): string {
  const frames: string[] = [];
  for (let i = 0; i < input.count; i++) frames.push(evaluateFrameKey(env, project, input.compositionId, input.range.start + i * input.step, input.scale));
  return `render-${contentHash({ v: 'output-2', project: contentHash(project), assets: assetHashes(env, project), versions: env.versions, trusted: env.trusted, frames: contentHash(frames), ...input }).slice('sha256:'.length)}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Liest einen Treffer der Ebene `encoding` und schreibt die Datei nach `outPath`; sonst `undefined`. */
async function restoreOutput(env: Env, key: string, outPath: string): Promise<OutputEntry | undefined> {
  const tier = env.cache.tier('encoding');
  const meta = await tier.get(key);
  if (meta === undefined) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(new TextDecoder().decode(meta));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isOutputEntry(entry)) return undefined;
  const local = tier.localPath(entry.file);
  // Lokale Datei direkt kopieren (kein Laden in den Speicher); sonst über den Speicher (z. B. S3).
  let copied = false;
  if (local !== undefined) {
    try {
      await copyFile(local, outPath);
      copied = true;
    } catch (error) {
      // Fehlt die Datei (z. B. nach parallelem `prune`), gilt der Eintrag als Fehlgriff (Review m4).
      if (!isNotFound(error)) throw error;
    }
  }
  if (!copied) {
    const bytes = await tier.get(entry.file);
    if (bytes === undefined) return undefined;
    await writeFile(outPath, bytes);
  }
  // Die Bytes müssen zum gespeicherten Hash passen; sonst gilt der Eintrag als Fehlgriff.
  if ((await fileHash(outPath)).hash !== entry.hash) return undefined;
  return entry;
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
 * Ablauf (Story 18.6): Audio → Encoder starten → Chunks rendern; fertige Chunks gehen in
 * Reihenfolge sofort an den Encoder, während weitere rendern. Im lokalen Runner bekommt der
 * Encoder die Frames direkt aus dem Speicher; mit Scheduler kommen sie aus dem Frame-Cache
 * (Entpacken im Thread-Pool). Danach optional LRU-Aufräumen des Caches (Story 18.9).
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
  const signal = options.signal;
  throwIfCancelled(signal);
  await env.prepare?.(project);

  await mkdir(dirname(options.outPath), { recursive: true });
  let audio: { path: string; durationSeconds: number; loudness?: number; voices?: Readonly<Record<string, string>> } | undefined;
  if (options.noAudio !== true && env.audio !== undefined && options.profile.format !== 'gif' && !options.profile.format.endsWith('-sequence') && options.profile.format !== 'webp') {
    const audioEngine = env.audio;
    audio = await stage('audioPipeline', () => audioEngine.renderComposition({ project, composition: comp, startFrame: range.start, endFrame: range.end, outPath: join(dirname(options.outPath), `${basename(options.outPath)}.audio.wav`) }));
  }

  const localProcesses = options.localRenderProcesses ?? (options.runChunks === undefined ? 1 : 0);
  const encoderSettings: Omit<EncodeOptions, 'outPath' | 'audioPath'> = {
    format: options.profile.format,
    ...(options.profile.codec !== undefined ? { codec: options.profile.codec } : {}),
    width: out.width,
    height: out.height,
    fps: out.fps,
    alpha: options.profile.alpha === true,
    quality: options.profile.quality ?? 80,
    // Hardware-Encoding nur auf ausdrücklichen Wunsch (Story 21.5): gleiche Bytes auf jeder Maschine.
    hardware: options.profile.hardwareAcceleration ?? 'none',
    colorSpace: options.profile.colorSpace ?? 'srgb',
    threads: options.encoderThreads ?? encoderThreadsFor(localProcesses),
    ...(options.profile.audioCodec !== undefined ? { audioCodec: options.profile.audioCodec } : {}),
    ...(options.profile.audioBitrate !== undefined ? { audioBitrate: options.profile.audioBitrate } : {}),
  };

  // Cache-Ebene `encoding` (Story 21.2): gleiche Eingaben → Bytes der früheren Kodierung.
  // Nur mit bekanntem Runner (Review M2) und bekannter Hardware-Wahl (Review m3): Die Wahl bei
  // `hardware` ≠ `none` folgt aus Profil und verfügbaren Encodern; fehlen diese, kein Ausgabe-Cache.
  const wanted = (options.reuseOutput ?? outputCacheFromEnv()) && !options.profile.format.endsWith('-sequence');
  const runner = wanted ? chunkRunnerFingerprint(options.runChunks) : null;
  const hardwareEncoders = runner === null ? undefined : encoderSettings.hardware === 'none' ? null : await media.hardwareEncoders?.();
  const key =
    runner !== null && hardwareEncoders !== undefined
      ? await stage('outputKey', async () => outputKey(env, project, { compositionId, range, count: outCount, step: out.step, scale: out.scale, encoder: encoderSettings, hardwareEncoders, audioHash: audio === undefined ? null : (await fileHash(audio.path)).hash, runner }))
      : undefined;
  const cachedOutput = key !== undefined ? await stage('outputCache', () => restoreOutput(env, key, options.outPath)) : undefined;
  const encodeFresh = async (): Promise<Produced> => {
    const encoder = await media.createEncoder({
      outPath: options.outPath,
      ...encoderSettings,
      ...(audio !== undefined ? { audioPath: audio.path } : {}),
    });

    // Encoder-Pumpe: schreibt fertige Chunks in Ausgabe-Reihenfolge, parallel zum Rendern.
    let written = 0;
    let encodeSeconds = 0;
    let nextStart = 0;
    const ready = new Map<number, ChunkResult>();
    const direct = new Set<number>();
    let pump: Promise<void> = Promise.resolve();
    // Als Objekt: Callbacks setzen den Zustand zwischen zwei `await`.
    const pumpState: { failed: boolean; error: unknown } = { failed: false, error: undefined };
    const writeFrame = async (image: RgbaImage): Promise<void> => {
      const t = performance.now();
      await encoder.write(image);
      encodeSeconds += (performance.now() - t) / 1000;
      written++;
      options.onProgress?.({ stage: 'encode', done: written, total });
    };
    const drain = async (): Promise<void> => {
      for (let r = ready.get(nextStart); r !== undefined; r = ready.get(nextStart)) {
        ready.delete(nextStart);
        if (!direct.has(r.start)) {
          for (const key of r.keys) {
            throwIfCancelled(signal);
            const bytes = await env.cache.tier('frame').get(key);
            if (bytes === undefined) {
              throw new OpenVideoError({ code: 'OV_RENDER_FRAME_MISSING', errorClass: 'RenderError', problem: `Frame ${key} is missing from the frame cache.`, suggestions: ['Check that all workers share the same cache store (OPENVIDEO_S3_*).'] });
            }
            await writeFrame(await decodeRawFrameAsync(bytes));
          }
        }
        nextStart = r.end;
      }
    };
    const enqueue = (r: ChunkResult): void => {
      ready.set(r.start, r);
      pump = pump.then(drain).catch((error: unknown) => {
        if (!pumpState.failed) {
          pumpState.failed = true;
          pumpState.error = error;
        }
      });
    };

    // Abbruch auch bei einem Fehler der Encoder-Pumpe (Review Q7): Runner und Worker hören sonst erst
    // nach dem letzten Chunk auf, obwohl das Ergebnis schon verloren ist.
    const runSignal: CancelSignal = {
      get aborted() {
        return signal?.aborted === true || pumpState.failed;
      },
    };
    const runner: ChunkRunner =
      options.runChunks ??
      (async (list, onDone) => {
        const results: ChunkResult[] = [];
        for (const c of list) {
          // Lokal in Reihenfolge: Frames gehen ohne Umweg über den Cache an den Encoder.
          await pump;
          const inOrder = c.start === nextStart && ready.size === 0 && !pumpState.failed;
          if (inOrder) direct.add(c.start);
          const r = await renderChunk(env, project, c, runSignal, inOrder ? writeFrame : undefined);
          onDone(r);
          results.push(r);
        }
        return results;
      });
    const renderStart = performance.now();
    let results: readonly ChunkResult[];
    try {
      results = await stage('renderFrames', () =>
        runner(
          chunks,
          (r) => {
            done += r.end - r.start;
            options.onProgress?.({ stage: 'render', done, total });
            enqueue(r);
          },
          { signal: runSignal },
        ),
      );
      await pump;
      if (pumpState.failed) throw pumpState.error;
    } catch (error) {
      await pump.catch(() => undefined);
      await encoder.abort();
      // Hat die Pumpe den Abbruch ausgelöst, zählt ihr Fehler, nicht `OV_RENDER_CANCELLED`.
      if (pumpState.failed && signal?.aborted !== true) throw pumpState.error;
      throw error;
    }
    const ordered = [...results].sort((a, b) => a.start - b.start);
    const keys = ordered.flatMap((r) => [...r.keys]);
    const frameHashes = ordered.flatMap((r) => [...r.frameHashes]);
    const diagnostics = ordered.flatMap((r) => [...r.diagnostics]);
    if (keys.length !== outCount || written !== outCount) {
      await encoder.abort();
      throw new OpenVideoError({ code: 'OV_RENDER_INCOMPLETE', errorClass: 'RenderError', problem: `Expected ${String(outCount)} frames but got ${String(keys.length)} (${String(written)} encoded).`, suggestions: ['Retry the failed chunks with `render.status`.'] });
    }

    const encodeStart = performance.now();
    let encoded: Awaited<ReturnType<typeof encoder.finish>>;
    try {
      encoded = await stage('ffmpeg', () => encoder.finish());
    } catch (error) {
      await encoder.abort();
      throw error;
    }
    // `ffmpeg` misst die Zeit, die der Encoder den Ablauf aufhielt: Schreiben (parallel zum Rendern) und Abschluss.
    stages['ffmpeg'] = (stages['ffmpeg'] ?? 0) + encodeSeconds;
    const encodeWall = (performance.now() - encodeStart) / 1000 + encodeSeconds;
    env.telemetry.metrics.recordEncodingDuration(encodeWall, { format: options.profile.format });
    env.telemetry.metrics.recordRenderDuration((performance.now() - renderStart) / 1000, { composition: compositionId });
    const chunkList = ordered.map((r) => ({ start: r.start, end: r.end, hash: chunkHash(r.frameHashes), ...(r.worker !== undefined ? { worker: r.worker } : {}) }));
    const usedBackends = [...new Set(ordered.flatMap((r) => [...(r.backends ?? [])]))].sort();
    const usedThree = [...new Set(ordered.flatMap((r) => [...(r.threeBackends ?? [])]))].sort();
    const chromiumVersions = [...new Set(ordered.flatMap((r) => (r.chromiumVersion !== undefined ? [r.chromiumVersion] : [])))];
    const state: 'miss' | 'off' = key === undefined ? 'off' : 'miss';
    const single = encoded.outputs.length === 1 && encoded.outputs[0] === options.outPath;
    if (key !== undefined && single) {
      // Ausgabe für wiederholte identische Renders ablegen; ein Fehler hier kostet nur den Treffer.
      try {
        const tier = env.cache.tier('encoding');
        const bytes = await readFile(options.outPath);
        const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        const file = `file-${hash.slice('sha256:'.length)}`;
        if (!(await tier.has(file))) await tier.put(file, bytes);
        const entry: OutputEntry = { v: 1, file, hash, encoder: encoded.encoder, args: [...encoded.args], frameHashes, chunks: chunkList, backends: usedBackends, threeBackends: usedThree, ...(chromiumVersions[0] !== undefined ? { chromiumVersion: chromiumVersions[0] } : {}), diagnostics };
        await tier.put(key, new TextEncoder().encode(JSON.stringify(entry)));
      } catch (error) {
        env.telemetry.logger.warn('output cache write failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      outputs: encoded.outputs,
      encoder: encoded.encoder,
      args: encoded.args,
      frameHashes,
      chunks: chunkList,
      backends: usedBackends,
      threeBackends: usedThree,
      chromiumVersions,
      diagnostics,
      rendered: ordered.reduce((n, r) => n + r.rendered, 0),
      fromCache: ordered.reduce((n, r) => n + r.fromCache, 0),
      output: state,
    };
  };

  let produced: Produced;
  if (cachedOutput !== undefined) {
    options.onProgress?.({ stage: 'encode', done: total, total });
    produced = {
      outputs: [options.outPath],
      encoder: cachedOutput.encoder,
      args: cachedOutput.args,
      frameHashes: cachedOutput.frameHashes,
      chunks: cachedOutput.chunks.map((c) => ({ ...c })),
      backends: cachedOutput.backends,
      threeBackends: cachedOutput.threeBackends,
      chromiumVersions: cachedOutput.chromiumVersion !== undefined ? [cachedOutput.chromiumVersion] : [],
      diagnostics: cachedOutput.diagnostics,
      rendered: 0,
      fromCache: outCount,
      output: 'hit',
    };
  } else {
    produced = await encodeFresh();
  }

  const mediaInfo = await media.info();
  const runtime = await env.runtime?.();
  const firstScene = evaluateScene(project, compositionId, range.start, { registry: env.registry });
  const outputs = await Promise.all(produced.outputs.map(async (p) => ({ path: p, ...(await fileHash(p)) })));
  const { frameHashes, diagnostics, rendered, fromCache } = produced;
  const usedBrowser = produced.backends.some((b) => b === 'browser' || b === 'three' || b === 'pixi');
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
    chromiumVersion: manifestChromium(runtime, produced.chromiumVersions, usedBrowser),
    ffmpegVersion: mediaInfo.version,
    threeVersion: versionOr(env.versions, 'three', 'The Three.js backend is not available.'),
    pixiVersion: versionOr(env.versions, 'pixi.js', 'The PixiJS backend is not available.'),
    skiaVersion: versionOr(env.versions, 'canvaskit-wasm', 'The Skia backend is not available.'),
    blenderVersion: versionOr(env.versions, 'blender', 'Blender is not installed.'),
    os: env.platform.os,
    containerImage: env.platform.containerImage ?? { version: null, reason: 'Rendered outside a container.' },
    gpu: manifestGpu(env),
    renderBackend: [...produced.backends],
    graphics: manifestGraphics(env, runtime, produced.threeBackends.filter((b): b is 'webgpu' | 'webgl2' | 'auto' => b === 'webgpu' || b === 'webgl2' || b === 'auto')),
    ...(audio?.voices !== undefined ? { voiceHashes: { ...audio.voices } } : {}),
    resolution: { width: out.width, height: out.height },
    fps: out.fps,
    codec: produced.encoder,
    format: options.profile.format,
    seed: firstScene.seed,
    colorSpace: options.profile.colorSpace ?? firstScene.colorSpace,
    timestamp: new Date().toISOString(),
    frames: { start: range.start, end: range.end, count: outCount },
    frameHashes: [...frameHashes],
    chunks: [...produced.chunks],
    ffmpegLicense: mediaInfo.license,
    codecLicenses: { ...mediaInfo.codecLicenses },
    encoder: { name: produced.encoder, args: [...produced.args] },
    audio: audio === undefined ? null : { path: audio.path, durationSeconds: audio.durationSeconds, ...(audio.loudness !== undefined ? { loudness: audio.loudness } : {}) },
    outputs,
    trusted: env.trusted,
    stages,
    cache: { hitRatio: env.cache.hitRatio(), framesRendered: rendered, framesFromCache: fromCache, output: produced.output },
    diagnostics: countDiagnostics(diagnostics),
  };
  const manifestPath = join(dirname(options.outPath), `${basename(options.outPath)}.render-manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Cache-Budget (Story 18.9): nach dem Render bis zur Obergrenze aufräumen (älteste zuerst).
  const maxBytes = options.cacheMaxBytes ?? cacheMaxBytesFromEnv();
  if (maxBytes !== undefined) {
    try {
      await env.cache.prune(maxBytes);
    } catch (error) {
      env.telemetry.logger.warn('cache prune failed', { maxBytes, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { outputs: produced.outputs, manifestPath, manifest, diagnostics: [...diagnostics] };
}

/** Liest einen gerenderten Frame aus dem Cache (für Vorschau und Tests). */
export async function frameFromCache(env: RenderEnvironment, key: string): Promise<RgbaImage | undefined> {
  const bytes = await env.cache.tier('frame').get(key);
  return bytes === undefined ? undefined : decodeRawFrameAsync(bytes);
}

/**
 * Berechnet die Frame-Schlüssel eines Bereichs ohne zu rendern (für Teil-Neurender, FR-69).
 * Gibt zurück, welche Frames im Cache fehlen.
 */
export async function missingFrames(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, compositionId: string | undefined, frames: readonly number[], scale = 1): Promise<number[]> {
  const out: number[] = [];
  await env.prepare?.(project);
  for (const f of frames) {
    // Wie renderFrame (auch animierte Bilder als Video-Nodes, Story 18.9).
    const key = evaluateFrameKey(env, project, compositionId, f, scale);
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
