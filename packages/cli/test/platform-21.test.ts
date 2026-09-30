/**
 * Epic 21 in der CLI: Docker-Worker über `render --isolation docker` mit GPU-Quota (21.3),
 * Kurzmanifest (21.5), Compiler-Cache (21.2) und Asset Loader aus Plugins beim Import (21.1).
 * Kein Docker-Daemon nötig: ein Ersatz für `docker` (OPENVIDEO_DOCKER) protokolliert die Argumente
 * und startet den echten Worker im Stream-Modus.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { validateFrameManifest } from '@agentic-video/render';
import { createLocalServices, createSourceService, dockerSettingsFromEnv, helloSource, renderIsolationFromEnv, runCli } from '@agentic-video/cli';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function cli(args: string[], cwd: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env });
  return { code, stdout, stderr };
}

/** Ersatz für `docker`: schreibt die Argumente ins Protokoll; `run` startet den Worker lokal. */
function fakeDocker(dir: string): { bin: string; log: string } {
  const log = join(dir, 'docker.log');
  const bin = join(dir, 'docker');
  writeFileSync(bin, ['#!/bin/sh', `echo "$*" >> "${log}"`, 'if [ "$1" = "rm" ]; then exit 0; fi', `exec "${process.execPath}" "${join(root, 'packages', 'worker', 'dist', 'bin.js')}" --stdio`, ''].join('\n'));
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe('render --isolation docker (Story 21.3)', () => {
  it('rendert Chunks über den Docker-Runner mit GPU-Quota', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ov-cli-docker-'));
    expect((await cli(['create', 'demo'], work)).code).toBe(0);
    const dir = join(work, 'demo');
    const docker = fakeDocker(work);
    const r = await cli(['render', '.', '--isolation', 'docker', '--gpus', '0,1', '--workers', '2', '--width', '192', '--height', '108', '--end', '1s', '--json'], dir, { ...process.env, OPENVIDEO_DOCKER: docker.bin });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const out = JSON.parse(r.stdout) as { outputs: string[]; frames: number };
    expect(out.frames).toBe(30);
    expect(existsSync(out.outputs[0] ?? '')).toBe(true);
    const runs = readFileSync(docker.log, 'utf8').split('\n').filter((l) => l.startsWith('run '));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const line of runs) {
      expect(line).toContain('--network none --read-only');
      expect(line).toContain('--gpus "device=0,1"');
      expect(line).toMatch(/ghcr\.io\/deltatree\/openvideo-render-gpu:\S+ worker --stdio$/u);
    }
    const manifest = JSON.parse(readFileSync(`${out.outputs[0] ?? ''}.render-manifest.json`, 'utf8')) as { chunks: { worker?: string }[] };
    expect(manifest.chunks.every((c) => c.worker?.startsWith('docker-') === true)).toBe(true);
  }, 180_000);

  it('lehnt eine unbekannte Isolation ab (Exit-Code 2) und liest die Umgebung', async () => {
    expect((await cli(['render', '.', '--isolation', 'vm'], tmpdir())).code).toBe(2);
    expect(renderIsolationFromEnv({ OPENVIDEO_RENDER_ISOLATION: 'docker' })).toBe('docker');
    expect(() => renderIsolationFromEnv({ OPENVIDEO_RENDER_ISOLATION: 'vm' })).toThrow(/not a known isolation/u);
    expect(dockerSettingsFromEnv({})).toMatchObject({ image: expect.stringMatching(/openvideo-worker:/u) as unknown, command: ['--stdio'], browserGpu: false });
    expect(dockerSettingsFromEnv({ OPENVIDEO_WORKER_GPUS: 'all', OPENVIDEO_BROWSER_GPU: '1' })).toMatchObject({ image: expect.stringMatching(/openvideo-render-gpu:/u) as unknown, gpus: 'all', command: ['worker', '--stdio'], browserGpu: true });
    expect(dockerSettingsFromEnv({ OPENVIDEO_WORKER_IMAGE: 'my/worker:1', OPENVIDEO_WORKER_GPUS: 'all' })).toMatchObject({ image: 'my/worker:1', command: ['--stdio'] });
  });

  it('die Dienste (serve, mcp, Studio) nutzen den Docker-Runner mit OPENVIDEO_RENDER_ISOLATION=docker', async () => {
    const services = await createLocalServices({ workspaceDir: mkdtempSync(join(tmpdir(), 'ov-ws-')), env: { OPENVIDEO_RENDER_ISOLATION: 'docker' }, workers: 1 });
    try {
      expect(services.chunkRunner).toBeDefined();
    } finally {
      await services.dispose();
    }
  });
});

describe('Kurzmanifest in der CLI (Story 21.5)', () => {
  it('render-frame --manifest schreibt ein gültiges Kurzmanifest', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ov-cli-manifest-'));
    await cli(['create', 'demo'], work);
    const dir = join(work, 'demo');
    const r = await cli(['render-frame', '--frame', '1s', '--scale', '0.1', '--manifest', '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    const info = JSON.parse(r.stdout) as { manifest: string; file: string };
    expect(info.manifest).toBe(`${info.file}.manifest.json`);
    const manifest: unknown = JSON.parse(readFileSync(info.manifest, 'utf8'));
    expect(validateFrameManifest(manifest)).toEqual([]);
    expect(manifest).toMatchObject({ kind: 'frames', renderBackend: ['skia'], frames: [{ frame: 30 }] });
  }, 60_000);

  it('contact-sheet liefert das Kurzmanifest und schreibt es mit --manifest', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ov-cli-sheet-'));
    await cli(['create', 'demo'], work);
    const dir = join(work, 'demo');
    const r = await cli(['contact-sheet', '.', '--frames', '0,1s', '--manifest', '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    const result = JSON.parse(r.stdout) as { manifest: { frames: unknown[] }; manifestFile: string };
    expect(result.manifest.frames).toHaveLength(2);
    expect(validateFrameManifest(JSON.parse(readFileSync(result.manifestFile, 'utf8')))).toEqual([]);
  }, 60_000);
});

describe('Compiler-Cache über die CLI-Quellen (Story 21.2)', () => {
  it('legt den Compiler-Output in der Ebene compiled ab und nutzt ihn beim zweiten Kompilieren', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-cli-compiled-'));
    const cacheDir = join(dir, 'cache');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'video.tsx'), helloSource('cached'));
    const sources = createSourceService({ trusted: true, env: { OPENVIDEO_CACHE_DIR: cacheDir } });
    const first = await sources.compile(dir, 'src/video.tsx');
    const entries = readdirSync(join(cacheDir, 'compiled'));
    expect(entries).toHaveLength(1);
    const second = await sources.compile(dir, 'src/video.tsx');
    expect(second.project).toEqual(first.project);
    expect(readdirSync(join(cacheDir, 'compiled'))).toEqual(entries);
  }, 60_000);
});

describe('asset.import nutzt Asset Loader aus Plugins (Story 21.1)', () => {
  it('importiert eine CSV mit dem Loader des Projekt-Plugins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-cli-loader-'));
    cpSync(join(root, 'examples', 'plugin-hello'), join(dir, 'plugins', 'hello'), { recursive: true });
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'table.csv'), 'city,visitors\nBerlin,10\nParis,12\n');
    const project = {
      schemaVersion: SCHEMA_VERSION,
      settings: { plugins: ['./plugins/hello/index.mjs'] },
      compositions: [{ id: 'main', width: 32, height: 32, fps: 10, duration: 3, nodes: [] }],
    };
    const services = await createLocalServices({ workspaceDir: mkdtempSync(join(tmpdir(), 'ov-ws-')), env: { OPENVIDEO_ALLOW_PLUGINS: '1', OPENVIDEO_PLUGIN_PERMISSIONS: 'fs:read,fs:write' }, workers: 1 });
    try {
      const assets = services.assets;
      if (assets === undefined) throw new Error('asset service missing');
      const imported = await assets.import(dir, { path: 'data/table.csv', id: 'table' }, project);
      expect(imported).toMatchObject({ id: 'table', type: 'data' });
      expect(imported.metadata).toMatchObject({ loader: 'hello-csv', rows: 2, header: ['city', 'visitors'] });
    } finally {
      await services.dispose();
    }
  }, 60_000);
});
