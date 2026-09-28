/**
 * @packageDocumentation
 * Agent API von OpenVideo (FR-21..FR-23, AD-9): ein Register aller Operationen,
 * Workspace, Render-Jobs und ein HTTP-Server. MCP und CLI nutzen dasselbe Register.
 *
 * @example
 * ```ts
 * import { OPERATIONS, invokeOperation } from '@agentic-video/agent';
 * const r = await invokeOperation(OPERATIONS, 'timeline.inspect', { projectId: 'demo' }, { services, via: 'cli' });
 * ```
 */
export * from './operation.js';
export * from './services.js';
export * from './workspace.js';
export * from './jobs.js';
export * from './operations.js';
export * from './server.js';
