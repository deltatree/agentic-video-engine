/**
 * @packageDocumentation
 * Render-Worker von OpenVideo: Chunk-Protokoll über stdio (Prozess, Docker) und
 * HTTP-Pull (Remote, Kubernetes). Der Trace-Kontext des Aufrufers wird fortgesetzt.
 *
 * @example
 * ```ts
 * import { runWorkerStdio } from '@agentic-video/worker';
 * await runWorkerStdio();
 * ```
 */
export * from './protocol.js';
export * from './stdio.js';
export * from './http.js';
export { toDiagnostic, workerTelemetry, writeTempProject, type TempProject } from './workspace.js';
