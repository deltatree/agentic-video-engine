/**
 * @packageDocumentation
 * Untertitel (FR-55, FR-56): Parser für SRT, WebVTT und ASS, Export als SRT und WebVTT,
 * Wortzeiten und der Makro-Node `subtitles`, der Cues in `rich-text`-Nodes übersetzt.
 * Isomorph: keine Node-APIs, nur `@agentic-video/core`.
 *
 * Zeiten in Cues sind Sekunden-Texte wie `"1.5s"` (siehe {@link secondsToTime}).
 *
 * @example
 * ```ts
 * import { parseSubtitles, registerSubtitles } from '@agentic-video/subtitles';
 * const { cues, diagnostics } = parseSubtitles(srtText);
 * registerSubtitles(registry);
 * ```
 */
export * from './time.js';
export * from './words.js';
export * from './parse.js';
export * from './format.js';
export * from './expander.js';
