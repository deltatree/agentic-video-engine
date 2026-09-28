/**
 * @packageDocumentation
 * Container-Sandbox für nicht vertrauenswürdigen Code (ADR 0008).
 *
 * @example
 * ```ts
 * import { runSandboxed, sandboxAvailable } from '@agentic-video/sandbox';
 * if ((await sandboxAvailable()).available) {
 *   const r = await runSandboxed({ code: '1 + 1' });
 *   r.output; // 2
 * }
 * ```
 */
export { DEFAULT_LIMITS, SANDBOX_IMAGE, dockerRunArgs, runSandboxed, sandboxAvailable, type SandboxLimits, type SandboxMode, type SandboxRequest, type SandboxResult } from './sandbox.js';
export { RESULT_MARK } from './bootstrap.js';
