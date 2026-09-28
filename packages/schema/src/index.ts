/**
 * @packageDocumentation
 * Composition IR von OpenVideo: Typen, JSON Schema, Validierung und Migration.
 *
 * @example
 * ```ts
 * import { validateProject, formatDiagnostic } from '@agentic-video/schema';
 * const result = validateProject(project);
 * for (const d of result.diagnostics) console.log(formatDiagnostic(d));
 * ```
 */
export * from './diagnostics.js';
export * from './version.js';
export * from './primitives.js';
export * from './nodes.js';
export * from './project.js';
export * from './validator.js';
export * from './validate.js';
export * from './json-schema.js';
export * from './migrate.js';
export * from './types.js';
