/**
 * @packageDocumentation
 * Chunk-Scheduler von OpenVideo (FR-66, FR-67, FR-92): verteilt Chunks dynamisch auf
 * Prozess-, Docker- und Remote-Worker, wiederholt fehlgeschlagene Chunks und führt
 * den Trace-Kontext über alle Worker mit.
 *
 * @example
 * ```ts
 * import { createProcessChunkRunner } from '@agentic-video/scheduler';
 * const runChunks = createProcessChunkRunner({ concurrency: 4, projectDir, project, cache: env.cache, telemetry: env.telemetry });
 * await renderVideo(env, project, { outPath: 'out/video.mp4', profile, runChunks });
 * ```
 */
export * from './protocol.js';
export * from './files.js';
export * from './pool.js';
export * from './process-runner.js';
export * from './docker-runner.js';
export * from './coordinator.js';
export * from './remote-runner.js';
export * from './keys.js';
