/**
 * Regressionserkennung (SM-4): Messungen gegen eine eingecheckte Basis derselben Maschine vergleichen.
 */
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { machineKey, type MachineInfo } from './metrics.js';
import type { BenchmarkResult } from './run.js';
import { RESOLUTION_IDS, SCENARIOS, isResolutionId, isScenarioId, type ResolutionId, type ScenarioId } from './scenarios.js';

/**
 * Ein Basiswert: Messwerte eines Szenarios in einer Auflösung. Die Felder ab `peakRssMb` kamen mit
 * Story 22.3 dazu; ältere Basisdateien ohne sie bleiben gültig (dann wird nur fps verglichen).
 */
export interface BaselineEntry {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly frames: number;
  readonly framesPerSecond: number;
  readonly meanFrameMs: number;
  readonly p95FrameMs: number;
  /** Spitzen-RSS in MiB. */
  readonly peakRssMb?: number;
  /** Zeit bis zum ersten Frame in Millisekunden. */
  readonly startupMs?: number;
  /** Encoder-Durchsatz in Frames pro Sekunde (fehlt ohne Encoding). */
  readonly encodingFps?: number;
  /** Trefferquote aller Cache-Stufen (0..1). */
  readonly cacheHitRatio?: number;
}

/** Verglichene Metriken (Story 22.3). */
export const METRICS = ['fps', 'peakRssMb', 'startupMs', 'encodingFps', 'cacheHitRatio'] as const;
/** Kennung einer verglichenen Metrik. */
export type Metric = (typeof METRICS)[number];

/**
 * Erlaubte Verschlechterung je Metrik. fps, Encoder-fps: relativer Verlust; RAM, Startup: relativer
 * Anstieg; Cache-Quote: absoluter Verlust in Prozentpunkten (0,05 = 5 Punkte).
 */
export type Tolerances = Readonly<Record<Metric, number>>;

/**
 * Standard-Toleranzen: großzügig genug für Messrauschen auf geteilten CI-Runnern, eng genug für
 * echte Regressionen. Startzeiten schwanken am stärksten (Chromium, WASM-Initialisierung).
 */
export const DEFAULT_TOLERANCES: Tolerances = { fps: 0.2, peakRssMb: 0.25, startupMs: 0.5, encodingFps: 0.25, cacheHitRatio: 0.05 };

/** Inhalt von `baseline.json`. */
export interface Baseline {
  readonly machine: MachineInfo;
  readonly entries: readonly BaselineEntry[];
}

/** Eine Metrik eines Szenarios, die schlechter ist als erlaubt. */
export interface Regression {
  readonly scenario: ScenarioId;
  readonly resolution: ResolutionId;
  readonly metric: Metric;
  /** Wert der Basis. */
  readonly baseline: number;
  /** Gemessener Wert. */
  readonly current: number;
  /**
   * Änderung in Richtung „schlechter“ gemessen: relativ für fps, RAM, Startup und Encoder-fps
   * (z. B. `-0.35` = 35 % weniger fps, `0.4` = 40 % mehr RAM), absolut für die Cache-Quote.
   */
  readonly change: number;
  /** Die angewandte Toleranz. */
  readonly tolerance: number;
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
  /** Anzahl verglichener Szenario-Auflösungs-Paare. */
  readonly compared: number;
  /** Anzahl verglichener Einzelmetriken über alle Paare. */
  readonly comparedMetrics: number;
  readonly skipped: readonly SkippedComparison[];
  /** Die angewandten Toleranzen. */
  readonly tolerances: Tolerances;
}

/** Optionen für {@link compareToBaseline}. */
export interface CompareOptions {
  /** Toleranz für fps (Kurzform, wie vor Story 22.3). */
  readonly tolerance?: number;
  /** Toleranzen je Metrik; fehlende Werte kommen aus {@link DEFAULT_TOLERANCES}. */
  readonly tolerances?: Partial<Tolerances>;
}

/**
 * Liest Toleranzen aus einer Liste wie `fps=0.2,peakRssMb=0.3`.
 *
 * @example
 * ```ts
 * parseTolerances('fps=0.1,startupMs=1'); // { fps: 0.1, startupMs: 1 }
 * ```
 */
export function parseTolerances(raw: string): Partial<Tolerances> {
  const out: Partial<Record<Metric, number>> = {};
  for (const part of raw.split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    const [name, value] = part.split('=');
    const metric = METRICS.find((m) => m === name?.trim());
    const n = Number(value);
    if (metric === undefined || value === undefined || !Number.isFinite(n) || n < 0) {
      throw new OpenVideoError({
        code: 'OV_BENCH_ARGUMENT',
        errorClass: 'BenchmarkError',
        problem: `Invalid tolerance "${part}".`,
        suggestions: [`Use <metric>=<non-negative number> with a metric of: ${METRICS.join(', ')}.`, 'Example: --tolerances fps=0.2,peakRssMb=0.25'],
      });
    }
    out[metric] = n;
  }
  return out;
}

/** Messwert einer Metrik aus einem Ergebnis (`undefined`, wenn nicht gemessen). */
function currentValue(r: BenchmarkResult, metric: Metric): number | undefined {
  switch (metric) {
    case 'fps':
      return r.framesPerSecond;
    case 'peakRssMb':
      return r.peakRssMb;
    case 'startupMs':
      return r.startupMs;
    case 'encodingFps':
      return r.encoding.framesPerSecond ?? undefined;
    case 'cacheHitRatio':
      return r.cacheHitRatio;
  }
}

function baselineValue(e: BaselineEntry, metric: Metric): number | undefined {
  switch (metric) {
    case 'fps':
      return e.framesPerSecond;
    case 'peakRssMb':
      return e.peakRssMb;
    case 'startupMs':
      return e.startupMs;
    case 'encodingFps':
      return e.encodingFps;
    case 'cacheHitRatio':
      return e.cacheHitRatio;
  }
}

/**
 * Änderung in Richtung „schlechter“ und ob sie die Toleranz überschreitet.
 * Höher ist besser: fps, Encoder-fps, Cache-Quote. Niedriger ist besser: RAM, Startup.
 */
function judge(metric: Metric, base: number, current: number, tolerance: number): { change: number; regressed: boolean } | undefined {
  if (metric === 'cacheHitRatio') {
    const change = current - base;
    return { change, regressed: change < -tolerance - 1e-12 };
  }
  if (base <= 0) return undefined;
  const change = current / base - 1;
  if (metric === 'peakRssMb' || metric === 'startupMs') return { change, regressed: change > tolerance };
  return { change, regressed: change < -tolerance };
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
    entries: results.map((r) => ({
      scenario: r.scenario,
      resolution: r.resolution,
      frames: r.frames,
      framesPerSecond: r.framesPerSecond,
      meanFrameMs: r.frameMs.mean,
      p95FrameMs: r.frameMs.p95,
      peakRssMb: r.peakRssMb,
      startupMs: r.startupMs,
      ...(r.encoding.framesPerSecond !== null ? { encodingFps: r.encoding.framesPerSecond } : {}),
      cacheHitRatio: r.cacheHitRatio,
    })),
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
 * Vergleicht Messungen mit der Basis (Story 22.3): fps, Spitzen-RAM, Startzeit, Encoder-fps und
 * Cache-Quote, jede Metrik mit eigener Toleranz ({@link DEFAULT_TOLERANCES}). Eine Metrik ohne
 * Basiswert (ältere Basis) oder ohne Messwert (ohne Encoding) wird nicht verglichen. Messungen
 * einer anderen Maschine werden nicht verglichen, sondern mit Grund übersprungen.
 *
 * @example
 * ```ts
 * const c = compareToBaseline(results, baseline, { tolerances: { fps: 0.2, peakRssMb: 0.3 } });
 * if (c.regressions.length > 0) process.exitCode = 1;
 * ```
 */
export function compareToBaseline(results: readonly BenchmarkResult[], baseline: Baseline, options: CompareOptions = {}): Comparison {
  const tolerances: Tolerances = { ...DEFAULT_TOLERANCES, ...(options.tolerance !== undefined ? { fps: options.tolerance } : {}), ...options.tolerances };
  const baseKey = machineKey(baseline.machine);
  const regressions: Regression[] = [];
  const skipped: SkippedComparison[] = [];
  let compared = 0;
  let comparedMetrics = 0;
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
    for (const metric of METRICS) {
      const base = baselineValue(entry, metric);
      const current = currentValue(r, metric);
      if (base === undefined || current === undefined) continue;
      const verdict = judge(metric, base, current, tolerances[metric]);
      if (verdict === undefined) continue;
      comparedMetrics++;
      if (verdict.regressed) regressions.push({ scenario: r.scenario, resolution: r.resolution, metric, baseline: base, current, change: verdict.change, tolerance: tolerances[metric] });
    }
  }
  return { regressions, compared, comparedMetrics, skipped, tolerances };
}

/**
 * Eine Zeile je Regression für Konsole und CI-Zusammenfassung.
 *
 * @example
 * ```ts
 * formatRegression({ scenario: 'mixed', resolution: '1080p30', metric: 'fps', baseline: 4, current: 3, change: -0.25, tolerance: 0.2 });
 * // 'REGRESSION mixed 1080p30 fps: 3.00 vs. baseline 4.00 (-25.0 %, tolerance 20.0 %)'
 * ```
 */
export function formatRegression(r: Regression): string {
  const pct = (v: number): string => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} %`;
  const change = r.metric === 'cacheHitRatio' ? `${r.change > 0 ? '+' : ''}${(r.change * 100).toFixed(1)} points` : pct(r.change);
  const tolerance = r.metric === 'cacheHitRatio' ? `${(r.tolerance * 100).toFixed(1)} points` : `${(r.tolerance * 100).toFixed(1)} %`;
  return `REGRESSION ${r.scenario} ${r.resolution} ${r.metric}: ${r.current.toFixed(2)} vs. baseline ${r.baseline.toFixed(2)} (${change}, tolerance ${tolerance})`;
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
    const optional: { peakRssMb?: number; startupMs?: number; encodingFps?: number; cacheHitRatio?: number } = {};
    for (const field of ['peakRssMb', 'startupMs', 'encodingFps', 'cacheHitRatio'] as const) {
      if (e[field] === undefined) continue;
      const v = num(e[field]);
      if (v === undefined || v < 0) throw invalid(`Baseline entry ${String(i)} has an invalid "${field}".`);
      optional[field] = v;
    }
    return { scenario, resolution, frames, framesPerSecond: fps, meanFrameMs: mean, p95FrameMs: p95, ...optional };
  });
  return { machine: { cpu, cores, memoryGb, platform, gpu, node }, entries };
}
