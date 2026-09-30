#!/usr/bin/env node
/**
 * Kommandozeile `openvideo-bench`: misst Szenarien, schreibt oder vergleicht die Basis.
 *
 * Exit-Codes: 0 = fertig ohne Regression, 1 = Regression gefunden, 2 = falsche Eingabe, Fehler oder abgebrochenes Szenario.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OpenVideoError } from '@agentic-video/core';
import { compareToBaseline, formatRegression, mergeBaseline, parseBaseline, parseTolerances } from './baseline.js';
import { runSuite } from './run.js';
import { RESOLUTION_IDS, SCENARIOS, isResolutionId, isScenarioId, type ResolutionId, type ScenarioId } from './scenarios.js';

const BASELINE_PATH = fileURLToPath(new URL('../baseline.json', import.meta.url));

const USAGE = `openvideo-bench [options]

  --scenario <ids>     Comma-separated scenarios or "all" (${SCENARIOS.join(', ')})
  --resolution <ids>   Comma-separated resolutions or "all" (${RESOLUTION_IDS.join(', ')}); default 1080p30
  --frames <n>         Frames per scenario (default 10)
  --workers <n>        Worker processes for the throughput run (default 1)
  --no-encode          Skip the MP4 encoding stage
  --json               Print JSON instead of a Markdown table
  --baseline <file>    Baseline file (default ${BASELINE_PATH})
  --update-baseline    Merge the results into the baseline file
  --compare            Compare fps, peak RAM, startup, encoder fps and cache ratio with the
                       baseline; exit code 1 on a regression
  --tolerance <x>      Allowed fps loss for --compare (default 0.2)
  --tolerances <list>  Per-metric tolerances, e.g. fps=0.2,peakRssMb=0.25,startupMs=0.5,
                       encodingFps=0.25,cacheHitRatio=0.05 (cache ratio in absolute points)
  --require-comparison With --compare: exit code 2 when nothing could be compared
                       (e.g. baseline from another machine)
`;

function list<T extends string>(raw: string | undefined, all: readonly T[], fallback: readonly T[], guard: (v: string) => v is T, what: string): T[] {
  if (raw === undefined) return [...fallback];
  if (raw === 'all') return [...all];
  return raw.split(',').map((v) => {
    const id = v.trim();
    if (!guard(id)) throw new OpenVideoError({ code: 'OV_BENCH_ARGUMENT', errorClass: 'BenchmarkError', problem: `Unknown ${what} "${id}".`, suggestions: [`Use one of: ${all.join(', ')}, or "all".`] });
    return id;
  });
}

function positive(raw: string | undefined, fallback: number, what: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new OpenVideoError({ code: 'OV_BENCH_ARGUMENT', errorClass: 'BenchmarkError', problem: `--${what} must be a positive number, got "${raw}".`, suggestions: [`Pass e.g. --${what} 10.`] });
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      resolution: { type: 'string' },
      frames: { type: 'string' },
      workers: { type: 'string' },
      'no-encode': { type: 'boolean' },
      json: { type: 'boolean' },
      'update-baseline': { type: 'boolean' },
      compare: { type: 'boolean' },
      tolerance: { type: 'string' },
      tolerances: { type: 'string' },
      baseline: { type: 'string' },
      'require-comparison': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const baselinePath = values.baseline ?? BASELINE_PATH;
  const scenarios: ScenarioId[] = list(values.scenario, SCENARIOS, SCENARIOS, isScenarioId, 'scenario');
  const resolutions: ResolutionId[] = list(values.resolution, RESOLUTION_IDS, ['1080p30'], isResolutionId, 'resolution');
  const suite = await runSuite({
    scenarios,
    resolutions,
    frames: Math.floor(positive(values.frames, 10, 'frames')),
    workers: Math.floor(positive(values.workers, 1, 'workers')),
    encode: values['no-encode'] !== true,
    // Jede Messung in eigenem Prozess: kein gemeinsamer WASM-Heap, saubere Start- und RAM-Werte.
    isolate: true,
    onResult: (r) => process.stderr.write(`${r.scenario} ${r.resolution}: ${r.framesPerSecond.toFixed(2)} fps\n`),
    onFailure: (f) => process.stderr.write(`${f.scenario} ${f.resolution}: FAILED ${f.code} ${f.problem}\n`),
  });
  let exitCode = suite.failures.length > 0 ? 2 : 0;
  const output: Record<string, unknown> = { machine: suite.machine, results: suite.results, failures: suite.failures };
  if (values.compare === true) {
    const baseline = parseBaseline(JSON.parse(await readFile(baselinePath, 'utf8')));
    const comparison = compareToBaseline(suite.results, baseline, {
      tolerance: positive(values.tolerance, 0.2, 'tolerance'),
      ...(values.tolerances !== undefined ? { tolerances: parseTolerances(values.tolerances) } : {}),
    });
    output['comparison'] = comparison;
    if (comparison.regressions.length > 0) exitCode = Math.max(exitCode, 1);
    if (values['require-comparison'] === true && comparison.compared === 0) exitCode = 2;
    if (values.json !== true) {
      const lines = [
        `Compared: ${String(comparison.compared)} (${String(comparison.comparedMetrics)} metrics), regressions: ${String(comparison.regressions.length)}, skipped: ${String(comparison.skipped.length)}`,
        ...comparison.regressions.map(formatRegression),
        ...comparison.skipped.map((s) => `skipped ${s.scenario} ${s.resolution}: ${s.reason}`),
      ];
      process.stderr.write(`${lines.join('\n')}\n`);
    }
  }
  if (values['update-baseline'] === true && suite.results.length > 0) {
    const existing = existsSync(baselinePath) ? parseBaseline(JSON.parse(await readFile(baselinePath, 'utf8'))) : undefined;
    await writeFile(baselinePath, `${JSON.stringify(mergeBaseline(existing, suite.results), null, 2)}\n`);
    process.stderr.write(`Baseline written to ${baselinePath}\n`);
  }
  process.stdout.write(values.json === true ? `${JSON.stringify(output, null, 2)}\n` : suite.markdown);
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof OpenVideoError ? `${error.diagnostic.code}: ${error.message}\n${error.diagnostic.suggestions.map((s) => `  - ${s}`).join('\n')}` : error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${USAGE}`);
    process.exitCode = 2;
  },
);
