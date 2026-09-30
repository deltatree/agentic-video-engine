/**
 * Baseline-Vergleich über alle Metriken (Story 22.3): fps, Spitzen-RAM, Startzeit, Encoder-fps,
 * Cache-Quote – jede mit eigener Toleranz und Richtung.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOpenVideoError } from '@agentic-video/core';
import { skipUnless } from '@agentic-video/testing';
import { DEFAULT_TOLERANCES, compareToBaseline, createBaseline, describeMachine, formatRegression, parseBaseline, parseTolerances, type Baseline, type BenchmarkResult } from '@agentic-video/benchmarks';

interface Overrides {
  readonly fps?: number;
  readonly peakRssMb?: number;
  readonly startupMs?: number;
  readonly encodingFps?: number | null;
  readonly cacheHitRatio?: number;
}

function result(o: Overrides = {}): BenchmarkResult {
  const fps = o.fps ?? 10;
  const encodingFps = o.encodingFps === undefined ? 50 : o.encodingFps;
  return {
    scenario: 'mixed',
    resolution: '1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    frames: 10,
    framesPerSecond: fps,
    frameMs: { mean: 1000 / fps, p50: 1000 / fps, p95: 1200 / fps },
    startupMs: o.startupMs ?? 1000,
    cpuPercent: 100,
    cpuSeconds: 1,
    cpuScope: 'process-tree',
    peakRssMb: o.peakRssMb ?? 400,
    rssScope: 'process-tree',
    gpu: { utilizationPercent: null, vramPeakMb: null, reason: 'no GPU' },
    cacheHitRatio: o.cacheHitRatio ?? 0.5,
    encoding: encodingFps === null ? { framesPerSecond: null, reason: 'no encode' } : { framesPerSecond: encodingFps, seconds: 0.2, encoder: 'libx264' },
    audioSeconds: null,
    workers: 1,
    parallelFramesPerSecond: null,
    frameHashes: [],
    deterministic: true,
    diagnostics: [],
    machine: describeMachine(),
  };
}

const baseline = createBaseline([result()]);

function metrics(o: Overrides): string[] {
  return compareToBaseline([result(o)], baseline).regressions.map((r) => r.metric);
}

describe('compareToBaseline: alle Metriken (Story 22.3)', () => {
  it('speichert alle Metriken in der Basis und liest sie zurück', () => {
    expect(baseline.entries[0]).toMatchObject({ framesPerSecond: 10, peakRssMb: 400, startupMs: 1000, encodingFps: 50, cacheHitRatio: 0.5 });
    expect(parseBaseline(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
  });

  it('ohne Änderung: fünf Metriken verglichen, keine Regression', () => {
    const c = compareToBaseline([result()], baseline);
    expect(c.compared).toBe(1);
    expect(c.comparedMetrics).toBe(5);
    expect(c.regressions).toEqual([]);
    expect(c.tolerances).toEqual(DEFAULT_TOLERANCES);
  });

  it('erkennt jede Metrik in ihrer Richtung', () => {
    expect(metrics({ fps: 7.9 })).toEqual(['fps']);
    expect(metrics({ peakRssMb: 501 })).toEqual(['peakRssMb']);
    expect(metrics({ startupMs: 1501 })).toEqual(['startupMs']);
    expect(metrics({ encodingFps: 37 })).toEqual(['encodingFps']);
    expect(metrics({ cacheHitRatio: 0.44 })).toEqual(['cacheHitRatio']);
  });

  it('Verbesserungen und Werte innerhalb der Toleranz schlagen nicht an', () => {
    expect(metrics({ fps: 20, peakRssMb: 200, startupMs: 100, encodingFps: 100, cacheHitRatio: 1 })).toEqual([]);
    expect(metrics({ fps: 8.1, peakRssMb: 499, startupMs: 1499, encodingFps: 38, cacheHitRatio: 0.45 })).toEqual([]);
  });

  it('meldet Wert, Basis, Änderung und Toleranz', () => {
    const [r] = compareToBaseline([result({ peakRssMb: 600 })], baseline).regressions;
    expect(r).toMatchObject({ metric: 'peakRssMb', baseline: 400, current: 600, tolerance: 0.25 });
    expect(r?.change).toBeCloseTo(0.5);
    expect(r === undefined ? '' : formatRegression(r)).toBe('REGRESSION mixed 1080p30 peakRssMb: 600.00 vs. baseline 400.00 (+50.0 %, tolerance 25.0 %)');
  });

  it('eigene Toleranzen je Metrik; tolerance bleibt die Kurzform für fps', () => {
    expect(compareToBaseline([result({ fps: 9 })], baseline, { tolerances: { fps: 0.05 } }).regressions.map((r) => r.metric)).toEqual(['fps']);
    expect(compareToBaseline([result({ fps: 7 })], baseline, { tolerance: 0.5 }).regressions).toEqual([]);
    expect(compareToBaseline([result({ startupMs: 5000 })], baseline, { tolerances: { startupMs: 10 } }).regressions).toEqual([]);
  });

  it('ohne Encoding und mit alter Basis (nur fps) werden fehlende Metriken ausgelassen', () => {
    expect(compareToBaseline([result({ encodingFps: null })], baseline).comparedMetrics).toBe(4);
    const old: Baseline = { machine: baseline.machine, entries: [{ scenario: 'mixed', resolution: '1080p30', frames: 10, framesPerSecond: 10, meanFrameMs: 100, p95FrameMs: 120 }] };
    const c = compareToBaseline([result({ peakRssMb: 9999, fps: 5 })], old);
    expect(c.comparedMetrics).toBe(1);
    expect(c.regressions.map((r) => r.metric)).toEqual(['fps']);
  });

  it('parseTolerances liest Listen und lehnt Unbekanntes ab', () => {
    expect(parseTolerances('fps=0.1, startupMs=1')).toEqual({ fps: 0.1, startupMs: 1 });
    for (const bad of ['speed=1', 'fps', 'fps=-1', 'fps=abc']) {
      let code = '';
      try {
        parseTolerances(bad);
      } catch (error) {
        code = isOpenVideoError(error) ? error.diagnostic.code : String(error);
      }
      expect(code, bad).toBe('OV_BENCH_ARGUMENT');
    }
  });

  it('parseBaseline lehnt negative Zusatzmetriken ab', () => {
    const broken = JSON.parse(JSON.stringify(baseline)) as { entries: Record<string, unknown>[] };
    const entry = broken.entries[0];
    if (entry !== undefined) entry['peakRssMb'] = -1;
    expect(() => parseBaseline(broken)).toThrow(/peakRssMb/u);
  });
});

const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');

describe('openvideo-bench --compare mit eigener Basisdatei (Nightly-Workflow)', () => {
  it.skipIf(skipUnless(existsSync(bin), 'Benchmarks nicht gebaut (packages/benchmarks/dist/bin.js): zuerst `npm run build` ausführen'))('--require-comparison endet mit 2, wenn die Basis von einer anderen Maschine stammt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-bench-bin-'));
    const file = join(dir, 'baseline.json');
    const foreign: Baseline = { machine: { ...baseline.machine, cpu: 'Other CPU' }, entries: baseline.entries };
    writeFileSync(file, JSON.stringify(foreign));
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [bin, '--scenario', 'vector-heavy', '--frames', '1', '--no-encode', '--compare', '--require-comparison', '--baseline', file], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      if (error instanceof Error && 'status' in error && typeof error.status === 'number') status = error.status;
      if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') stderr = error.stderr;
    }
    expect(status).toBe(2);
    expect(stderr).toContain('Different machine');
    // Die Basisdatei bleibt unverändert.
    expect(parseBaseline(JSON.parse(readFileSync(file, 'utf8')))).toEqual(foreign);
  }, 300_000);
});
