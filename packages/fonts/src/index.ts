/**
 * @packageDocumentation
 * Schriften für OpenVideo: gebündelte Standardschriften (Inter, JetBrains Mono,
 * Noto Color Emoji), Laden und Prüfen von Project-Schriften, Inhalts-Hashes,
 * Nutzungsprüfung und Render-Manifest.
 *
 * @example
 * ```ts
 * import { loadFontSet, checkFontUsage, fontManifest } from '@agentic-video/fonts';
 * const fonts = await loadFontSet({ projectDir: '.', fonts: project.fonts });
 * const diagnostics = [...fonts.diagnostics, ...checkFontUsage(project, fonts)];
 * const manifest = fontManifest(fonts);
 * ```
 */
export * from './sfnt.js';
export * from './woff.js';
export * from './font-set.js';
export * from './usage.js';
