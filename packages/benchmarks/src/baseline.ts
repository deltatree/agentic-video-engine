/**
 * Regressionserkennung (SM-4): Messungen gegen eine eingecheckte Basis derselben Maschine vergleichen.
 */
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { machineKey, type MachineInfo } from './metrics.js';
import type { BenchmarkResult } from './run.js';
import { RESOLUTION_IDS, SCENARIOS, isResolutionId, isScenarioId, type ResolutionId, type ScenarioId } from './scenarios.js';

/** Ein Basiswert: Durchsatz eines Szenarios in einer Auflösung. */
export interface BaselineEntry {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly frames: number;
  readonly framesPerSecond: number;
  readonly meanFrameMs: number;
  readonly p95FrameMs: number;
}

/** Inhalt von `baseline.json`. */
export interface Baseline {
  readonly machine: MachineInfo;
  readonly entries: readonly BaselineEntry[];
}

/** Ein Szenario, dessen Durchsatz schlechter ist als erlaubt. */
export interface Regression {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly baselineFps: number;
  readonly fps: number;
  /** Relative Änderung, z. B. `-0.35` für 35 % langsamer. */
  readonly change: number;
}

/** Ein nicht verglichenes Ergebnis mit Grund. */
export interface SkippedComparison {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly reason: string;
}

/** Ergebnis von {@link compareToBaseline}. */
export interface Comparison {
  readonly regressions: readonly Regression[];
  readonly compared: number;
  readonly skipped: readonly SkippedComparison[];
}

/**
 * Baut eine Basis aus Messergebnissen. Alle Ergebnisse müssen von derselben Maschine stammen.
 *
 * @example
 * ```ts
 * const baseline = createBaseline(suite.results);
 * ```
 */
export function createBaseline(results: readonly BenchmarkResult[]): Baseline {
  const first = results[0];
  if (first === undefined) throw new OpenVideoError({ code: 'OV_BENCH_BASELINE_EMPTY', errorClass: 'BenchmarkError', problem: 'A baseline needs at least one result.', suggestions: ['Run at least one scenario before --update-baseline.'] });
  const key = machineKey(first.machine);
  const foreign = results.find((r) => machineKey(r.machine) !== key);
  if (foreign !== undefined) throw new OpenVideoError({ code: 'OV_BENCH_BASELINE_MACHINE', errorClass: 'BenchmarkError', problem: `Results come from different machines ("${key}" and "${machineKey(foreign.machine)}").`, suggestions: ['Measure all scenarios on one machine.'] });
  return {
    machine: first.machine,
    entries: results.map((r) => ({ scenario: r.scenario, resolution: r.resolution, frames: r.frames, framesPerSecond: r.framesPerSecond, meanFrameMs: r.frameMs.mean, p95FrameMs: r.frameMs.p95 })),
  };
}

/**
 * Aktualisiert eine vorhandene Basis mit neuen Messungen. Stammt die alte Basis von derselben
 * Maschine, bleiben nicht neu gemessene Einträge erhalten; sonst ersetzt die neue Basis sie ganz.
 *
 * @example
 * ```ts
 * const next = mergeBaseline(parseBaseline(old), suite.results);
 * ```
 */
export function mergeBaseline(existing: Baseline | undefined, results: readonly BenchmarkResult[]): Baseline {
  const fresh = createBaseline(results);
  if (existing === undefined || machineKey(existing.machine) !== machineKey(fresh.machine)) return fresh;
  const measured = new Set(fresh.entries.map((e) => `${e.scenario}@${e.resolution}`));
  const kept = existing.entries.filter((e) => !measured.has(`${e.scenario}@${e.resolution}`));
  const order = (e: BaselineEntry): number => SCENARIOS.indexOf(e.scenario) * RESOLUTION_IDS.length + RESOLUTION_IDS.indexOf(e.resolution);
  return { machine: fresh.machine, entries: [...kept, ...fresh.entries].sort((a, b) => order(a) - order(b)) };
}

/**
 * Vergleicht Messungen mit der Basis. Ein Szenario regressiert, wenn seine fps um mehr als
 * `tolerance` (Standard 0,2 = 20 %) unter dem Basiswert liegen. Messungen einer anderen Maschine
 * werden nicht verglichen, sondern mit Grund übersprungen.
 *
 * @example
 * ```ts
 * const c = compareToBaseline(results, baseline, { tolerance: 0.2 });
 * if (c.regressions.length > 0) process.exitCode = 1;
 * ```
 */
export function compareToBaseline(results: readonly BenchmarkResult[], baseline: Baseline, options: { readonly tolerance?: number } = {}): Comparison {
  const tolerance = options.tolerance ?? 0.2;
  const baseKey = machineKey(baseline.machine);
  const regressions: Regression[] = [];
  const skipped: SkippedComparison[] = [];
  let compared = 0;
  for (const r of results) {
    const key = machineKey(r.machine);
    if (key !== baseKey) {
      skipped.push({ scenario: r.scenario, resolution: r.resolution, reason: `Different machine: baseline "${baseKey}", current "${key}". Measure a baseline on this machine with --update-baseline.` });
      continue;
    }
    const entry = baseline.entries.find((e) => e.scenario === r.scenario && e.resolution === r.resolution);
    if (entry === undefined || entry.framesPerSecond <= 0) {
      skipped.push({ scenario: r.scenario, resolution: r.resolution, reason: 'No baseline value for this scenario and resolution.' });
      continue;
    }
    compared++;
    const change = r.framesPerSecond / entry.framesPerSecond - 1;
    if (change < -tolerance) regressions.push({ scenario: r.scenario, resolution: r.resolution, baselineFps: entry.framesPerSecond, fps: r.framesPerSecond, change });
  }
  return { regressions, compared, skipped };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function invalid(problem: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_BENCH_BASELINE_INVALID', errorClass: 'BenchmarkError', problem, suggestions: ['Recreate the file with `openvideo-bench --update-baseline`.'] });
}

/**
 * Prüft und liest den Inhalt einer Basisdatei (geparstes JSON).
 *
 * @example
 * ```ts
 * const baseline = parseBaseline(JSON.parse(await readFile('baseline.json', 'utf8')));
 * ```
 */
export function parseBaseline(value: unknown): Baseline {
  if (!isRecord(value) || !isRecord(value['machine']) || !Array.isArray(value['entries'])) throw invalid('The baseline must be an object with "machine" and "entries".');
  const m = value['machine'];
  const cpu = str(m['cpu']);
  const cores = num(m['cores']);
  const memoryGb = num(m['memoryGb']);
  const platform = str(m['platform']);
  const node = str(m['node']);
  const gpu = m['gpu'] === null ? null : str(m['gpu']);
  if (cpu === undefined || cores === undefined || memoryGb === undefined || platform === undefined || node === undefined || gpu === undefined) throw invalid('The baseline machine description is incomplete.');
  const entries = value['entries'].map((e: unknown, i): BaselineEntry => {
    if (!isRecord(e)) throw invalid(`Baseline entry ${String(i)} is not an object.`);
    const scenario = str(e['scenario']);
    const resolution = str(e['resolution']);
    const frames = num(e['frames']);
    const fps = num(e['framesPerSecond']);
    const mean = num(e['meanFrameMs']);
    const p95 = num(e['p95FrameMs']);
    if (scenario === undefined || !isScenarioId(scenario) || resolution === undefined || !isResolutionId(resolution) || frames === undefined || fps === undefined || mean === undefined || p95 === undefined) {
      throw invalid(`Baseline entry ${String(i)} has missing or unknown fields.`);
    }
    return { scenario, resolution, frames, framesPerSecond: fps, meanFrameMs: mean, p95FrameMs: p95 };
  });
  return { machine: { cpu, cores, memoryGb, platform, gpu, node }, entries };
}
