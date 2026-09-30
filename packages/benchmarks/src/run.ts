/**
 * Benchmark-Läufe (A38, FR-94, SM-4): Szenario erzeugen, mit der echten Render-Umgebung
 * rendern und messen. Nur Zeitmessungen schwanken; Frame-Hashes sind deterministisch.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore, createCache, type Cache } from '@agentic-video/cache';
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { checkProject, createNodeEnvironment, imageHash, renderFrame, renderVideo, type ChunkRunner, type NodeEnvironment, type RenderEnvironment } from '@agentic-video/render';
import { describeMachine, startResourceMonitor, summarize, type GpuUsage, type MachineInfo, type TimingStats } from './metrics.js';
import { RESOLUTIONS, RESOLUTION_IDS, SCENARIOS, buildManyAssetsProject, buildScenario, type ResolutionId, type ScenarioId } from './scenarios.js';

/** Eingaben für {@link runBenchmark}. */
export interface BenchmarkOptions {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  /** Gemessene Frames (Standard 10). */
  readonly frames?: number;
  /** Worker-Prozesse für die Durchsatzmessung (Standard 1). */
  readonly workers?: number;
  /** Frames auch zu MP4 kodieren und den Encoder messen (Standard `true`). */
  readonly encode?: boolean;
  /** Arbeitsordner; Standard ist ein temporärer Ordner, der danach gelöscht wird. */
  readonly workDir?: string;
  /** FFmpeg-Programm für Test-Assets. */
  readonly ffmpeg?: string;
}

/** Kurzform einer Diagnose im Ergebnis. */
export interface BenchmarkDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly problem: string;
}

/** Messergebnis eines Szenarios in einer Auflösung. */
export interface BenchmarkResult {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  /** Gerenderte Frames pro Sekunde in einem Prozess. */
  readonly framesPerSecond: number;
  /** Renderzeit pro Frame in Millisekunden. */
  readonly frameMs: TimingStats;
  /** Zeit von der Umgebung bis zum ersten fertigen Frame in Millisekunden. */
  readonly startupMs: number;
  readonly cpuPercent: number;
  readonly cpuSeconds: number;
  readonly cpuScope: 'process-tree' | 'process';
  readonly peakRssMb: number;
  readonly rssScope: 'process-tree' | 'process';
  readonly gpu: GpuUsage;
  /** Trefferquote aller Cache-Stufen während des Renderns (0..1). */
  readonly cacheHitRatio: number;
  readonly encoding: { readonly framesPerSecond: number; readonly seconds: number; readonly encoder: string } | { readonly framesPerSecond: null; readonly reason: string };
  /** Sekunden der Audio-Pipeline (Mischung, Ducking, Mastering); `null` ohne Encoding. */
  readonly audioSeconds: number | null;
  /** Tatsächlich genutzte Worker-Prozesse. */
  readonly workers: number;
  /** Durchsatz mit mehreren Worker-Prozessen; `null`, wenn nur ein Prozess lief. */
  readonly parallelFramesPerSecond: number | null;
  /** Grund, warum weniger Worker als verlangt liefen. */
  readonly workersNote?: string;
  /** Pixel-Hashes der Frames in Reihenfolge (deterministisch). */
  readonly frameHashes: readonly string[];
  /** Die kodierten Frames sind bitgleich zu den gemessenen; `null` ohne Encoding. */
  readonly deterministic: boolean | null;
  readonly diagnostics: readonly BenchmarkDiagnostic[];
  readonly machine: MachineInfo;
}

type RunnerFactory = (options: { readonly concurrency: number; readonly projectDir: string; readonly project: Readonly<Record<string, unknown>>; readonly cache: Cache; readonly telemetry: RenderEnvironment['telemetry'] }) => unknown;

function isRunnerFactory(value: unknown): value is RunnerFactory {
  return typeof value === 'function';
}

function isChunkRunner(value: unknown): value is ChunkRunner {
  return typeof value === 'function';
}

/**
 * Lädt `createProcessChunkRunner` aus `@agentic-video/scheduler`, falls installiert.
 * Das Paket ist optional; ohne es misst der Benchmark nur einen Prozess.
 *
 * @example
 * ```ts
 * const found = await loadProcessRunnerFactory();
 * if ('factory' in found) { ... }
 * ```
 */
export async function loadProcessRunnerFactory(): Promise<{ readonly factory: RunnerFactory } | { readonly reason: string }> {
  // Variabler Bezeichner: Der Scheduler bleibt eine optionale Laufzeit-Abhängigkeit.
  const specifier = '@agentic-video/scheduler';
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch (error) {
    return { reason: `@agentic-video/scheduler is not available: ${error instanceof Error ? error.message : String(error)}` };
  }
  const factory = isRecord(mod) ? mod['createProcessChunkRunner'] : undefined;
  return isRunnerFactory(factory) ? { factory } : { reason: '@agentic-video/scheduler does not export createProcessChunkRunner.' };
}

function collectDiagnostics(target: Map<string, BenchmarkDiagnostic>, list: readonly { readonly severity: string; readonly code: string; readonly problem: string }[]): void {
  for (const d of list) {
    if (d.severity === 'info') continue;
    const key = `${d.code}:${d.problem}`;
    if (!target.has(key)) target.set(key, { severity: d.severity, code: d.code, problem: d.problem });
  }
}

async function measureParallel(env: NodeEnvironment, project: Readonly<Record<string, unknown>>, dir: string, frames: number, workers: number): Promise<{ workers: number; fps: number | null; note?: string }> {
  const found = await loadProcessRunnerFactory();
  if ('reason' in found) return { workers: 1, fps: null, note: found.reason };
  // Eigener, leerer Cache: Die Worker müssen jeden Frame wirklich rendern.
  const cache = createCache(new FileStore(join(dir, 'parallel-cache')));
  try {
    const runner = found.factory({ concurrency: workers, projectDir: dir, project, cache, telemetry: env.telemetry });
    if (!isChunkRunner(runner)) return { workers: 1, fps: null, note: 'createProcessChunkRunner did not return a chunk runner.' };
    const result = await renderVideo({ ...env, cache }, project, {
      outPath: join(dir, 'out', 'parallel.mp4'),
      profile: { format: 'mp4', codec: 'h264' },
      range: { start: 0, end: frames },
      chunkSize: Math.max(1, Math.ceil(frames / workers)),
      runChunks: runner,
      noAudio: true,
    });
    const seconds = result.manifest.stages['renderFrames'] ?? 0;
    return { workers, fps: seconds > 0 ? frames / seconds : null };
  } catch (error) {
    if (!(error instanceof OpenVideoError)) throw error;
    return { workers: 1, fps: null, note: `Worker processes failed: ${error.message}` };
  }
}

/**
 * Misst ein Szenario in einer Auflösung.
 *
 * Ablauf: Projekt erzeugen → Umgebung + erster Frame (Startzeit) → alle Frames einzeln rendern
 * (Renderzeit pro Frame) → optional MP4 kodieren (Encoder-Durchsatz, Audio) → optional mit N Workern.
 *
 * @example
 * ```ts
 * const r = await runBenchmark({ scenario: 'text-heavy', resolution: '1080p30', frames: 10 });
 * console.log(r.framesPerSecond, r.frameMs.p95);
 * ```
 */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const frames = Math.max(1, Math.floor(options.frames ?? 10));
  const requestedWorkers = Math.max(1, Math.floor(options.workers ?? 1));
  const encode = options.encode ?? true;
  const res = RESOLUTIONS[options.resolution];
  const dir = options.workDir ?? (await mkdtemp(join(tmpdir(), `ov-bench-${options.scenario}-`)));
  const machine = describeMachine();
  try {
    const { project, compositionId } = await buildScenario({ scenario: options.scenario, resolution: options.resolution, frames, projectDir: dir, ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}) });
    const diagnostics = new Map<string, BenchmarkDiagnostic>();
    const monitor = await startResourceMonitor();
    const t0 = performance.now();
    const env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new FileStore(join(dir, '.openvideo', 'cache'))) });
    let usage: Awaited<ReturnType<typeof monitor.stop>> | undefined;
    try {
      // Aufwärm-Frame hinter dem Messbereich: startet träge Backends (z. B. Chromium) und zählt zur Startzeit.
      // Er liegt außerhalb der gemessenen Frames, damit deren Layer nicht schon im Cache liegen.
      await renderFrame(env, project, { compositionId, frame: frames, useCache: false });
      const startupMs = performance.now() - t0;
      collectDiagnostics(diagnostics, env.assetDiagnostics);
      collectDiagnostics(diagnostics, checkProject(env, project));

      const times: number[] = [];
      const hashes: string[] = [];
      // Wie ein Chunk im Video-Render (`renderChunk`): mit Layer-Historie, damit animierte Layer nicht
      // in den Layer-Cache komprimiert werden (Story 18.3). Der Frame-Cache wird weiter geschrieben.
      const layerHistory = new Map<string, string>();
      for (let f = 0; f < frames; f++) {
        const start = performance.now();
        const r = await renderFrame(env, project, { compositionId, frame: f, layerHistory });
        times.push(performance.now() - start);
        hashes.push(imageHash(r.image));
        collectDiagnostics(diagnostics, r.diagnostics);
      }
      const cacheHitRatio = env.cache.hitRatio();

      let encoding: BenchmarkResult['encoding'] = { framesPerSecond: null, reason: 'Encoding was disabled (encode: false).' };
      let audioSeconds: number | null = null;
      let deterministic: boolean | null = null;
      if (encode) {
        // Alle Frames liegen im Frame-Cache; gemessen wird nur Audio und Encoder.
        const video = await renderVideo(env, project, { compositionId, outPath: join(dir, 'out', 'bench.mp4'), profile: { format: 'mp4', codec: 'h264' }, range: { start: 0, end: frames } });
        const seconds = video.manifest.stages['ffmpeg'] ?? 0;
        encoding = seconds > 0 ? { framesPerSecond: frames / seconds, seconds, encoder: video.manifest.encoder?.name ?? video.manifest.codec } : { framesPerSecond: null, reason: 'The encoder reported no duration.' };
        audioSeconds = video.manifest.stages['audioPipeline'] ?? null;
        deterministic = video.manifest.frameHashes.length === hashes.length && video.manifest.frameHashes.every((h, i) => h === hashes[i]);
        collectDiagnostics(diagnostics, video.diagnostics);
      }

      const parallel: { workers: number; fps: number | null; note?: string } = requestedWorkers > 1 ? await measureParallel(env, project, dir, frames, requestedWorkers) : { workers: 1, fps: null };
      usage = await monitor.stop();
      const totalMs = times.reduce((a, b) => a + b, 0);
      return {
        scenario: options.scenario,
        resolution: options.resolution,
        width: res.width,
        height: res.height,
        fps: res.fps,
        frames,
        framesPerSecond: totalMs > 0 ? (frames * 1000) / totalMs : 0,
        frameMs: summarize(times),
        startupMs,
        cpuPercent: usage.cpuPercent,
        cpuSeconds: usage.cpuSeconds,
        cpuScope: usage.cpuScope,
        peakRssMb: usage.peakRssMb,
        rssScope: usage.rssScope,
        gpu: usage.gpu,
        cacheHitRatio,
        encoding,
        audioSeconds,
        workers: parallel.workers,
        parallelFramesPerSecond: parallel.fps,
        ...(parallel.note !== undefined ? { workersNote: parallel.note } : {}),
        frameHashes: hashes,
        deterministic,
        diagnostics: [...diagnostics.values()],
        machine,
      };
    } finally {
      if (usage === undefined) await monitor.stop();
      await env.dispose();
    }
  } finally {
    if (options.workDir === undefined) await rm(dir, { recursive: true, force: true });
  }
}

/** Eingaben für {@link runSuite}. */
export interface SuiteOptions {
  readonly scenarios?: readonly ScenarioId[];
  readonly resolutions?: readonly ResolutionId[];
  readonly frames?: number;
  readonly workers?: number;
  readonly encode?: boolean;
  /** Wird nach jedem Szenario aufgerufen (Fortschritt). */
  readonly onResult?: (result: BenchmarkResult) => void;
  /** Wird nach jeder abgebrochenen Messung aufgerufen. */
  readonly onFailure?: (failure: BenchmarkFailure) => void;
  /**
   * Jede Messung in einem eigenen Node-Prozess (Standard `false`). Das trennt Speicher, Startzeit
   * und WASM-Zustand der Messungen. Braucht das gebaute Paket (`dist/child.js`).
   */
  readonly isolate?: boolean;
}

/** Ein Szenario, dessen Messung mit einem Fehler abbrach. */
export interface BenchmarkFailure {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly code: string;
  readonly problem: string;
}

const CHILD = fileURLToPath(new URL('./child.js', import.meta.url));

function isBenchmarkResult(value: unknown): value is BenchmarkResult {
  return isRecord(value) && typeof value['scenario'] === 'string' && typeof value['framesPerSecond'] === 'number' && isRecord(value['machine']);
}

/**
 * Führt eine Messung in einem eigenen Node-Prozess aus (`dist/child.js`).
 *
 * @example
 * ```ts
 * const r = await runIsolated({ scenario: 'mixed', resolution: '4k30', frames: 5 });
 * ```
 */
export async function runIsolated(options: BenchmarkOptions): Promise<BenchmarkResult> {
  if (!existsSync(CHILD)) {
    throw new OpenVideoError({ code: 'OV_BENCH_CHILD_MISSING', errorClass: 'BenchmarkError', problem: `The benchmark child ${CHILD} does not exist.`, suggestions: ['Build the package with `npx tsc -b packages/benchmarks`.', 'Or run without isolate.'] });
  }
  const dir = await mkdtemp(join(tmpdir(), 'ov-bench-child-'));
  const out = join(dir, 'result.json');
  try {
    const stderr = await new Promise<string>((resolvePromise) => {
      execFile(process.execPath, [CHILD, JSON.stringify(options), out], { maxBuffer: 64 * 2 ** 20 }, (_error, _stdout, err) => {
        resolvePromise(err);
      });
    });
    if (!existsSync(out)) {
      throw new OpenVideoError({ code: 'OV_BENCH_CHILD_CRASH', errorClass: 'BenchmarkError', problem: `The benchmark process for ${options.scenario} ${options.resolution} ended without a result: ${stderr.trim().slice(-500)}`, suggestions: ['Run the scenario alone with --scenario and --resolution to see the full error.'] });
    }
    const parsed: unknown = JSON.parse(await readFile(out, 'utf8'));
    if (isRecord(parsed) && isBenchmarkResult(parsed['result'])) return parsed['result'];
    const e = isRecord(parsed) && isRecord(parsed['error']) ? parsed['error'] : {};
    throw new OpenVideoError({ code: typeof e['code'] === 'string' ? e['code'] : 'OV_BENCH_CHILD_CRASH', errorClass: 'BenchmarkError', problem: typeof e['problem'] === 'string' ? e['problem'] : 'The benchmark process returned no result.', suggestions: ['Run the scenario alone with --scenario and --resolution to see the full error.'] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Ergebnis von {@link runSuite}. */
export interface SuiteResult {
  readonly machine: MachineInfo;
  readonly results: readonly BenchmarkResult[];
  /** Abgebrochene Messungen; die übrigen Szenarien laufen trotzdem. */
  readonly failures: readonly BenchmarkFailure[];
  readonly markdown: string;
}

/**
 * Misst alle gewählten Szenarien in allen gewählten Auflösungen nacheinander.
 *
 * @example
 * ```ts
 * const suite = await runSuite({ resolutions: ['1080p30'], frames: 5 });
 * process.stdout.write(suite.markdown);
 * ```
 */
export async function runSuite(options: SuiteOptions = {}): Promise<SuiteResult> {
  const results: BenchmarkResult[] = [];
  const failures: BenchmarkFailure[] = [];
  for (const scenario of options.scenarios ?? SCENARIOS) {
    for (const resolution of options.resolutions ?? RESOLUTION_IDS) {
      const input: BenchmarkOptions = { scenario, resolution, ...(options.frames !== undefined ? { frames: options.frames } : {}), ...(options.workers !== undefined ? { workers: options.workers } : {}), ...(options.encode !== undefined ? { encode: options.encode } : {}) };
      try {
        const r = options.isolate === true ? await runIsolated(input) : await runBenchmark(input);
        results.push(r);
        options.onResult?.(r);
      } catch (error) {
        // Ein kaputtes Szenario darf die übrigen Messungen nicht verhindern; der Fehler steht im Ergebnis.
        if (!(error instanceof OpenVideoError)) throw error;
        const failure = { scenario, resolution, code: error.diagnostic.code, problem: error.diagnostic.problem };
        failures.push(failure);
        options.onFailure?.(failure);
      }
    }
  }
  const failureLines = failures.map((f) => `- ${f.scenario} ${f.resolution}: ${f.code} ${f.problem}`);
  return { machine: describeMachine(), results, failures, markdown: formatMarkdown(results) + (failureLines.length > 0 ? `\nFehlgeschlagen:\n\n${failureLines.join('\n')}\n` : '') };
}

function fixed(value: number | null, digits = 1): string {
  return value === null ? '–' : value.toFixed(digits);
}

/**
 * Formatiert Ergebnisse als Markdown-Tabelle.
 *
 * @example
 * ```ts
 * process.stdout.write(formatMarkdown(suite.results));
 * ```
 */
export function formatMarkdown(results: readonly BenchmarkResult[]): string {
  const head = '| Szenario | Auflösung | Frames | fps | Mittel ms | p50 ms | p95 ms | Start ms | CPU % | Spitzen-RAM MB | GPU % | Cache-Treffer | Encoder fps | Worker |';
  const rule = '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = results.map((r) =>
    [
      r.scenario,
      r.resolution,
      String(r.frames),
      fixed(r.framesPerSecond, 2),
      fixed(r.frameMs.mean),
      fixed(r.frameMs.p50),
      fixed(r.frameMs.p95),
      fixed(r.startupMs, 0),
      fixed(r.cpuPercent, 0),
      fixed(r.peakRssMb, 0),
      r.gpu.utilizationPercent === null ? r.gpu.reason : fixed(r.gpu.utilizationPercent, 0),
      `${fixed(r.cacheHitRatio * 100, 0)} %`,
      fixed(r.encoding.framesPerSecond),
      r.parallelFramesPerSecond === null ? String(r.workers) : `${String(r.workers)} (${fixed(r.parallelFramesPerSecond, 2)} fps)`,
    ].join(' | '),
  );
  return [head, rule, ...rows.map((r) => `| ${r} |`)].join('\n') + '\n';
}

/** Ergebnis von {@link runAssetScaleBenchmark}. */
export interface AssetScaleResult {
  readonly assets: number;
  /** Zeit für die Umgebung inklusive Auflösen aller Assets in Millisekunden. */
  readonly resolveMs: number;
  /** Zeit für den ersten Frame in Millisekunden. */
  readonly frameMs: number;
  readonly frameHash: string;
  readonly diagnostics: readonly BenchmarkDiagnostic[];
}

/**
 * Misst ein Projekt mit vielen kleinen PNG-Assets: Auflösen und ersten Frame.
 *
 * @example
 * ```ts
 * const r = await runAssetScaleBenchmark({ count: 1000 });
 * console.log(r.resolveMs, r.frameMs);
 * ```
 */
export async function runAssetScaleBenchmark(options: { readonly count?: number; readonly workDir?: string } = {}): Promise<AssetScaleResult> {
  const count = Math.max(1, Math.floor(options.count ?? 1000));
  const dir = options.workDir ?? (await mkdtemp(join(tmpdir(), 'ov-bench-assets-')));
  try {
    const project = await buildManyAssetsProject(dir, count);
    const t0 = performance.now();
    const env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new FileStore(join(dir, '.openvideo', 'cache'))), skipDefaultProviders: true });
    try {
      const resolveMs = performance.now() - t0;
      const diagnostics = new Map<string, BenchmarkDiagnostic>();
      collectDiagnostics(diagnostics, env.assetDiagnostics);
      collectDiagnostics(diagnostics, checkProject(env, project));
      const t1 = performance.now();
      const frame = await renderFrame(env, project, { frame: 0 });
      const frameMs = performance.now() - t1;
      collectDiagnostics(diagnostics, frame.diagnostics);
      return { assets: env.assets.all().length, resolveMs, frameMs, frameHash: imageHash(frame.image), diagnostics: [...diagnostics.values()] };
    } finally {
      await env.dispose();
    }
  } finally {
    if (options.workDir === undefined) await rm(dir, { recursive: true, force: true });
  }
}
