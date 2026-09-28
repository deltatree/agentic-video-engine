/**
 * Chunk-Runner mit lokalen Node-Prozessen (FR-66): Worker teilen Projektordner und Datei-Cache.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FileStore, TieredStore, type Cache, type ContentStore } from '@agentic-video/cache';
import { OpenVideoError } from '@agentic-video/core';
import type { ChunkRunner } from '@agentic-video/render';
import type { Telemetry } from '@agentic-video/telemetry';
import { runPool, type SchedulerEvent } from './pool.js';

/** Optionen für {@link createProcessChunkRunner}. */
export interface ProcessChunkRunnerOptions {
  /** Anzahl Worker-Prozesse (Standard: Anzahl CPU-Kerne). */
  readonly concurrency?: number;
  readonly projectDir: string;
  /** Projekt-IR (bei TSX-Projekten die kompilierte IR). */
  readonly project: Readonly<Record<string, unknown>>;
  /** Cache des Aufrufers; sein lokaler Speicher muss ein `FileStore` sein. */
  readonly cache: Cache;
  readonly telemetry: Telemetry;
  /** Versuche je Chunk (Standard 3). */
  readonly maxAttempts?: number;
  readonly trusted?: boolean;
  /** Befehl, der den Worker startet (Standard: `node <@agentic-video/worker>/dist/bin.js`). `--stdio` wird angehängt. */
  readonly workerCommand?: readonly string[];
  readonly onEvent?: (event: SchedulerEvent) => void;
}

/** Findet das lokale Verzeichnis eines Speichers (auch als lokale Stufe eines `TieredStore`). */
export function fileStoreRoot(store: ContentStore): string | undefined {
  if (store instanceof FileStore) return store.root;
  if (store instanceof TieredStore) return fileStoreRoot(store.local);
  return undefined;
}

/**
 * Findet das Worker-Programm des Pakets `@agentic-video/worker`.
 *
 * Der Scheduler importiert den Worker nicht (AD-14: `worker` hängt von `scheduler` ab);
 * er startet ihn nur als eigenen Prozess.
 *
 * @example
 * ```ts
 * const [node, bin] = defaultWorkerCommand();
 * ```
 */
export function defaultWorkerCommand(): string[] {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve('@agentic-video/worker');
  } catch (error) {
    throw new OpenVideoError({
      code: 'OV_SCHEDULER_WORKER_MISSING',
      errorClass: 'SchedulerError',
      problem: 'The package @agentic-video/worker is not installed.',
      suggestions: ['Install @agentic-video/worker next to @agentic-video/scheduler.', 'Pass workerCommand, e.g. ["openvideo-worker"].'],
      cause: error,
    });
  }
  const bin = join(dirname(entry), 'bin.js');
  if (!existsSync(bin)) {
    throw new OpenVideoError({
      code: 'OV_SCHEDULER_WORKER_MISSING',
      errorClass: 'SchedulerError',
      problem: `The worker program ${bin} does not exist.`,
      suggestions: ['Build the worker with `npx tsc -b packages/worker`.'],
    });
  }
  return [process.execPath, bin];
}

/**
 * Erzeugt einen {@link ChunkRunner}, der Chunks auf N lokalen Worker-Prozessen rendert.
 *
 * @example
 * ```ts
 * const runChunks = createProcessChunkRunner({ concurrency: 4, projectDir, project, cache: env.cache, telemetry: env.telemetry });
 * await renderVideo(env, project, { outPath: 'out/video.mp4', profile, runChunks });
 * ```
 */
export function createProcessChunkRunner(options: ProcessChunkRunnerOptions): ChunkRunner {
  const cacheDir = fileStoreRoot(options.cache.store);
  if (cacheDir === undefined) {
    throw new OpenVideoError({
      code: 'OV_SCHEDULER_STORE_UNSUPPORTED',
      errorClass: 'SchedulerError',
      problem: `Process workers need a file cache they can share, but the cache store is ${options.cache.store.name}.`,
      suggestions: ['Create the cache with `createCache(new FileStore(dir))` or `storeFromEnv(process.env, projectDir)`.', 'Use createDockerChunkRunner, which streams frames back instead.'],
    });
  }
  const projectDir = resolve(options.projectDir);
  const absoluteCache = resolve(cacheDir);
  const concurrency = Math.max(1, options.concurrency ?? availableParallelism());
  return (chunks, onDone) => {
    const command = options.workerCommand ?? defaultWorkerCommand();
    const [file, ...args] = command;
    if (file === undefined) {
      return Promise.reject(new OpenVideoError({ code: 'OV_SCHEDULER_WORKER_MISSING', errorClass: 'SchedulerError', problem: 'workerCommand is empty.', suggestions: ['Pass e.g. ["openvideo-worker"].'] }));
    }
    return runPool(chunks, onDone, {
      concurrency,
      maxAttempts: options.maxAttempts ?? 3,
      telemetry: options.telemetry,
      cache: options.cache,
      launch: (slot, generation) => ({ id: `process-${String(slot + 1)}.${String(generation)}`, command: file, args: [...args, '--stdio'] }),
      init: (worker) => ({ type: 'init', mode: 'shared', worker, project: options.project, projectDir, cacheDir: absoluteCache, options: { ...(options.trusted !== undefined ? { trusted: options.trusted } : {}) } }),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    });
  };
}
