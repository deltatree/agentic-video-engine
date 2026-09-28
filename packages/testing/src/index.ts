/**
 * @packageDocumentation
 * Testwerkzeuge von OpenVideo: Golden Images, Pixel-Diff, Bild-Hashes, Testbilder,
 * Audio-Analyse (RMS, Peak, Lautheit nach BS.1770-4, Onsets) und Determinismus-Prüfung.
 *
 * @example
 * ```ts
 * import { expectGolden, integratedLoudness } from '@agentic-video/testing';
 * expectGolden(frame, 'test/golden/title.png');
 * ```
 */
export { compareImages, imageHash, solidImage, checkerImage, type CompareOptions, type CompareResult } from './images.js';
export { expectGolden } from './golden.js';
export { rms, peak, integratedLoudness, findOnsets, type LoudnessOptions, type OnsetOptions } from './audio.js';
export { determinism, type DeterminismResult } from './determinism.js';
