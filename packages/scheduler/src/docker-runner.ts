/**
 * Chunk-Runner mit Docker-Containern (FR-66, ADR 0008): kein Netz, keine Host-Mounts,
 * Projekt über stdin, Frames über stdout zurück in den Cache des Aufrufers.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import type { Cache } from '@agentic-video/cache';
import { OpenVideoError } from '@agentic-video/core';
import type { ChunkRunner } from '@agentic-video/render';
import type { Telemetry } from '@agentic-video/telemetry';
import { collectProjectFiles } from './files.js';
import { runPool, type SchedulerEvent } from './pool.js';
import type { ProjectFile } from './protocol.js';

/** Ressourcen-Grenzen je Container. */
export interface ContainerLimits {
  /** Speichergrenze im Docker-Format (Standard `2g`). */
  readonly memory?: string;
  /** CPU-Anteil (Standard 1). */
  readonly cpus?: number;
  /**
   * GPU-Quota (Story 21.3): `all`, eine Anzahl (`2`, wie bei Docker) oder Geräte (`device=0`,
   * `device=0,1`, `0,1`, `GPU-<uuid>`). Wird zu `docker run --gpus …` (NVIDIA Container Toolkit). Ohne Angabe
   * bekommt der Container keine GPU.
   */
  readonly gpus?: string;
}

/** Zusätzliche Einstellungen eines Worker-Containers. */
export interface DockerWorkerSettings {
  /**
   * Browser-Renderer im Container auf der GPU (`OPENVIDEO_BROWSER_GPU=1`, T5). Nur mit `gpus`
   * sinnvoll; ohne GPU fällt Chromium sonst auf Software zurück.
   */
  readonly browserGpu?: boolean;
  /**
   * Argumente nach dem Image (Standard `['--stdio']` für das Image `openvideo-worker`, dessen
   * Einstieg `openvideo-worker` ist). Für Images mit Einstieg `openvideo` (z. B. `openvideo-render-gpu`):
   * `['worker', '--stdio']`.
   */
  readonly command?: readonly string[];
}

/**
 * Prüft und normalisiert eine GPU-Angabe für `docker run --gpus`.
 * Gerätelisten mit Komma braucht Docker in Anführungszeichen (`"device=0,1"`, CSV-Syntax);
 * da ohne Shell gestartet wird, stehen sie wörtlich im Argument.
 *
 * @example
 * ```ts
 * dockerGpusArg('all'); // 'all'
 * dockerGpusArg('0,1'); // '"device=0,1"'
 * dockerGpusArg('device=2'); // 'device=2'
 * ```
 */
export function dockerGpusArg(gpus: string): string {
  const value = gpus.trim();
  if (value === 'all' || /^[1-9][0-9]{0,2}$/u.test(value)) return value;
  const devices = value.startsWith('device=') ? value.slice('device='.length) : value;
  const list = devices.replace(/^"|"$/gu, '').split(',').map((d) => d.trim());
  // Eine einzelne Zahl ohne `device=` ist bei Docker eine Anzahl; `0` wäre „keine GPU“.
  if (!value.startsWith('device=') && list.length === 1) list.length = 0;
  if (list.length === 0 || list.some((d) => !/^(?:[0-9]{1,3}|GPU-[0-9a-fA-F-]{8,64}|MIG-[0-9a-zA-Z/-]{4,80})$/u.test(d))) {
    throw new OpenVideoError({
      code: 'OV_SCHEDULER_GPUS',
      errorClass: 'SchedulerError',
      problem: `"${gpus}" is not a valid GPU quota for docker run --gpus.`,
      suggestions: ['Use "all", a count such as "1", or device indices such as "device=0" or "0,1".', 'GPU UUIDs from `nvidia-smi -L` work too: "GPU-…".'],
    });
  }
  return list.length === 1 ? `device=${list[0] ?? ''}` : `"device=${list.join(',')}"`;
}

/** Optionen für {@link createDockerChunkRunner}. */
export interface DockerChunkRunnerOptions {
  /** Worker-Image; sein Entrypoint ist `openvideo-worker`. */
  readonly image: string;
  readonly concurrency?: number;
  readonly limits?: ContainerLimits;
  /** GPU-Modus des Browser-Renderers und Befehl im Container. */
  readonly worker?: DockerWorkerSettings;
  readonly projectDir: string;
  readonly project: Readonly<Record<string, unknown>>;
  /** Cache des Aufrufers; empfangene Frames landen hier. */
  readonly cache: Cache;
  readonly telemetry: Telemetry;
  readonly maxAttempts?: number;
  /** Docker-Programm (Standard `docker`). */
  readonly docker?: string;
  readonly onEvent?: (event: SchedulerEvent) => void;
  /** Höchstdauer eines Chunk-Versuchs in Millisekunden; danach Neustart des Workers und Wiederholung (Story 18.8). */
  readonly chunkTimeoutMs?: number;
}

/**
 * Baut die Argumente für `docker run` eines Workers (ohne Netz, read-only, ohne Capabilities).
 * Mit `limits.gpus` kommen `--gpus …` und `NVIDIA_DRIVER_CAPABILITIES` (inklusive `graphics` für
 * Chromium/Vulkan) dazu; `worker.browserGpu` setzt `OPENVIDEO_BROWSER_GPU=1` im Container.
 *
 * @example
 * ```ts
 * const args = dockerRunArgs('openvideo/worker:1', 'ov-worker-1', { memory: '2g', cpus: 1 });
 * const gpu = dockerRunArgs('ghcr.io/deltatree/openvideo-render-gpu:0.1.0', 'ov-gpu-1', { gpus: 'device=0' }, { browserGpu: true, command: ['worker', '--stdio'] });
 * ```
 */
export function dockerRunArgs(image: string, name: string, limits: ContainerLimits = {}, worker: DockerWorkerSettings = {}): string[] {
  const gpus = limits.gpus !== undefined && limits.gpus.trim() !== '' ? dockerGpusArg(limits.gpus) : undefined;
  return [
    'run',
    '-i',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=2g',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    limits.memory ?? '2g',
    '--cpus',
    String(limits.cpus ?? 1),
    '--user',
    '65534:65534',
    ...(gpus !== undefined ? ['--gpus', gpus, '-e', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics'] : []),
    '-e',
    `OPENVIDEO_CONTAINER_IMAGE=${image}`,
    ...(worker.browserGpu === true ? ['-e', 'OPENVIDEO_BROWSER_GPU=1'] : []),
    image,
    ...(worker.command ?? ['--stdio']),
  ];
}

/**
 * Erzeugt einen {@link ChunkRunner}, der Chunks in Docker-Containern rendert (Stream-Modus).
 *
 * @example
 * ```ts
 * const runChunks = createDockerChunkRunner({ image: 'openvideo/worker:0.1.0', concurrency: 2, projectDir, project, cache: env.cache, telemetry: env.telemetry });
 * await renderVideo(env, project, { outPath: 'out/video.mp4', profile, runChunks });
 * ```
 */
export function createDockerChunkRunner(options: DockerChunkRunnerOptions): ChunkRunner {
  const docker = options.docker ?? 'docker';
  const concurrency = Math.max(1, options.concurrency ?? availableParallelism());
  const run = randomUUID().slice(0, 8);
  return async (chunks, onDone, runOptions) => {
    const files: ProjectFile[] = await collectProjectFiles(options.projectDir);
    return runPool(chunks, onDone, {
      concurrency,
      maxAttempts: options.maxAttempts ?? 3,
      telemetry: options.telemetry,
      cache: options.cache,
      launch: (slot, generation) => {
        const container = `openvideo-worker-${run}-${String(slot + 1)}-${String(generation)}`;
        return {
          id: `docker-${String(slot + 1)}.${String(generation)}`,
          command: docker,
          args: dockerRunArgs(options.image, container, options.limits, options.worker),
          container,
          // Stirbt der docker-Client, könnte der Container weiterlaufen: immer entfernen.
          cleanup: () => {
            const rm = spawn(docker, ['rm', '-f', container], { stdio: 'ignore' });
            rm.on('error', (error) => {
              options.telemetry.logger.warn('docker rm failed', { container, reason: error.message });
            });
          },
        };
      },
      init: (worker) => ({ type: 'init', mode: 'stream', worker, project: options.project, files, options: { offline: true } }),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      ...(options.chunkTimeoutMs !== undefined ? { chunkTimeoutMs: options.chunkTimeoutMs } : {}),
      ...(runOptions?.signal !== undefined ? { signal: runOptions.signal } : {}),
    });
  };
}
