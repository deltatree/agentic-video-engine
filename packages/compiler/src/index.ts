/**
 * @packageDocumentation
 * TSX → Composition IR: Bündeln mit esbuild, Auswerten in der Sandbox, JSON-Export
 * und AST-Rückschreiben von Patches in die TSX-Quelle.
 *
 * @example
 * ```ts
 * import { compileTsx, exportJson, applyPatchesToSource } from '@agentic-video/compiler';
 * const { project } = await compileTsx('video.tsx', { projectDir: process.cwd() });
 * await writeFile('video.json', exportJson(project));
 * ```
 */
export { BUNDLE_FILENAME, COMPILER_VERSION, bundleTsx, compileTsx, compiledCacheKey, mapStack, type Bundle, type CompileOptions, type CompileResult, type CompiledStore, type SourcePosition } from './compile.js';
export { exportJson } from './export.js';
export { applyPatchesToSource, nodeToJsx, toLiteral, type RoundtripOptions, type RoundtripResult } from './roundtrip.js';
