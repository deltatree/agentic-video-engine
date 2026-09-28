import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCENARIOS,
  compareToBaseline,
  createBaseline,
  mergeBaseline,
  describeMachine,
  detectGpu,
  formatMarkdown,
  parseBaseline,
  runAssetScaleBenchmark,
  runBenchmark,
  summarize,
  type BenchmarkResult,
} from '@agentic-video/benchmarks';

// Kurze Läufe mit großzügigen Grenzen: Die Tests prüfen Plausibilität, nicht Geschwindigkeit.
const SLOW = 300_000;
const hasGpu = detectGpu() !== null;

function errors(r: { readonly diagnostics: readonly { readonly severity: string }[] }): unknown[] {
  return r.diagnostics.filter((d) => d.severity === 'error');
}

describe('summarize', () => {
  it('berechnet Mittelwert, p50 und p95 nach Nearest-Rank', () => {
    expect(summarize([10, 20, 30, 40])).toEqual({ mean: 25, p50: 20, p95: 40 });
    expect(summarize([])).toEqual({ mean: 0, p50: 0, p95: 0 });
  });
});

describe('Szenarien in 1080p30 mit wenigen Frames', () => {
  for (const scenario of SCENARIOS) {
    it(
      `${scenario} läuft durch und liefert plausible Werte`,
      async () => {
        const r = await runBenchmark({ scenario, resolution: '1080p30', frames: 2, encode: true });
        expect(errors(r)).toEqual([]);
        expect([r.width, r.height, r.fps, r.frames]).toEqual([1920, 1080, 30, 2]);
        expect(r.framesPerSecond).toBeGreaterThan(0);
        expect(r.frameMs.mean).toBeGreaterThan(0);
        expect(r.frameMs.p95).toBeGreaterThanOrEqual(r.frameMs.p50);
        expect(r.startupMs).toBeGreaterThan(0);
        expect(r.cpuSeconds).toBeGreaterThan(0);
        expect(r.cpuPercent).toBeGreaterThan(0);
        expect(r.peakRssMb).toBeGreaterThan(50);
        expect(r.cacheHitRatio).toBeGreaterThanOrEqual(0);
        expect(r.cacheHitRatio).toBeLessThanOrEqual(1);
        expect(r.encoding.framesPerSecond).toBeGreaterThan(0);
        expect(r.frameHashes).toHaveLength(2);
        expect(r.deterministic).toBe(true);
        expect(r.workers).toBe(1);
        if (!hasGpu) expect(r.gpu).toEqual({ utilizationPercent: null, vramPeakMb: null, reason: 'no GPU' });
        if (scenario === 'audio-heavy') expect(r.audioSeconds ?? 0).toBeGreaterThan(0);
      },
      SLOW,
    );
  }
});

describe('Determinismus und 4K', () => {
  it(
    'liefert bei gleichem Szenario die gleichen Frame-Hashes',
    async () => {
      const a = await runBenchmark({ scenario: 'vector-heavy', resolution: '1080p60', frames: 2, encode: false });
      const b = await runBenchmark({ scenario: 'vector-heavy', resolution: '1080p60', frames: 2, encode: false });
      expect(a.frameHashes).toEqual(b.frameHashes);
      expect(a.encoding.framesPerSecond).toBeNull();
      expect(a.deterministic).toBeNull();
    },
    SLOW,
  );

  for (const scenario of ['text-heavy', 'vector-heavy'] as const) {
    it(
      `rendert einen 4K-Frame (${scenario})`,
      async () => {
        const r = await runBenchmark({ scenario, resolution: '4k30', frames: 1, encode: false });
        expect(errors(r)).toEqual([]);
        expect([r.width, r.height]).toEqual([3840, 2160]);
        expect(r.frameHashes).toHaveLength(1);
        expect(r.frameMs.mean).toBeGreaterThan(0);
      },
      SLOW,
    );
  }
});

describe('Projekt mit 1000 Assets', () => {
  it(
    'löst 1000 kleine PNGs auf, rendert sie und misst die Zeit',
    async () => {
      const r = await runAssetScaleBenchmark({ count: 1000 });
      expect(r.assets).toBe(1000);
      expect(errors(r)).toEqual([]);
      expect(r.resolveMs).toBeGreaterThan(0);
      expect(r.frameMs).toBeGreaterThan(0);
      expect(r.frameHash).toMatch(/^sha256:/);
    },
    SLOW,
  );
});

describe('Parallelität', () => {
  it(
    'misst mit mehreren Worker-Prozessen oder vermerkt, warum nur einer lief',
    async () => {
      const r = await runBenchmark({ scenario: 'vector-heavy', resolution: '1080p30', frames: 4, workers: 2, encode: false });
      if (r.workers === 2) expect(r.parallelFramesPerSecond ?? 0).toBeGreaterThan(0);
      else expect(r.workersNote).toBeTypeOf('string');
    },
    SLOW,
  );
});

function fakeResult(scenario: BenchmarkResult['scenario'], fps: number, machine = describeMachine()): BenchmarkResult {
  return {
    scenario,
    resolution: '1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    frames: 10,
    framesPerSecond: fps,
    frameMs: { mean: 1000 / fps, p50: 1000 / fps, p95: 1200 / fps },
    startupMs: 500,
    cpuPercent: 100,
    cpuSeconds: 1,
    cpuScope: 'process-tree',
    peakRssMb: 300,
    rssScope: 'process-tree',
    gpu: { utilizationPercent: null, vramPeakMb: null, reason: 'no GPU' },
    cacheHitRatio: 0.2,
    encoding: { framesPerSecond: 50, seconds: 0.2, encoder: 'libx264' },
    audioSeconds: null,
    workers: 1,
    parallelFramesPerSecond: null,
    frameHashes: [],
    deterministic: true,
    diagnostics: [],
    machine,
  };
}

describe('Regressionserkennung', () => {
  const baseline = createBaseline([fakeResult('text-heavy', 10), fakeResult('mixed', 4)]);

  it('schlägt an, wenn fps um mehr als 20 % sinken', () => {
    const c = compareToBaseline([fakeResult('text-heavy', 7), fakeResult('mixed', 3.9)], baseline, { tolerance: 0.2 });
    expect(c.compared).toBe(2);
    expect(c.regressions).toHaveLength(1);
    expect(c.regressions[0]).toMatchObject({ scenario: 'text-heavy', baselineFps: 10, fps: 7 });
    expect(c.regressions[0]?.change).toBeCloseTo(-0.3);
  });

  it('bleibt ruhig innerhalb der Toleranz', () => {
    expect(compareToBaseline([fakeResult('text-heavy', 8.1)], baseline).regressions).toEqual([]);
  });

  it('vergleicht keine Werte einer anderen Maschine (Diagnose statt Alarm)', () => {
    const other = { ...describeMachine(), cpu: 'Some Other CPU' };
    const c = compareToBaseline([fakeResult('text-heavy', 1, other)], baseline);
    expect(c.regressions).toEqual([]);
    expect(c.compared).toBe(0);
    expect(c.skipped[0]?.reason).toContain('Different machine');
  });

  it('liest eine Basis zurück und lehnt kaputte Dateien ab', () => {
    expect(parseBaseline(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
    expect(() => parseBaseline({ machine: {}, entries: [] })).toThrow(/incomplete/);
  });

  it('die eingecheckte baseline.json ist gültig', () => {
    const path = join(import.meta.dirname, '..', 'baseline.json');
    expect(existsSync(path)).toBe(true);
    const parsed = parseBaseline(JSON.parse(readFileSync(path, 'utf8')));
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  it('ersetzt beim Aktualisieren nur neu gemessene Einträge derselben Maschine', () => {
    const merged = mergeBaseline(baseline, [fakeResult('mixed', 5)]);
    expect(merged.entries.map((e) => [e.scenario, e.framesPerSecond])).toEqual([['text-heavy', 10], ['mixed', 5]]);
    const foreign = mergeBaseline({ ...baseline, machine: { ...baseline.machine, cpu: 'Other' } }, [fakeResult('mixed', 5)]);
    expect(foreign.entries).toHaveLength(1);
  });

  it('formatiert eine Markdown-Tabelle', () => {
    const md = formatMarkdown([fakeResult('mixed', 4)]);
    expect(md).toContain('| Szenario |');
    expect(md).toContain('| mixed | 1080p30 | 10 | 4.00 |');
  });
});
