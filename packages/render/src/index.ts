/**
 * @packageDocumentation
 * Render-Pipeline von OpenVideo (A21): Frame-Render, Compositing, Frame-Cache,
 * Audio, Encoding, Render-Manifest, Inspektion.
 *
 * @example
 * ```ts
 * import { createNodeEnvironment, renderVideo } from '@agentic-video/render';
 * const env = await createNodeEnvironment({ projectDir: '.', project });
 * await renderVideo(env, project, { outPath: 'out/video.mp4', profile: { format: 'mp4', codec: 'h264' } });
 * ```
 */
export * from './environment.js';
export * from './frame.js';
export * from './manifest.js';
export * from './video.js';
export * from './inspect.js';
export * from './version.js';
export * from './audio-engine.js';
export * from './node-env.js';
export * from './plugins.js';
