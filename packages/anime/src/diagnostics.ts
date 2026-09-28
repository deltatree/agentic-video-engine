/**
 * Diagnosen des Anime-Adapters.
 */
import type { Diagnostic } from '@agentic-video/core';

/** Code jeder Diagnose, die einen Informationsverlust meldet. */
export const LOSSY_CODE = 'OV_IMPORT_LOSSY';

/**
 * Verlust-Diagnose (`OV_IMPORT_LOSSY`, `warning`).
 *
 * @example
 * ```ts
 * lossy('timeline[0].rotateX', '3D rotation is not supported.', 'Use a scene3d node.');
 * ```
 */
export function lossy(path: string, problem: string, suggestion: string, nodeId?: string): Diagnostic {
  return { code: LOSSY_CODE, severity: 'warning', errorClass: 'AnimeAdapterError', problem, path, ...(nodeId !== undefined ? { nodeId } : {}), suggestions: [suggestion] };
}

/**
 * Hinweis ohne Verlust (`info`).
 *
 * @example
 * ```ts
 * note('OV_ANIME_IGNORED', 'timeline[0].autoplay', 'autoplay is ignored: OpenVideo owns the clock.', 'Remove autoplay.');
 * ```
 */
export function note(code: string, path: string, problem: string, suggestion: string): Diagnostic {
  return { code, severity: 'info', errorClass: 'AnimeAdapterError', problem, path, suggestions: [suggestion] };
}
