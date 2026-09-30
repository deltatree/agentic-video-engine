/**
 * Story 21.1 in der Agent API: `plugins.list`, Agent Tools als Operationen `plugin.<name>` und
 * Studio-Panels als signierte, sandboxed Seiten. Nutzt examples/plugin-hello.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry, isPlugin, isRecord } from '@agentic-video/core';
import { OPERATIONS, invokeOperation, startAgentServer, type AgentServer, type AgentServices } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'plugin-hello', 'index.mjs');
const TOKEN = 'plugin-test-token-0123456789abcdef';

let services: AgentServices;
let projectId: string;
let server: AgentServer;

beforeAll(async () => {
  const registry = new Registry();
  const mod: unknown = await import(pathToFileURL(ENTRY).href);
  const plugin = isRecord(mod) ? mod['default'] : undefined;
  if (!isPlugin(plugin)) throw new Error('example plugin has no default export');
  await registry.use(plugin, { readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve() }, { origin: ENTRY });
  services = testServices(mkdtempSync(join(tmpdir(), 'ov-agent-plugins-')), { registry });
  const created = await invokeOperation(OPERATIONS, 'project.create', { name: 'Plugins', project: smallProject() }, { services, via: 'test' });
  if (!created.ok || !isRecord(created.result) || typeof created.result['projectId'] !== 'string') throw new Error('project.create failed');
  projectId = created.result['projectId'];
  server = await startAgentServer({ services, port: 0, token: TOKEN });
});

afterAll(async () => {
  await server.close();
});

const call = (name: string, input: unknown) => invokeOperation(OPERATIONS, name, input, { services, via: 'test' });

describe('plugins.list', () => {
  it('beschreibt Plugins, Werkzeuge, Codecs, Exporter, Asset Loader und Panels', async () => {
    const r = await call('plugins.list', { projectId });
    expect(r.ok).toBe(true);
    if (!r.ok || !isRecord(r.result)) return;
    expect(r.result['plugins']).toEqual([{ name: 'hello', version: '1.0.0', permissions: ['fs:read', 'fs:write'] }]);
    expect(r.result['tools']).toMatchObject([{ operation: 'plugin.hello.greet', plugin: 'hello' }]);
    expect(r.result['codecs']).toEqual([{ codec: 'plugin:x264-fast', formats: ['mp4', 'mov'], license: 'GPL-2.0-or-later (libx264)' }]);
    expect(r.result['exporters']).toMatchObject([{ format: 'plugin:hello-frames', extension: 'ovhf' }]);
    expect(r.result['assetLoaders']).toEqual([{ id: 'hello-csv', type: 'data', extensions: ['csv'] }]);
    expect(r.result['studioPanels']).toMatchObject([{ id: 'hello-panel', title: 'Hello', plugin: 'hello' }]);
  });
});

describe('Agent Tools als Operationen plugin.<name>', () => {
  it('ruft das Werkzeug mit Eingabeprüfung auf', async () => {
    expect(await call('plugin.hello.greet', { projectId, name: 'Ada' })).toEqual({ ok: true, result: { greeting: 'Hello, Ada!' } });
    const bad = await call('plugin.hello.greet', { projectId, name: 42 });
    expect(bad.ok ? 'ok' : bad.error.code).toBe('OV_API_INPUT');
    const missing = await call('plugin.hello.greet', { name: 'Ada' });
    expect(missing.ok ? 'ok' : missing.error.code).toBe('OV_API_INPUT');
    const unknown = await call('plugin.hello.nope', { projectId });
    expect(unknown.ok ? 'ok' : unknown.error.code).toBe('OV_API_UNKNOWN_OPERATION');
    expect(unknown.ok ? [] : unknown.error.suggestions).toContain('Use one of: plugin.hello.greet.');
  });

  it('ist über HTTP erreichbar (mit Token)', async () => {
    const res = await fetch(`${server.url}/v1/plugin.hello.greet`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ projectId, name: 'Http' }) });
    expect(await res.json()).toEqual({ greeting: 'Hello, Http!' });
  });
});

describe('Studio-Panels', () => {
  async function panelUrl(): Promise<string> {
    const r = await call('plugins.list', { projectId });
    if (!r.ok || !isRecord(r.result) || !Array.isArray(r.result['studioPanels'])) throw new Error('plugins.list failed');
    const panel: unknown = r.result['studioPanels'][0];
    if (!isRecord(panel) || typeof panel['url'] !== 'string') throw new Error('no panel');
    return panel['url'];
  }

  it('liefert Seite und Modul unter der signierten URL ohne Token, mit Sandbox-CSP', async () => {
    const url = await panelUrl();
    const page = await fetch(`${server.url}${url}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src 'nonce-[^']+' 'strict-dynamic'/u);
    expect(await page.text()).toContain("import('./module.js')");
    const mod = await fetch(`${server.url}${url}module.js`);
    expect(mod.status).toBe(200);
    expect(mod.headers.get('content-type')).toMatch(/^text\/javascript/u);
    expect(await mod.text()).toContain('Hello from a plugin');
  });

  it('antwortet 404 bei falscher Signatur, fremdem Panel oder anderem Pfad', async () => {
    const url = await panelUrl();
    const forged = url.replace(/\/[0-9a-f]{32}\/$/u, `/${'0'.repeat(32)}/`);
    expect((await fetch(`${server.url}${forged}`)).status).toBe(404);
    expect((await fetch(`${server.url}${url.replace('hello-panel', 'other')}`)).status).toBe(404);
    expect((await fetch(`${server.url}${url}../../index.mjs`)).status).toBe(404);
    // Die übrige API bleibt hinter dem Token.
    expect((await fetch(`${server.url}/v1/operations`)).status).toBe(401);
  });
});
