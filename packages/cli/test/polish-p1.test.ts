/**
 * Politur P1 in der CLI: Ebene `compiled` der Quellen meldet an die Telemetrie, `cache clear`
 * räumt auch alte Ebenen-Verzeichnisse auf.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '@agentic-video/cache';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';
import { createSourceService, helloSource, runCli, trustProxyOf } from '@agentic-video/cli';

function recording(): { telemetry: Telemetry; hits: string[]; misses: string[] } {
  const base = createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });
  const hits: string[] = [];
  const misses: string[] = [];
  return {
    hits,
    misses,
    telemetry: {
      ...base,
      metrics: {
        ...base.metrics,
        cacheHit: (tier) => {
          hits.push(tier);
        },
        cacheMiss: (tier) => {
          misses.push(tier);
        },
      },
    },
  };
}

async function cli(args: string[], cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env });
  return { code, stdout, stderr };
}

describe('Ebene compiled an der Telemetrie (Politur P1)', () => {
  it('meldet Fehlgriff und Treffer der Ebene compiled, auch wenn die Telemetrie später kommt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-p1-compiled-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'video.tsx'), helloSource('telemetry'));
    const early = recording();
    const sources = createSourceService({ trusted: true, env: { OPENVIDEO_CACHE_DIR: join(dir, 'cache') }, telemetry: early.telemetry });
    await sources.compile(dir, 'src/video.tsx');
    expect(early.misses).toEqual(['compiled']);
    // Telemetrie der Dienste kommt erst nach dem ersten Kompilieren (wie in `openvideo dev`).
    const late = recording();
    sources.useTelemetry(late.telemetry);
    sources.useTelemetry(late.telemetry);
    await sources.compile(dir, 'src/video.tsx');
    expect(early.hits).toEqual(['compiled']);
    expect(late.hits).toEqual(['compiled']);
    expect(late.misses).toEqual([]);
  }, 60_000);
});

describe('cache clear räumt alte Ebenen auf (Politur P1)', () => {
  it('löscht font/, geometry/, shader/ und composition/ mit; --tier nennt auch eine alte Ebene', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-p1-clear-'));
    const cacheDir = join(dir, 'cache');
    const store = new FileStore(cacheDir);
    for (const key of ['font/sha256:aa', 'geometry/sha256:bb', 'shader/sha256:cc', 'composition/sha256:dd', 'frame/sha256:ee', 'shader/sha256:ff']) await store.put(key, new Uint8Array([1]));
    const env = { OPENVIDEO_CACHE_DIR: cacheDir };
    const one = await cli(['cache', 'clear', '.', '--tier', 'shader', '--json'], dir, env);
    expect(one.code, one.stderr).toBe(0);
    expect(JSON.parse(one.stdout)).toEqual({ removed: 2, legacyRemoved: 2 });
    expect(await store.has('frame/sha256:ee')).toBe(true);
    const all = await cli(['cache', 'clear', '.', '--json'], dir, env);
    expect(all.code, all.stderr).toBe(0);
    expect(JSON.parse(all.stdout)).toEqual({ removed: 4, legacyRemoved: 3 });
    expect(await store.list('')).toEqual([]);
    for (const t of ['font', 'geometry', 'composition']) expect(existsSync(join(cacheDir, t, 'sha256%3A' + (t === 'font' ? 'aa' : t === 'geometry' ? 'bb' : 'dd')))).toBe(false);
    // Alte Ebenen gibt es nur für clear.
    const stats = await cli(['cache', 'stats', '.', '--tier', 'shader'], dir, env);
    expect(stats.code).toBe(2);
    expect(stats.stderr).toContain('Unknown tier "shader"');
  });
});

describe('--trust-proxy für serve, dev und studio (Politur P1)', () => {
  it('liest Flag und OPENVIDEO_TRUST_PROXY; Standard nur Loopback', async () => {
    expect(trustProxyOf(undefined, {})).toBe(false);
    expect(trustProxyOf(true, {})).toBe(true);
    expect(trustProxyOf(undefined, { OPENVIDEO_TRUST_PROXY: '1' })).toBe(true);
    expect(trustProxyOf(undefined, { OPENVIDEO_TRUST_PROXY: 'true' })).toBe(true);
    expect(trustProxyOf(undefined, { OPENVIDEO_TRUST_PROXY: '0' })).toBe(false);
    const help = await cli(['--help'], tmpdir(), {});
    expect(help.stdout).toContain('--trust-proxy');
    // Das Flag ist eine bekannte Option (kein Usage-Fehler beim Parsen).
    const r = await cli(['serve', '--trust-proxy', '--version'], tmpdir(), {});
    expect(r.code, r.stderr).toBe(0);
  });
});
