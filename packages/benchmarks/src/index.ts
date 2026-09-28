/**
 * @packageDocumentation
 * Reproduzierbare Benchmarks (A38, FR-94, SM-4): Szenarien, Auflösungen, Messwerte,
 * Regressionserkennung gegen eine Basis derselben Maschine.
 *
 * @example
 * ```ts
 * import { runBenchmark } from '@agentic-video/benchmarks';
 * const r = await runBenchmark({ scenario: 'mixed', resolution: '1080p30', frames: 10 });
 * ```
 */
export * from './scenarios.js';
export * from './metrics.js';
export * from './run.js';
export * from './baseline.js';
