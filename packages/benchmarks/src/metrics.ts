/**
 * Messwerkzeuge (A38): Statistik, CPU und RAM über `/proc`, GPU über `nvidia-smi`, Maschinenbeschreibung.
 *
 * Alle Messungen sind Beobachtungen von außen. Sie beeinflussen die gerenderten Frames nicht.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';

/** Kennzahlen einer Zeitreihe in Millisekunden. */
export interface TimingStats {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

/**
 * Mittelwert, Median und 95. Perzentil (Nearest-Rank-Verfahren).
 *
 * @example
 * ```ts
 * summarize([10, 20, 30]); // { mean: 20, p50: 20, p95: 30 }
 * ```
 */
export function summarize(values: readonly number[]): TimingStats {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, p50: rank(0.5), p95: rank(0.95) };
}

/** Beschreibung der Maschine; nur Messungen derselben Maschine sind vergleichbar. */
export interface MachineInfo {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGb: number;
  readonly platform: string;
  readonly gpu: string | null;
  readonly node: string;
}

function runQuiet(file: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (error) {
    // Programm fehlt oder scheitert: Aufrufer melden dann "nicht verfügbar" mit Grund.
    if (error instanceof Error) return undefined;
    throw error;
  }
}

/**
 * Name der ersten NVIDIA-GPU oder `null`, wenn `nvidia-smi` fehlt.
 *
 * @example
 * ```ts
 * const gpu = detectGpu(); // z. B. "NVIDIA GeForce RTX 4090" oder null
 * ```
 */
export function detectGpu(): string | null {
  const out = runQuiet('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
  const name = out?.split('\n')[0]?.trim();
  return name === undefined || name === '' ? null : name;
}

/**
 * Beschreibt die aktuelle Maschine.
 *
 * @example
 * ```ts
 * const m = describeMachine();
 * console.log(m.cpu, m.cores);
 * ```
 */
export function describeMachine(): MachineInfo {
  return {
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    cores: availableParallelism(),
    memoryGb: Math.round(totalmem() / 2 ** 30),
    platform: `${process.platform}-${process.arch}`,
    gpu: detectGpu(),
    node: process.version,
  };
}

/**
 * Schlüssel für die Vergleichbarkeit: CPU, Kerne, RAM, Plattform und GPU (ohne Node-Version).
 *
 * @example
 * ```ts
 * machineKey(describeMachine()) === machineKey(baseline.machine);
 * ```
 */
export function machineKey(m: MachineInfo): string {
  return [m.cpu, String(m.cores), `${String(m.memoryGb)}GB`, m.platform, m.gpu ?? 'no-gpu'].join(' | ');
}

function systemNumber(name: string, fallback: number): number {
  const v = Number(runQuiet('getconf', [name])?.trim());
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** `/proc` ist vorhanden (Linux). */
export const HAS_PROC = existsSync('/proc/self/stat');

const CLOCK_TICKS = HAS_PROC ? systemNumber('CLK_TCK', 100) : 100;
const PAGE_SIZE = HAS_PROC ? systemNumber('PAGESIZE', 4096) : 4096;

interface ProcStat {
  readonly ppid: number;
  /** utime + stime + cutime + cstime in Ticks. */
  readonly ticks: number;
}

function readProcStat(pid: string): ProcStat | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    // Der Prozess endete zwischen Auflisten und Lesen.
    if (error instanceof Error) return undefined;
    throw error;
  }
  const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
  const n = (i: number): number => Number(f[i] ?? 0);
  return { ppid: n(1), ticks: n(11) + n(12) + n(13) + n(14) };
}

/**
 * CPU-Zeit in Sekunden des Prozessbaums ab `root` (lebende Prozesse plus beendete, abgeholte Kinder).
 * Ohne `/proc`: nur der eigene Prozess.
 *
 * @example
 * ```ts
 * const a = treeCpuSeconds(process.pid, new Set());
 * ```
 */
export function treeCpuSeconds(root: number, exclude: ReadonlySet<number>): { seconds: number; scope: 'process-tree' | 'process' } {
  if (!HAS_PROC) {
    const u = process.cpuUsage();
    return { seconds: (u.user + u.system) / 1e6, scope: 'process' };
  }
  const stats = new Map<number, ProcStat>();
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const s = readProcStat(e);
    if (s !== undefined) stats.set(Number(e), s);
  }
  const children = new Map<number, number[]>();
  for (const [pid, s] of stats) children.set(s.ppid, [...(children.get(s.ppid) ?? []), pid]);
  let ticks = 0;
  const queue = [root];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    if (exclude.has(pid)) continue;
    ticks += stats.get(pid)?.ticks ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return { seconds: ticks / CLOCK_TICKS, scope: 'process-tree' };
}


/**
 * Eigenständiger Abtaster: liest alle 100 ms den RSS des Prozessbaums aus `/proc`.
 * Er läuft als eigener Prozess, damit blockierende Render-Arbeit die Abtastung nicht verzögert.
 */
const RSS_SAMPLER = `
const fs = require('node:fs');
const root = Number(process.argv[1]);
const page = Number(process.argv[2]);
let peak = 0, samples = 0;
function sample() {
  const kids = new Map(), rss = new Map();
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\\d+$/.test(e)) continue;
    let s;
    try { s = fs.readFileSync('/proc/' + e + '/stat', 'utf8'); } catch (err) { continue; }
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const pid = Number(e), pp = Number(f[1]);
    rss.set(pid, Number(f[21]) * page);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(pid);
  }
  let total = 0;
  const q = [root];
  while (q.length > 0) {
    const p = q.pop();
    if (p === process.pid) continue;
    total += rss.get(p) || 0;
    for (const c of kids.get(p) || []) q.push(c);
  }
  samples++;
  if (total > peak) peak = total;
}
sample();
process.stdout.write('ready\\n');
const timer = setInterval(sample, 100);
process.stdin.on('data', () => {});
process.stdin.on('end', () => { clearInterval(timer); sample(); process.stdout.write(JSON.stringify({ peak, samples }) + '\\n'); });
`;

/** Ergebnis der Ressourcen-Messung. */
export interface ResourceUsage {
  readonly cpuSeconds: number;
  /** CPU-Zeit geteilt durch Wandzeit in Prozent eines Kerns (kann über 100 liegen). */
  readonly cpuPercent: number;
  readonly cpuScope: 'process-tree' | 'process';
  readonly peakRssMb: number;
  readonly rssScope: 'process-tree' | 'process';
  readonly rssSamples: number;
  readonly gpu: GpuUsage;
}

/** GPU-Auslastung und Speicher; ohne GPU `null` mit Begründung. */
export type GpuUsage = { readonly utilizationPercent: number; readonly vramPeakMb: number; readonly name: string } | { readonly utilizationPercent: null; readonly vramPeakMb: null; readonly reason: string };

/** Laufende Messung; {@link ResourceMonitor.stop} beendet sie. */
export interface ResourceMonitor {
  stop(): Promise<ResourceUsage>;
}

function collect(child: ChildProcess): { lines: string[]; next(): Promise<string> } {
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const w = waiters.shift();
      if (w !== undefined) w(line);
      else lines.push(line);
    }
  });
  child.on('close', () => {
    for (const w of waiters.splice(0)) w('');
  });
  return {
    lines,
    next: () => {
      const line = lines.shift();
      return line !== undefined ? Promise.resolve(line) : new Promise((r) => waiters.push(r));
    },
  };
}

function gpuUsage(lines: readonly string[], name: string | null): GpuUsage {
  if (name === null) return { utilizationPercent: null, vramPeakMb: null, reason: 'no GPU' };
  let util = 0;
  let count = 0;
  let vram = 0;
  for (const line of lines) {
    const [u, m] = line.split(',').map((x) => Number(x.trim()));
    if (u === undefined || m === undefined || !Number.isFinite(u) || !Number.isFinite(m)) continue;
    util += u;
    count++;
    vram = Math.max(vram, m);
  }
  if (count === 0) return { utilizationPercent: null, vramPeakMb: null, reason: 'nvidia-smi returned no samples' };
  return { utilizationPercent: util / count, vramPeakMb: vram, name };
}

/**
 * Startet die Messung von CPU, Spitzen-RAM (Abtastung alle 100 ms) und GPU für den eigenen Prozessbaum.
 *
 * @example
 * ```ts
 * const monitor = await startResourceMonitor();
 * await work();
 * const usage = await monitor.stop();
 * ```
 */
export async function startResourceMonitor(): Promise<ResourceMonitor> {
  const started = performance.now();
  const gpuName = detectGpu();
  const exclude = new Set<number>();
  let sampler: { child: ChildProcess; stream: ReturnType<typeof collect> } | undefined;
  if (HAS_PROC) {
    const child = spawn(process.execPath, ['-e', RSS_SAMPLER, String(process.pid), String(PAGE_SIZE)], { stdio: ['pipe', 'pipe', 'ignore'] });
    if (child.pid !== undefined) exclude.add(child.pid);
    sampler = { child, stream: collect(child) };
    await sampler.stream.next();
  }
  let gpu: { child: ChildProcess; stream: ReturnType<typeof collect> } | undefined;
  if (gpuName !== null) {
    const child = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits', '-lms', '100'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (child.pid !== undefined) exclude.add(child.pid);
    gpu = { child, stream: collect(child) };
  }
  const cpuStart = treeCpuSeconds(process.pid, exclude);
  return {
    async stop() {
      const cpuEnd = treeCpuSeconds(process.pid, exclude);
      const wall = (performance.now() - started) / 1000;
      let peak = 0;
      let samples = 0;
      if (sampler !== undefined) {
        sampler.child.stdin?.end();
        const line = await sampler.stream.next();
        const parsed: unknown = line === '' ? {} : JSON.parse(line);
        if (typeof parsed === 'object' && parsed !== null && 'peak' in parsed && 'samples' in parsed) {
          peak = Number(parsed.peak);
          samples = Number(parsed.samples);
        }
      }
      if (gpu !== undefined) {
        const { child } = gpu;
        const closed = new Promise((r) => child.once('close', r));
        child.kill();
        await closed;
      }
      // Eigener Spitzenwert des Hauptprozesses (maxRSS in KiB) ergänzt die Abtastung.
      const ownPeak = process.resourceUsage().maxRSS * 1024;
      const cpuSeconds = Math.max(0, cpuEnd.seconds - cpuStart.seconds);
      return {
        cpuSeconds,
        cpuPercent: wall > 0 ? (cpuSeconds / wall) * 100 : 0,
        cpuScope: cpuEnd.scope,
        peakRssMb: Math.max(peak, ownPeak) / 2 ** 20,
        rssScope: sampler !== undefined ? 'process-tree' : 'process',
        rssSamples: samples,
        gpu: gpuUsage(gpu?.stream.lines ?? [], gpuName),
      };
    },
  };
}
