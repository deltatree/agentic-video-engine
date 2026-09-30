/**
 * ADR 0029: OpenVideo im Container des Wrappers aus `npm run setup`.
 * - `OPENVIDEO_PUBLIC_URL`: Links zeigen auf die veröffentlichte Loopback-Adresse statt auf 0.0.0.0.
 * - `OPENVIDEO_WATCH_POLL_MS`: Datei-Watcher fragt ab, wo Bind-Mounts keine inotify-Ereignisse liefern.
 * - `OPENVIDEO_RUNTIME_INFO`: doctor meldet die Laufzeit.
 * - Leeres `OPENVIDEO_WORKSPACE` (Image openvideo-local) gilt als nicht gesetzt.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectContext, publicBaseUrl, runCli, runtimeCheck, watchPollMsFromEnv, watchProject, type WatchEvent } from '@agentic-video/cli';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ov-rt29-'));
}

const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  for (let waited = 0; !check(); waited += 25) {
    if (waited > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('publicBaseUrl', () => {
  it('nimmt OPENVIDEO_PUBLIC_URL (nur Origin), sonst die Server-Adresse', () => {
    expect(publicBaseUrl('http://0.0.0.0:7788', { OPENVIDEO_PUBLIC_URL: 'http://127.0.0.1:7788' })).toBe('http://127.0.0.1:7788');
    expect(publicBaseUrl('http://0.0.0.0:7788', { OPENVIDEO_PUBLIC_URL: 'http://127.0.0.1:7788/' })).toBe('http://127.0.0.1:7788');
    expect(publicBaseUrl('http://127.0.0.1:7788', {})).toBe('http://127.0.0.1:7788');
    for (const bad of ['javascript:alert(1)', 'http://x/path', 'http://x/?q=1', 'http://u:p@x', 'nonsense', 'http://x/#f']) {
      expect(publicBaseUrl('http://0.0.0.0:1', { OPENVIDEO_PUBLIC_URL: bad }), bad).toBe('http://0.0.0.0:1');
    }
  });

  it('dev gibt Studio- und API-Link mit der öffentlichen Adresse aus', async () => {
    const root = tmp();
    await runCli(['create', 'demo'], { stdout: () => undefined, stderr: () => undefined, cwd: root, env: {} });
    const studio = tmp();
    writeFileSync(join(studio, 'index.html'), '<!doctype html><title>Studio</title>');
    let stdout = '';
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const done = runCli(['dev', join(root, 'demo'), '--port', '0', '--no-open', '--token', 'tok-0123456789abcdefghijklmnop'], {
      stdout: (t) => (stdout += t),
      stderr: () => undefined,
      cwd: root,
      env: { OPENVIDEO_STUDIO_DIR: studio, OPENVIDEO_PUBLIC_URL: 'http://127.0.0.1:7788' },
      stop: stopped,
    });
    await until(() => stdout.includes('Watching'), 30_000);
    stop();
    expect(await done).toBe(0);
    expect(stdout).toContain('OpenVideo API: http://127.0.0.1:7788/v1/operations');
    expect(stdout).toContain('OpenVideo Studio: http://127.0.0.1:7788/?project=demo#token=tok-0123456789abcdefghijklmnop');
  });
});

describe('Datei-Watcher mit Abfrage (OPENVIDEO_WATCH_POLL_MS)', () => {
  it('liest das Intervall aus der Umgebung (mindestens 100 ms, 0 = aus)', () => {
    expect(watchPollMsFromEnv({ OPENVIDEO_WATCH_POLL_MS: '1000' })).toBe(1000);
    expect(watchPollMsFromEnv({ OPENVIDEO_WATCH_POLL_MS: '5' })).toBe(100);
    expect(watchPollMsFromEnv({ OPENVIDEO_WATCH_POLL_MS: '0' })).toBeUndefined();
    expect(watchPollMsFromEnv({ OPENVIDEO_WATCH_POLL_MS: 'fast' })).toBeUndefined();
    expect(watchPollMsFromEnv({})).toBeUndefined();
  });

  // src/ entsteht erst nach dem Start: Kein Dateiereignis erreicht den Watcher, nur die Abfrage findet die Datei.
  const scenario = async (pollMs: number | undefined): Promise<WatchEvent[]> => {
    const dir = tmp();
    const events: WatchEvent[] = [];
    const watcher = watchProject({ dir, entry: 'src/video.tsx', debounceMs: 20, ...(pollMs !== undefined ? { pollMs } : {}), onEvent: (e) => events.push(e) });
    try {
      await new Promise((r) => setTimeout(r, 150));
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'video.tsx'), 'export default 1;');
      await new Promise((r) => setTimeout(r, 800));
      await watcher.idle();
      return events;
    } finally {
      watcher.close();
    }
  };

  it('ohne Abfrage bleibt eine solche Änderung unbemerkt', async () => {
    expect(await scenario(undefined)).toEqual([]);
  });

  it('mit Abfrage meldet der Watcher die neue Datei', async () => {
    const events = await scenario(100);
    expect(events.map((e) => [e.kind, e.file])).toEqual([['error', 'src/video.tsx']]);
    expect(events[0]?.kind === 'error' ? events[0].diagnostics[0]?.code : '').toBe('OV_SOURCE_UNAVAILABLE');
  });
});

describe('doctor und Workspace im Container', () => {
  it('runtimeCheck nennt die Laufzeit des Wrappers oder native', () => {
    expect(runtimeCheck('docker, image openvideo-local:0.1.0')).toEqual({ status: 'ok', detail: 'docker, image openvideo-local:0.1.0' });
    expect(runtimeCheck(undefined)).toEqual({ status: 'ok', detail: 'native (this host)' });
    expect(runtimeCheck('  ')).toEqual({ status: 'ok', detail: 'native (this host)' });
  });

  it('leeres OPENVIDEO_WORKSPACE gilt als nicht gesetzt', async () => {
    const cwd = tmp();
    expect((await projectContext({ cwd, env: { OPENVIDEO_WORKSPACE: '' } })).workspaceDir).toBe(join(cwd, '.openvideo-workspace'));
    expect((await projectContext({ cwd, env: { OPENVIDEO_WORKSPACE: 'ws' } })).workspaceDir).toBe(join(cwd, 'ws'));
    // --project ohne Workspace: Ein-Projekt-Workspace im Projekt, auch mit leerem OPENVIDEO_WORKSPACE.
    await runCli(['create', 'demo'], { stdout: () => undefined, stderr: () => undefined, cwd, env: {} });
    const ctx = await projectContext({ project: 'demo', cwd, env: { OPENVIDEO_WORKSPACE: '' } });
    expect(ctx.workspaceDir.startsWith(join(cwd, 'demo'))).toBe(true);
  });
});
