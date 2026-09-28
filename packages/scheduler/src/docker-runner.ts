/**
 * Chunk-Runner mit Docker-Containern (FR-66, ADR 0008): kein Netz, keine Host-Mounts,
 * Projekt über stdin, Frames über stdout zurück in den Cache des Aufrufers.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import type { Cache } from '@agentic-video/cache';
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
}

/** Optionen für {@link createDockerChunkRunner}. */
export interface DockerChunkRunnerOptions {
  /** Worker-Image; sein Entrypoint ist `openvideo-worker`. */
  readonly image: string;
  readonly concurrency?: number;
  readonly limits?: ContainerLimits;
  readonly projectDir: string;
  readonly project: Readonly<Record<string, unknown>>;
  /** Cache des Aufrufers; empfangene Frames landen hier. */
  readonly cache: Cache;
  readonly telemetry: Telemetry;
  readonly maxAttempts?: number;
  /** Docker-Programm (Standard `docker`). */
  readonly docker?: string;
  readonly onEvent?: (event: SchedulerEvent) => void;
}

/**
 * Baut die Argumente für `docker run` eines Workers (ohne Netz, read-only, ohne Capabilities).
 *
 * @example
 * ```ts
 * const args = dockerRunArgs('openvideo/worker:1', 'ov-worker-1', { memory: '2g', cpus: 1 });
 * ```
 */
export function dockerRunArgs(image: string, name: string, limits: ContainerLimits = {}): string[] {
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
    '-e',
    `OPENVIDEO_CONTAINER_IMAGE=${image}`,
    image,
    '--stdio',
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
  return async (chunks, onDone) => {
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
          args: dockerRunArgs(options.image, container, options.limits),
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
    });
  };
}
