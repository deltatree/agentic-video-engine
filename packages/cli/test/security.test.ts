import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import type { NodeEnvironment, NodeEnvironmentOptions } from '@agentic-video/render';
import { createLocalServices, createProjectDir, helloProject, htmlScriptsAllowed, projectDirOf, runCli, singleProjectWorkspace } from '@agentic-video/cli';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ov-cli-sec-'));
}

interface FakeEnv {
  readonly options: NodeEnvironmentOptions;
  disposed: number;
}

/** Fabrik für Umgebungen ohne echte Renderer; zählt Aufräumen. */
function fakeFactory(made: FakeEnv[], failures: { remaining: number; disposeThrows?: boolean } = { remaining: 0 }) {
  return (options: NodeEnvironmentOptions): Promise<NodeEnvironment> => {
    if (failures.remaining > 0) {
      failures.remaining--;
      return Promise.reject(new Error('boom'));
    }
    const record: FakeEnv = { options, disposed: 0 };
    made.push(record);
    const env = {
      dispose: () => {
        record.disposed++;
        return failures.disposeThrows === true ? Promise.reject(new Error('dispose failed')) : Promise.resolve();
      },
    };
    // Die Tests brauchen nur dispose; die übrigen Felder greifen sie nicht an.
    return Promise.resolve(env as unknown as NodeEnvironment);
  };
}

const project = (n: number): Record<string, unknown> => ({ schemaVersion: '1.0.0', assets: [{ id: `a${String(n)}`, type: 'image', src: `assets/${String(n)}.png` }], compositions: [] });

describe('B14: Umgebungs-LRU mit Referenzzählung', () => {
  it('entsorgt keine Umgebung, die noch in Benutzung ist', async () => {
    const made: FakeEnv[] = [];
    const services = await createLocalServices({ workspaceDir: tmp(), createEnvironment: fakeFactory(made) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const busy = services.withEnvironment('/p0', project(0), () => gate);
    for (let i = 1; i <= 6; i++) await services.withEnvironment(`/p${String(i)}`, project(i), () => Promise.resolve());
    expect(made[0]?.disposed).toBe(0);
    release();
    await busy;
    await services.withEnvironment('/p7', project(7), () => Promise.resolve());
    expect(made[0]?.disposed).toBe(1);
    await services.dispose();
    expect(made.every((m) => m.disposed === 1)).toBe(true);
  });

  it('merkt sich keine abgelehnte Umgebung', async () => {
    const made: FakeEnv[] = [];
    const services = await createLocalServices({ workspaceDir: tmp(), createEnvironment: fakeFactory(made, { remaining: 1 }) });
    await expect(services.withEnvironment('/p', project(1), () => Promise.resolve())).rejects.toThrow('boom');
    await services.withEnvironment('/p', project(1), () => Promise.resolve());
    expect(made).toHaveLength(1);
    await services.dispose();
  });

  it('dispose räumt alle auf, auch wenn eine Umgebung scheitert', async () => {
    const made: FakeEnv[] = [];
    const services = await createLocalServices({ workspaceDir: tmp(), createEnvironment: fakeFactory(made, { remaining: 0, disposeThrows: true }) });
    await services.withEnvironment('/a', project(1), () => Promise.resolve());
    await services.withEnvironment('/b', project(2), () => Promise.resolve());
    await expect(services.dispose()).resolves.toBeUndefined();
    expect(made.map((m) => m.disposed)).toEqual([1, 1]);
  });

  it('reicht offline und die Skript-Freigabe an die Umgebung durch', async () => {
    const made: FakeEnv[] = [];
    const services = await createLocalServices({ workspaceDir: tmp(), offline: true, createEnvironment: fakeFactory(made), env: {} });
    await services.withEnvironment('/a', project(1), () => Promise.resolve());
    expect(made[0]?.options.offline).toBe(true);
    expect(made[0]?.options.allowHtmlScripts).toBe(false);
    expect(made[0]?.options.allowOutsidePaths).not.toBe(true);
    await services.dispose();
  });
});

describe('A18: Cache-Pfad der lokalen Dienste', () => {
  it('nutzt immer storeFromEnv: OPENVIDEO_CACHE_DIR oder <workspace>/.openvideo/cache', async () => {
    const made: FakeEnv[] = [];
    const ws = tmp();
    const custom = join(tmp(), 'cache');
    const a = await createLocalServices({ workspaceDir: ws, createEnvironment: fakeFactory(made), env: { OPENVIDEO_CACHE_DIR: custom } });
    await a.withEnvironment('/a', project(1), () => Promise.resolve());
    expect(made[0]?.options.cache?.store.name).toBe(`file:${custom}`);
    await a.dispose();
    const b = await createLocalServices({ workspaceDir: ws, createEnvironment: fakeFactory(made), env: {} });
    await b.withEnvironment('/a', project(1), () => Promise.resolve());
    expect(made[1]?.options.cache?.store.name).toBe(`file:${ws}/.openvideo/cache`);
    await b.dispose();
  });
});

describe('Skripte in HTML nur ausdrücklich (Story 16.1, H1)', () => {
  it('htmlScriptsAllowed: --trusted oder OPENVIDEO_ALLOW_HTML_SCRIPTS=1, nie über das Container-Image', () => {
    expect(htmlScriptsAllowed('container', {})).toBe(false);
    expect(htmlScriptsAllowed('trusted', {})).toBe(true);
    expect(htmlScriptsAllowed('container', { OPENVIDEO_CONTAINER_IMAGE: 'ghcr.io/x/openvideo-studio:1' })).toBe(false);
    expect(htmlScriptsAllowed('container', { OPENVIDEO_ALLOW_HTML_SCRIPTS: '1' })).toBe(true);
    expect(htmlScriptsAllowed('container', { OPENVIDEO_ALLOW_HTML_SCRIPTS: 'true' })).toBe(false);
    expect(htmlScriptsAllowed('container', { OPENVIDEO_ALLOW_HTML_SCRIPTS: '0' })).toBe(false);
  });

  it('die Dienste im Image (OPENVIDEO_CONTAINER_IMAGE gesetzt) erlauben keine Skripte', async () => {
    const made: FakeEnv[] = [];
    const services = await createLocalServices({ workspaceDir: tmp(), createEnvironment: fakeFactory(made), env: { OPENVIDEO_CONTAINER_IMAGE: 'ghcr.io/x/openvideo-render-cpu:1' } });
    await services.withEnvironment('/a', project(1), () => Promise.resolve());
    expect(made[0]?.options.allowHtmlScripts).toBe(false);
    await services.dispose();
  });
});

describe('B6: allowOutsidePaths nie für Server-Dienste', () => {
  it('asset.import über die Dienste lehnt Pfade außerhalb ab, auch mit trusted', async () => {
    const root = tmp();
    const dir = await createProjectDir(join(root, 'p'), { project: helloProject('P') });
    writeFileSync(join(root, 'secret.png'), 'x');
    const services = await createLocalServices({ workspaceDir: join(root, 'ws'), isolation: 'trusted' });
    try {
      await expect(services.assets?.import(dir, { path: join(root, 'secret.png') })).rejects.toMatchObject({ diagnostic: { code: 'OV_PATH_OUTSIDE' } });
    } finally {
      await services.dispose();
    }
  });
});

describe('B15: Projektordner der CLI', () => {
  it('findet Projektordner und Einstieg für Dateien in src/', () => {
    const root = tmp();
    mkdirSync(join(root, 'proj', 'src'), { recursive: true });
    writeFileSync(join(root, 'proj', 'openvideo.json'), '{"name":"p","entry":"src/video.tsx"}');
    expect(projectDirOf(join(root, 'proj', 'src', 'other.tsx'))).toEqual({ dir: join(root, 'proj'), entry: 'src/other.tsx' });
    mkdirSync(join(root, 'src', 'plain'), { recursive: true });
    expect(projectDirOf(join(root, 'src', 'plain', 'project.json'))).toEqual({ dir: join(root, 'src', 'plain'), entry: 'project.json' });
  });

  it('createProjectDir lehnt files mit ".." ab', async () => {
    const root = tmp();
    await expect(createProjectDir(join(root, 'p'), { project: helloProject('P'), files: { '../escape.txt': 'x' } })).rejects.toMatchObject({ diagnostic: { code: 'OV_PATH_OUTSIDE' } });
    expect(existsSync(join(root, 'escape.txt'))).toBe(false);
  });

  it('createProjectDir überschreibt keine Nutzerdateien', async () => {
    const root = tmp();
    const dir = join(root, 'p');
    mkdirSync(dir);
    writeFileSync(join(dir, 'AGENTS.md'), 'mine');
    await expect(createProjectDir(dir, { project: helloProject('P') })).rejects.toBeInstanceOf(OpenVideoError);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(dir, 'project.json'))).toBe(false);
  });

  it('singleProjectWorkspace kürzt lange IDs auf 63 Zeichen', async () => {
    const root = tmp();
    const dir = join(root, `${'Very-Long-Project-Name-'.repeat(5)}X`);
    mkdirSync(dir);
    const { projectId } = await singleProjectWorkspace(dir);
    expect(projectId).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/u);
  });

  it('singleProjectWorkspace ersetzt einen hängenden Symlink', async () => {
    const root = tmp();
    const dir = join(root, 'proj');
    mkdirSync(dir);
    const link = join(dir, '.openvideo', 'workspace', 'projects', 'proj');
    mkdirSync(join(dir, '.openvideo', 'workspace', 'projects'), { recursive: true });
    const gone = join(root, 'gone');
    mkdirSync(gone);
    symlinkSync(gone, link, 'dir');
    rmSync(gone, { recursive: true });
    await singleProjectWorkspace(dir);
    expect(readlinkSync(link)).toBe(dir);
  });
});

describe('B1 und B2: dev/studio mit Token, serve nicht offen im Netz', () => {
  it('dev erzeugt ein zufälliges Token und verlangt es', async () => {
    const root = tmp();
    await runCli(['create', 'demo'], { stdout: () => undefined, stderr: () => undefined, cwd: root, env: {} });
    let stdout = '';
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const done = runCli(['dev', join(root, 'demo'), '--port', '0'], { stdout: (t) => (stdout += t), stderr: () => undefined, cwd: root, env: {}, stop: stopped });
    for (let i = 0; i < 200 && !stdout.includes('token='); i++) await new Promise((r) => setTimeout(r, 25));
    const api = /(http:\/\/127\.0\.0\.1:\d+)\/v1\/operations/u.exec(stdout)?.[1];
    const token = /token=([A-Za-z0-9_-]+)/u.exec(stdout)?.[1];
    expect(api).toBeDefined();
    expect(token?.length).toBeGreaterThanOrEqual(32);
    expect((await fetch(`${api ?? ''}/v1/operations`)).status).toBe(401);
    expect((await fetch(`${api ?? ''}/v1/operations`, { headers: { authorization: `Bearer ${token ?? ''}` } })).status).toBe(200);
    stop();
    expect(await done).toBe(0);
  });

  it('serve bricht ohne Token auf 0.0.0.0 mit Diagnose ab', async () => {
    let stdout = '';
    const code = await runCli(['serve', '--host', '0.0.0.0', '--port', '0', '--workspace', tmp(), '--json'], { stdout: (t) => (stdout += t), stderr: () => undefined, cwd: tmp(), env: {} });
    expect(code).toBe(1);
    expect((JSON.parse(stdout) as { error: { code: string } }).error.code).toBe('OV_API_TOKEN_REQUIRED');
  });
});
