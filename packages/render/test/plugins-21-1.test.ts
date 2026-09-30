/**
 * Story 21.1: Plugins aus `settings.plugins` wirken – Laden mit Rechteprüfung, Asset Loader in der
 * Asset-Pipeline, Codec im Encoder, Exporter als eigenes Ausgabeformat. Nutzt examples/plugin-hello.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { OpenVideoError, Registry, SCHEMA_VERSION } from '@agentic-video/core';
import { checkCustomCodecArgs, locateFfmpeg } from '@agentic-video/ffmpeg';
import { createNodeEnvironment, pluginHostServices, pluginPolicyFromEnv, renderVideo, resolvePluginModule, type NodeEnvironment } from '@agentic-video/render';
import { skipUnless } from '@agentic-video/testing';

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'plugin-hello');

function hasFfmpeg(): boolean {
  try {
    locateFfmpeg();
    return true;
  } catch {
    return false;
  }
}
const ffmpegFound = hasFfmpeg();

function project(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { plugins: ['./plugins/hello/index.mjs'] },
    assets: [{ id: 'table', type: 'data', src: 'data/table.csv' }],
    compositions: [{ id: 'main', width: 32, height: 32, fps: 10, duration: 3, background: '#102030', nodes: [{ id: 'box', type: 'rect', x: 4, y: 4, width: 12, height: 12, fill: '#FF0000' }] }],
    ...extra,
  };
}

/** Projektordner mit dem Beispiel-Plugin unter plugins/hello und einer CSV-Datei. */
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ov-plugins-'));
  cpSync(EXAMPLE, join(dir, 'plugins', 'hello'), { recursive: true });
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'table.csv'), 'city,visitors\nBerlin,10\nParis,12\n');
  return dir;
}

async function withEnv<T>(dir: string, p: Record<string, unknown>, options: { load: boolean; permissions: ('fs:read' | 'fs:write')[] }, fn: (env: NodeEnvironment) => Promise<T>): Promise<T> {
  const env = await createNodeEnvironment({ projectDir: dir, project: p, cache: createCache(new MemoryStore()), skipDefaultProviders: true, plugins: options, env: {} });
  try {
    return await fn(env);
  } finally {
    await env.dispose();
  }
}

function errorSync(fn: () => unknown): OpenVideoError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof OpenVideoError) return error;
    throw error;
  }
  throw new Error('expected OpenVideoError, nothing was thrown');
}

async function errorOf(p: Promise<unknown>): Promise<OpenVideoError> {
  const error: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof OpenVideoError)) throw new Error(`expected OpenVideoError, got ${String(error)}`);
  return error;
}

describe('Plugins laden (Rechte, ADR 0012)', () => {
  it('lädt keine Plugin-Module ohne Erlaubnis des Hosts', async () => {
    const e = await errorOf(withEnv(projectDir(), project(), { load: false, permissions: [] }, () => Promise.resolve()));
    expect(e.diagnostic.code).toBe('OV_PLUGIN_NOT_ALLOWED');
  });

  it('bricht ab, wenn angeforderte Rechte nicht gewährt sind', async () => {
    const e = await errorOf(withEnv(projectDir(), project(), { load: true, permissions: ['fs:read'] }, () => Promise.resolve()));
    expect(e.diagnostic.code).toBe('OV_PLUGIN_PERMISSION');
    expect(e.diagnostic.details).toEqual({ plugin: 'hello', permission: 'fs:write' });
  });

  it('lädt mit gewährten Rechten und registriert alle Arten', async () => {
    await withEnv(projectDir(), project(), { load: true, permissions: ['fs:read', 'fs:write'] }, (env) => {
      expect(env.registry.plugins.map((p) => p.name)).toEqual(['hello']);
      expect([...env.registry.agentTools.keys()]).toEqual(['hello.greet']);
      expect([...env.registry.codecs.keys()]).toEqual(['x264-fast']);
      expect([...env.registry.exporters.keys()]).toEqual(['hello-frames']);
      expect([...env.registry.assetLoaders.keys()]).toEqual(['hello-csv']);
      expect(env.registry.studioPanels.get('hello-panel')?.plugin).toBe('hello');
      expect(env.versions['plugin:hello']).toBe('1.0.0');
      return Promise.resolve();
    });
  });

  it('Politik aus der Umgebung: laden mit trusted oder OPENVIDEO_ALLOW_PLUGINS=1, Rechte nur ausdrücklich', () => {
    expect(pluginPolicyFromEnv({}, false)).toEqual({ load: false, permissions: [] });
    expect(pluginPolicyFromEnv({}, true)).toEqual({ load: true, permissions: [] });
    expect(pluginPolicyFromEnv({ OPENVIDEO_ALLOW_PLUGINS: '1', OPENVIDEO_PLUGIN_PERMISSIONS: 'fs:read, net' }, false)).toEqual({ load: true, permissions: ['fs:read', 'net'] });
    expect(() => pluginPolicyFromEnv({ OPENVIDEO_PLUGIN_PERMISSIONS: 'root' }, true)).toThrow(/unknown permissions/u);
  });

  it('löst Module im Projekt und aus node_modules auf, nicht außerhalb', () => {
    const dir = projectDir();
    expect(resolvePluginModule(dir, './plugins/hello/index.mjs')).toMatch(/plugins[/\\]hello[/\\]index\.mjs$/u);
    cpSync(EXAMPLE, join(dir, 'node_modules', 'openvideo-plugin-hello'), { recursive: true });
    expect(resolvePluginModule(dir, 'openvideo-plugin-hello')).toMatch(/openvideo-plugin-hello[/\\]index\.mjs$/u);
    expect(() => resolvePluginModule(dir, 'missing-plugin')).toThrow(/not found/u);
  });

  it('lehnt eine existierende Moduldatei außerhalb des Projekts mit OV_PATH_OUTSIDE ab (Review Q9)', () => {
    const dir = projectDir();
    const other = `${dir}-other`;
    mkdirSync(other);
    writeFileSync(join(other, 'x.mjs'), 'export default {};\n');
    const e = errorSync(() => resolvePluginModule(dir, `../${dir.split(/[/\\]/u).pop() ?? ''}-other/x.mjs`));
    expect(e.diagnostic.code).toBe('OV_PATH_OUTSIDE');
    // Mit allowOutsidePaths erlaubt: die Datei existiert also wirklich.
    expect(resolvePluginModule(dir, `../${dir.split(/[/\\]/u).pop() ?? ''}-other/x.mjs`, true)).toMatch(/-other[/\\]x\.mjs$/u);
  });

  it('lehnt einen Symlink im Projekt auf ein Modul außerhalb ab (Review Q9)', () => {
    const dir = projectDir();
    const outside = mkdtempSync(join(tmpdir(), 'ov-plugins-outside-'));
    writeFileSync(join(outside, 'evil.mjs'), 'export default {};\n');
    symlinkSync(join(outside, 'evil.mjs'), join(dir, 'plugins', 'evil.mjs'));
    expect(errorSync(() => resolvePluginModule(dir, './plugins/evil.mjs')).diagnostic.code).toBe('OV_PATH_OUTSIDE');
  });

  it('ein Plugin-Name darf nur einmal geladen werden; Namen von Werkzeugen sind geprüft', async () => {
    const registry = new Registry();
    const plugin = { name: 'x', version: '1', permissions: [], setup: () => undefined };
    await registry.use(plugin);
    await expect(registry.use(plugin)).rejects.toMatchObject({ diagnostic: { code: 'OV_REGISTRY_DUPLICATE' } });
    expect(() => {
      registry.registerAgentTool({ name: 'bad name', description: '', inputSchema: { type: 'object', properties: {} } as never, handler: () => Promise.resolve(null) });
    }).toThrow(/not valid/u);
  });
});

describe('Asset Loader in der Asset-Pipeline', () => {
  it('liefert Typ und Metadaten aus dem Plugin', async () => {
    await withEnv(projectDir(), project(), { load: true, permissions: ['fs:read', 'fs:write'] }, (env) => {
      const table = env.assets.get('table');
      expect(table?.type).toBe('data');
      expect(table?.metadata).toMatchObject({ header: ['city', 'visitors'], rows: 2, loader: 'hello-csv' });
      return Promise.resolve();
    });
  });
});

describe.skipIf(skipUnless(ffmpegFound, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('Codec und Exporter beim Video-Render', () => {
  it('Exporter: format plugin:hello-frames schreibt das eigene Format mit allen Frames', async () => {
    const dir = projectDir();
    await withEnv(dir, project(), { load: true, permissions: ['fs:read', 'fs:write'] }, async (env) => {
      const outPath = join(dir, 'out', 'video.ovhf');
      const r = await renderVideo(env, project(), { outPath, profile: { format: 'plugin:hello-frames' } });
      expect(r.outputs).toEqual([outPath]);
      const bytes = readFileSync(outPath);
      const head = bytes.subarray(0, bytes.indexOf(10)).toString('utf8');
      expect(head).toBe('OVHF1 {"width":32,"height":32,"fps":10,"frames":3}');
      expect(existsSync(`${outPath}.frames`)).toBe(false);
      expect(r.manifest.encoder?.name).toBe('plugin:hello-frames');
    });
  }, 120_000);

  it('Codec: codec plugin:x264-fast nutzt die Argumente des Plugins und steht im Manifest', async () => {
    const dir = projectDir();
    await withEnv(dir, project(), { load: true, permissions: ['fs:read', 'fs:write'] }, async (env) => {
      const outPath = join(dir, 'out', 'video.mp4');
      const r = await renderVideo(env, project(), { outPath, profile: { format: 'mp4', codec: 'plugin:x264-fast' }, noAudio: true });
      expect(existsSync(outPath)).toBe(true);
      expect(r.manifest.encoder?.args).toContain('ultrafast');
      expect(r.manifest.codecLicenses['plugin:x264-fast']).toBe('GPL-2.0-or-later (libx264)');
      const e = await errorOf(renderVideo(env, project(), { outPath: join(dir, 'out', 'v.webm'), profile: { format: 'webm', codec: 'plugin:x264-fast' }, noAudio: true }));
      expect(e.diagnostic.code).toBe('OV_ENCODE_CODEC_UNSUPPORTED');
      const unknown = await errorOf(renderVideo(env, project(), { outPath: join(dir, 'out', 'v2.mp4'), profile: { format: 'mp4', codec: 'plugin:nope' }, noAudio: true }));
      expect(unknown.diagnostic.code).toBe('OV_RENDER_PROFILE');
    });
  }, 120_000);
});

describe('Codec-Argumente aus Plugins', () => {
  it('lehnt zusätzliche Eingaben, Muxer und URLs ab und verlangt -c:v', () => {
    expect(() => {
      checkCustomCodecArgs({ id: 'ok', formats: ['mp4'], args: ['-c:v', 'libx264', '-crf', '20'] });
    }).not.toThrow();
    for (const args of [['-c:v', 'libx264', '-i', 'x.mp4'], ['-c:v', 'libx264', '-f', 'rtp'], ['-c:v', 'libx264', '-vf', 'movie=http://evil/x'], ['-crf', '20']]) {
      expect(() => {
        checkCustomCodecArgs({ id: 'bad', formats: ['mp4'], args });
      }).toThrow(OpenVideoError);
    }
  });
});

describe('Hostdienste für Plugins (Review Q4)', () => {
  /** Projekt mit einem Symlink `link` auf einen Ordner außerhalb (mit secret.txt). */
  function linkedProject(): { dir: string; outside: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ov-plugin-host-'));
    const outside = mkdtempSync(join(tmpdir(), 'ov-plugin-host-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(dir, 'inside.txt'), 'inside');
    symlinkSync(outside, join(dir, 'link'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'secret-link.txt'));
    symlinkSync(join(outside, 'missing.txt'), join(dir, 'dangling.txt'));
    return { dir, outside };
  }

  it('liest und schreibt im Projekt, auch in neue Unterordner', async () => {
    const { dir } = linkedProject();
    const host = pluginHostServices(dir, ['fs:read', 'fs:write'], {});
    expect(new TextDecoder().decode(await host.readFile?.('inside.txt'))).toBe('inside');
    await host.writeFile?.('new/deep/file.txt', new TextEncoder().encode('ok'));
    expect(readFileSync(join(dir, 'new', 'deep', 'file.txt'), 'utf8')).toBe('ok');
  });

  it('lehnt ../ und Symlinks nach außen ab (lesen und schreiben)', async () => {
    const { dir, outside } = linkedProject();
    const host = pluginHostServices(dir, ['fs:read', 'fs:write'], {});
    const code = async (p: Promise<unknown> | undefined): Promise<string> => (await errorOf(p ?? Promise.reject(new Error('service missing')))).diagnostic.code;
    expect(await code(host.readFile?.('../x.txt'))).toBe('OV_PATH_OUTSIDE');
    expect(await code(host.readFile?.('link/secret.txt'))).toBe('OV_PATH_OUTSIDE');
    expect(await code(host.readFile?.('secret-link.txt'))).toBe('OV_PATH_OUTSIDE');
    expect(await code(host.writeFile?.('link/new.txt', new Uint8Array([1])))).toBe('OV_PATH_OUTSIDE');
    expect(await code(host.writeFile?.('link/sub/new.txt', new Uint8Array([1])))).toBe('OV_PATH_OUTSIDE');
    expect(await code(host.writeFile?.('dangling.txt', new Uint8Array([1])))).toBe('OV_PATH_OUTSIDE');
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    expect(existsSync(join(outside, 'sub'))).toBe(false);
    expect(existsSync(join(outside, 'missing.txt'))).toBe(false);
  });

  it('bietet nur Dienste für gewährte Rechte an', () => {
    const none = pluginHostServices('/tmp', [], { A: '1' });
    expect(Object.keys(none)).toEqual([]);
    const some = pluginHostServices('/tmp', ['fs:read', 'env'], { A: '1' });
    expect(Object.keys(some).sort()).toEqual(['env', 'readFile']);
    expect(some.env?.('A')).toBe('1');
  });

  it('spawn erbt ohne Recht env nur die minimale Umgebung, mit env die volle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-plugin-spawn-'));
    const env = { PATH: process.env['PATH'] ?? '/usr/bin', OPENVIDEO_WORKER_TOKEN: 'secret-token', AWS_SECRET_ACCESS_KEY: 'aws', MY_SETTING: 'x' };
    const script = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];
    const childEnv = async (granted: ('process:spawn' | 'env')[]): Promise<Record<string, unknown>> => {
      const r = await pluginHostServices(dir, granted, env).spawn?.(process.execPath, script);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(r?.stdout ?? new Uint8Array()));
      return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
    };
    const minimal = await childEnv(['process:spawn']);
    expect(minimal['PATH']).toBe(env.PATH);
    expect(minimal['OPENVIDEO_WORKER_TOKEN']).toBeUndefined();
    expect(minimal['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(minimal['MY_SETTING']).toBeUndefined();
    const full = await childEnv(['process:spawn', 'env']);
    expect(full['MY_SETTING']).toBe('x');
    expect(full['OPENVIDEO_WORKER_TOKEN']).toBe('secret-token');
  });
});
