/**
 * Kindprozess für isolierte Messungen: führt genau einen {@link runBenchmark} aus.
 *
 * Aufruf: `node child.js <optionen-json> <ergebnis-datei>`. Das Ergebnis (oder der Fehler)
 * landet als JSON in der Datei, damit Log-Ausgaben auf stdout es nicht stören.
 */
import { writeFileSync } from 'node:fs';
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { runBenchmark } from './run.js';
import { isResolutionId, isScenarioId } from './scenarios.js';

async function main(): Promise<void> {
  const [raw, out] = process.argv.slice(2);
  if (raw === undefined || out === undefined) throw new OpenVideoError({ code: 'OV_BENCH_CHILD_ARGS', errorClass: 'BenchmarkError', problem: 'The benchmark child needs <options-json> <result-file>.', suggestions: ['Start it through runSuite({ isolate: true }).'] });
  const o: unknown = JSON.parse(raw);
  if (!isRecord(o) || typeof o['scenario'] !== 'string' || !isScenarioId(o['scenario']) || typeof o['resolution'] !== 'string' || !isResolutionId(o['resolution'])) {
    throw new OpenVideoError({ code: 'OV_BENCH_CHILD_ARGS', errorClass: 'BenchmarkError', problem: 'The benchmark child got invalid options.', suggestions: ['Pass a known scenario and resolution.'] });
  }
  try {
    const result = await runBenchmark({
      scenario: o['scenario'],
      resolution: o['resolution'],
      ...(typeof o['frames'] === 'number' ? { frames: o['frames'] } : {}),
      ...(typeof o['workers'] === 'number' ? { workers: o['workers'] } : {}),
      ...(typeof o['encode'] === 'boolean' ? { encode: o['encode'] } : {}),
    });
    writeFileSync(out, JSON.stringify({ result }));
  } catch (error) {
    const code = error instanceof OpenVideoError ? error.diagnostic.code : 'OV_BENCH_CRASH';
    const problem = error instanceof OpenVideoError ? error.diagnostic.problem : error instanceof Error ? error.message : String(error);
    writeFileSync(out, JSON.stringify({ error: { code, problem } }));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
