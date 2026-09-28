/**
 * @packageDocumentation
 * Deterministische Offline-Audio-Engine von OpenVideo: Dekodieren über FFmpeg, Mix, EQ,
 * Dynamik, Ducking, Lautheit nach BS.1770-4 und WAV-Ausgabe in reinem TypeScript.
 *
 * @example
 * ```ts
 * import { masterAudio, mixComposition, writeWav } from '@agentic-video/audio';
 * const mix = await mixComposition({ tracks, resolveSource, fps: 30, durationFrames: 300 });
 * await writeWav(masterAudio(mix, { loudness: -16 }), 'out/mix.wav', { bitDepth: 24 });
 * ```
 */
export * from './decode.js';
export * from './dsp.js';
export * from './loudness.js';
export * from './mix.js';
export * from './wav.js';
