/**
 * @packageDocumentation
 * Kommandozeile und lokale Dienste von OpenVideo.
 *
 * @example
 * ```ts
 * import { createLocalServices } from '@agentic-video/cli';
 * const services = await createLocalServices({ workspaceDir: '/tmp/ws' });
 * ```
 */
export * from './services.js';
export * from './cli.js';
export * from './project.js';
export * from './doctor.js';
export * from './sources.js';
export * from './stdin.js';
export * from './cache-clear.js';
export * from './ops.js';
export * from './watch.js';
export * from './browser.js';
