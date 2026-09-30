/**
 * @packageDocumentation
 * Sprache (FR-57..FR-59): lokale Voice-Provider (Piper, espeak-ng, Kommando),
 * ASR-Provider (whisper.cpp, Kommando), Synthese und Transkription mit Cache.
 *
 * Provider sind lose gekoppelt: Sie erfüllen `VoiceProvider` bzw. `AsrProvider` aus
 * `@agentic-video/core` und werden über die `Registry` gefunden. Alle Audio-Ausgaben
 * sind WAV, 16 Bit, mono, 48 kHz.
 *
 * @example
 * ```ts
 * import { createPiperProvider, registerSpeechProviders, synthesizeVoices } from '@agentic-video/speech';
 * await registerSpeechProviders(registry, { voice: [createPiperProvider({ model })] });
 * const voices = await synthesizeVoices(project, { registry, cache, outDir: '.openvideo/voices' });
 * ```
 */
export * from './process.js';
export * from './wav.js';
export * from './words.js';
export * from './voice.js';
export * from './asr.js';
export * from './synthesize.js';
export * from './from-audio.js';
