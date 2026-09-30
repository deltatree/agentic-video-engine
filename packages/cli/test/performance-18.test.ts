/**
 * Nacharbeiten Epic 16 und Story 18.7 in der CLI: Rollen-Tokens für `openvideo coordinator`,
 * Standard-Worker-Zahl und `doctor` ohne unsichere Chromium-Schalter außerhalb der Grafik-Probe.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWorkerCount } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { createLocalServices, runCli, runDoctor } from '@agentic-video/cli';

const SUBMIT = 'submit-role-token-0123456789ab';
const WORKER = 'worker-role-token-0123456789ab';
const METRICS = 'metrics-role-token-0123456789a';

describe('openvideo coordinator mit Rollen-Tokens (Story 16.3)', () => {
  it('liest OPENVIDEO_SUBMIT_TOKEN, OPENVIDEO_WORKER_TOKEN und OPENVIDEO_METRICS_TOKEN und trennt die Rollen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-coord-roles-'));
    let stdout = '';
    let release = (): void => undefined;
    const stopped = new Promise<void>((r) => {
      release = r;
    });
    const env = { PATH: process.env['PATH'], OPENVIDEO_SUBMIT_TOKEN: SUBMIT, OPENVIDEO_WORKER_TOKEN: WORKER, OPENVIDEO_METRICS_TOKEN: METRICS };
    const running = runCli(['coordinator', '--port', '0', '--json'], { stdout: (t) => (stdout += t), stderr: () => undefined, cwd: dir, env, stop: stopped });
    for (let i = 0; i < 200 && !stdout.includes('url'); i++) await new Promise((r) => setTimeout(r, 25));
    const parsed: unknown = JSON.parse(stdout);
    const url = typeof parsed === 'object' && parsed !== null && 'url' in parsed && typeof parsed.url === 'string' ? parsed.url : '';
    const get = (path: string, token: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
    expect(await get('/v1/queue', METRICS)).toBe(200);
    expect(await get('/v1/queue', SUBMIT)).toBe(200);
    // Das Worker-Token darf die Queue nicht lesen, das Metrik-Token keine Leases holen.
    expect(await get('/v1/queue', WORKER)).toBe(403);
    const lease = await fetch(`${url}/v1/lease`, { method: 'POST', headers: { authorization: `Bearer ${METRICS}`, 'content-type': 'application/json' }, body: '{}' });
    expect(lease.status).toBe(403);
    const workerLease = await fetch(`${url}/v1/lease`, { method: 'POST', headers: { authorization: `Bearer ${WORKER}`, 'content-type': 'application/json' }, body: '{}' });
    expect(workerLease.status).toBe(204);
    release();
    expect(await running).toBe(0);
  });

  it('verweigert 0.0.0.0 ohne jedes Token und nennt die Rollen-Variablen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-coord-none-'));
    let stderr = '';
    const code = await runCli(['coordinator', '--host', '0.0.0.0', '--port', '0'], { stdout: () => undefined, stderr: (t) => (stderr += t), cwd: dir, env: { PATH: process.env['PATH'] } });
    expect(code).toBe(1);
    expect(stderr).toContain('OPENVIDEO_SUBMIT_TOKEN');
  });
});

describe('Standard-Parallelität (Story 18.7)', () => {
  it('Dienste rendern ohne --workers mit der Standardzahl, mit --workers 1 im Prozess', async () => {
    const quiet = createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });
    const dir = mkdtempSync(join(tmpdir(), 'ov-workers-'));
    const standard = await createLocalServices({ workspaceDir: join(dir, 'a'), env: {}, telemetry: quiet });
    const single = await createLocalServices({ workspaceDir: join(dir, 'b'), env: {}, telemetry: quiet, workers: 1 });
    try {
      expect(standard.chunkRunner !== undefined).toBe(defaultWorkerCount() > 1);
      expect(single.chunkRunner).toBeUndefined();
    } finally {
      await standard.dispose();
      await single.dispose();
    }
  });
});

describe('doctor (Nacharbeit Epic 16)', () => {
  it('prüft die OS-Sandbox getrennt von der Grafik-Probe', async () => {
    const checks = await runDoctor({ projectDir: mkdtempSync(join(tmpdir(), 'ov-doctor-')) });
    const browser = checks.find((c) => c.name === 'browser');
    if (browser?.status === 'ok') expect(checks.some((c) => c.name === 'browser-sandbox')).toBe(true);
    else expect(checks.some((c) => c.name === 'browser-sandbox')).toBe(false);
  }, 120_000);
});
