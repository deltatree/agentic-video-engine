/**
 * @packageDocumentation
 * Asset Pipeline von OpenVideo (FR-48..FR-51): Formaterkennung, Metadaten, Normalisierung,
 * inhaltsadressierter Cache, kontrollierter Fetcher und Asset-Resolver für die Renderer.
 *
 * @example
 * ```ts
 * import { importAsset, resolveProjectAssets } from '@agentic-video/assets';
 * const imported = await importAsset(dir, { path: 'logo.svg' }, { cache });
 * const assets = await resolveProjectAssets(dir, project, { cache });
 * ```
 */
export * from './detect.js';
export * from './fetcher.js';
export * from './inspect.js';
export * from './pipeline.js';
