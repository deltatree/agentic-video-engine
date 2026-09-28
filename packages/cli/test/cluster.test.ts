import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { createNodeEnvironment, renderVideo } from '@agentic-video/render';
import { startCoordinator } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { runWorkerHttp } from '@agentic-video/worker';
import { createLocalServices, runCli, telemetryFromEnv } from '@agentic-video/cli';

const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 160,
      height: 90,
      fps: 10,
      duration: '2s',
      background: '#101418',
      nodes: [{ id: 'dot', type: 'ellipse', width: 20, height: 20, y: 35, fill: '#FF5A1F', x: { $keyframes: [{ t: 0, v: 0 }, { t: '2s', v: 140 }] } }],
    },
  ],
};
const quiet = () => createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}

describe('Betrieb im Cluster', () => {
  it('rendert über OPENVIDEO_COORDINATOR_URL mit Pull-Workern dieselben Frames wie lokal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-cluster-'));
    const shared = new FileStore(join(dir, 'shared'));
    const token = 'cluster-token';
    const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store: shared, journalDir: join(dir, 'journal'), token });
    const stop = new AbortController();
    const workers = ['w1', 'w2'].map((name) => runWorkerHttp({ coordinatorUrl: coordinator.url, token, store: shared, worker: name, signal: stop.signal, pollIntervalMs: 50, telemetry: quiet() }));
    const services = await createLocalServices({ workspaceDir: join(dir, 'ws'), env: { OPENVIDEO_COORDINATOR_URL: coordinator.url, OPENVIDEO_WORKER_TOKEN: token }, telemetry: quiet() });
    try {
      const projectDir = join(dir, 'project');
      mkdirSync(projectDir);
      const env = await createNodeEnvironment({ projectDir, project, cache: createCache(shared), telemetry: quiet() });
      const runChunks = services.chunkRunner?.(env, project);
      expect(runChunks).toBeDefined();
      const remote = await renderVideo(env, project, { outPath: join(dir, 'out', 'remote.mp4'), profile: { format: 'mp4' }, chunkSize: 5, noAudio: true, ...(runChunks !== undefined ? { runChunks } : {}) });
      const localEnv = await createNodeEnvironment({ projectDir, project, cache: createCache(new FileStore(join(dir, 'local'))), telemetry: quiet() });
      const local = await renderVideo(localEnv, project, { outPath: join(dir, 'out', 'local.mp4'), profile: { format: 'mp4' }, noAudio: true });
      expect(remote.manifest.frameHashes).toEqual(local.manifest.frameHashes);
      await env.dispose();
      await localEnv.dispose();
      // Die Pull-Worker haben alle 4 Chunks (20 Frames, je 5) abgearbeitet.
      stop.abort();
      const summaries = await Promise.all(workers);
      expect(summaries.reduce((n, w) => n + w.completed, 0)).toBe(4);
    } finally {
      stop.abort();
      await Promise.allSettled(workers);
      await services.dispose();
      await coordinator.close();
    }
  }, 180_000);

  it('startet den Koordinator per CLI und verweigert 0.0.0.0 ohne Token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-coord-'));
    let stderr = '';
    const refused = await runCli(['coordinator', '--host', '0.0.0.0', '--port', '0'], { stdout: () => undefined, stderr: (t) => (stderr += t), cwd: dir, env: { PATH: process.env['PATH'] } });
    expect(refused).toBe(1);
    expect(stderr).toContain('without a token');
    let stdout = '';
    let release = (): void => undefined;
    const stopped = new Promise<void>((r) => {
      release = r;
    });
    const running = runCli(['coordinator', '--port', '0', '--token', 't', '--json'], { stdout: (t) => (stdout += t), stderr: () => undefined, cwd: dir, env: { PATH: process.env['PATH'] }, stop: stopped });
    for (let i = 0; i < 200 && !stdout.includes('url'); i++) await new Promise((r) => setTimeout(r, 25));
    const { url } = JSON.parse(stdout) as { url: string };
    const queue = await fetch(`${url}/v1/queue`, { headers: { authorization: 'Bearer t' } });
    expect(queue.status).toBe(200);
    release();
    expect(await running).toBe(0);
  });

  it('exportiert Metriken für Prometheus und lehnt unbekannte Exporter ab', async () => {
    expect(() => telemetryFromEnv({ OPENVIDEO_METRICS: 'graphite' })).toThrow(/not a known exporter/u);
    const port = await freePort();
    const telemetry = telemetryFromEnv({ OPENVIDEO_METRICS: 'prometheus', OPENVIDEO_METRICS_PORT: String(port) });
    try {
      let status = 0;
      for (let i = 0; i < 100 && status !== 200; i++) {
        status = await fetch(`http://127.0.0.1:${String(port)}/metrics`).then((r) => r.status, () => 0);
        if (status !== 200) await new Promise((r) => setTimeout(r, 50));
      }
      expect(status).toBe(200);
    } finally {
      await telemetry.shutdown();
    }
  });
});
