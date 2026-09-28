/**
 * @packageDocumentation
 * FFmpeg-Medienschicht von OpenVideo: Suche, Capabilities, Inspektion, frame-genaues Lesen,
 * deterministisches Encoding und Zusammenfügen von Segmenten. FFmpeg wird nie gebündelt;
 * die Suche folgt `ffmpegPath` → `OPENVIDEO_FFMPEG` → `PATH`.
 *
 * @example
 * ```ts
 * import { createEncoder, probeMedia } from '@agentic-video/ffmpeg';
 * const enc = createEncoder({ output: 'out.mp4', format: 'mp4', width: 640, height: 360, fps: 30 });
 * await enc.write(frame);
 * const result = await enc.finish();
 * const info = await probeMedia(result.paths[0] ?? 'out.mp4');
 * ```
 */
export * from './process.js';
export * from './locate.js';
export * from './capabilities.js';
export * from './pixels.js';
export * from './probe.js';
export * from './reader.js';
export * from './encoder.js';
