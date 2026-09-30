/**
 * Review Q5: Die CSP der Studio-Panels erlaubt kein Nachladen (`'strict-dynamic'` entfernt, nur
 * die absolute Modul-URL), und `panel.module` muss eine `.js`/`.mjs`-Datei im Plugin-Ordner sein.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry, isRecord } from '@agentic-video/core';
import { IncomingMessage, request } from 'node:http';
import { Socket } from 'node:net';
import { OPERATIONS, invokeOperation, pluginPanelUrl, requestOrigin, servePluginPanel, startAgentServer, type AgentServices } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

let services: AgentServices;
let projectId: string;

/** Panels mit verschiedenen `module`-Angaben; das Plugin liegt in `<tmp>/plugin/index.mjs`. */
const PANELS: Readonly<Record<string, string>> = {
  ok: './panel.mjs',
  okjs: './sub/panel.js',
  text: './panel.txt',
  json: './data.json',
  html: './page.html',
  outside: '../outside.mjs',
  linked: './linked.mjs',
  missing: './missing.mjs',
};

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'ov-panel-csp-'));
  const pluginDir = join(root, 'plugin');
  mkdirSync(join(pluginDir, 'sub'), { recursive: true });
  writeFileSync(join(pluginDir, 'index.mjs'), 'export default {};\n');
  writeFileSync(join(pluginDir, 'panel.mjs'), 'export default function mount() {}\n');
  writeFileSync(join(pluginDir, 'sub', 'panel.js'), 'export default function mount() {}\n');
  writeFileSync(join(pluginDir, 'panel.txt'), 'secret text');
  writeFileSync(join(pluginDir, 'data.json'), '{"secret":true}');
  writeFileSync(join(pluginDir, 'page.html'), '<p>x</p>');
  writeFileSync(join(root, 'outside.mjs'), 'export default function mount() {}\n');
  symlinkSync(join(root, 'outside.mjs'), join(pluginDir, 'linked.mjs'));
  const registry = new Registry();
  await registry.use(
    {
      name: 'panels',
      version: '1.0.0',
      permissions: [],
      setup(ctx) {
        for (const [id, module] of Object.entries(PANELS)) ctx.registerStudioPanel({ id, title: id, module });
      },
    },
    {},
    { origin: join(pluginDir, 'index.mjs') },
  );
  services = testServices(mkdtempSync(join(tmpdir(), 'ov-panel-csp-data-')), { registry });
  const created = await invokeOperation(OPERATIONS, 'project.create', { name: 'Panels', project: smallProject() }, { services, via: 'test' });
  if (!created.ok || !isRecord(created.result) || typeof created.result['projectId'] !== 'string') throw new Error('project.create failed');
  projectId = created.result['projectId'];
});

describe('Panel-CSP (Review Q5)', () => {
  it('enthält kein strict-dynamic, sondern nur Nonce und die absolute Modul-URL', async () => {
    const url = pluginPanelUrl(services, projectId, 'ok');
    const r = await servePluginPanel(services, url, { origin: 'http://localhost:4000' });
    expect(r?.status).toBe(200);
    const csp = r?.headers['content-security-policy'] ?? '';
    expect(csp).not.toContain('strict-dynamic');
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) ?? '';
    expect(scriptSrc).toMatch(new RegExp(`^script-src 'nonce-[A-Za-z0-9+/=]+' http://localhost:4000${url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}module\\.js$`, 'u'));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
  });

  it('ohne Origin nur Skripte derselben Origin (self), nie strict-dynamic', async () => {
    const r = await servePluginPanel(services, pluginPanelUrl(services, projectId, 'ok'));
    const csp = r?.headers['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'nonce-[^']+' 'self';/u);
    expect(csp).not.toContain('strict-dynamic');
    // Ungültige Origin fällt ebenfalls auf 'self' zurück (keine Einschleusung in die CSP).
    const bad = await servePluginPanel(services, pluginPanelUrl(services, projectId, 'ok'), { origin: "javascript:x; script-src *" });
    expect(bad?.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+' 'self';/u);
  });

  it('liefert Module mit .js und .mjs im Plugin-Ordner', async () => {
    for (const id of ['ok', 'okjs']) {
      const r = await servePluginPanel(services, `${pluginPanelUrl(services, projectId, id)}module.js`);
      expect(r?.status, id).toBe(200);
      expect(r?.headers['content-type']).toMatch(/^text\/javascript/u);
    }
  });

  it.each(['text', 'json', 'html', 'outside', 'linked', 'missing'])('antwortet 404 für panel.module "%s"', async (id) => {
    for (const suffix of ['', 'module.js']) {
      const r = await servePluginPanel(services, `${pluginPanelUrl(services, projectId, id)}${suffix}`, { origin: 'http://localhost:4000' });
      expect(r?.status, `${id}/${suffix}`).toBe(404);
    }
  });

  it('der Server übergibt die Origin aus dem geprüften Host-Kopf: CSP enthält die absolute Modul-URL', async () => {
    const server = await startAgentServer({ services, port: 0, allowedHosts: ['studio.example.com'] });
    try {
      const path = pluginPanelUrl(services, projectId, 'ok');
      const port = new URL(server.url).port;
      const csp = (headers: Record<string, string>): Promise<string> =>
        new Promise((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
            res.resume();
            const value = res.headers['content-security-policy'];
            resolve(typeof value === 'string' ? value : '');
          });
          req.on('error', reject);
          req.end();
        });
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      expect(await csp({ host: `localhost:${port}` })).toMatch(new RegExp(`script-src 'nonce-[^']+' http://localhost:${port}${escaped}module\\.js;`, 'u'));
      // Erlaubter fremder Host-Name (z. B. hinter einem Proxy) erscheint so, wie der Browser ihn sieht.
      expect(await csp({ host: 'studio.example.com' })).toContain(`http://studio.example.com${path}module.js`);
      // Proxy auf demselben Rechner (Loopback-Gegenstelle) beendet TLS: https.
      expect(await csp({ host: 'studio.example.com', 'x-forwarded-proto': 'https' })).toContain(`https://studio.example.com${path}module.js`);
    } finally {
      await server.close();
    }
  });

  it('requestOrigin vertraut X-Forwarded-Proto nur mit trustProxy oder von Loopback', () => {
    const message = (remoteAddress: string, headers: Record<string, string>): IncomingMessage => {
      const socket = new Socket();
      Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
      const m = new IncomingMessage(socket);
      m.headers = headers;
      return m;
    };
    const remote = message('203.0.113.9', { host: 'studio.example.com', 'x-forwarded-proto': 'https' });
    expect(requestOrigin(remote, false)).toBe('http://studio.example.com');
    expect(requestOrigin(remote, true)).toBe('https://studio.example.com');
    expect(requestOrigin(message('::ffff:127.0.0.1', { host: 'Localhost:4000', 'x-forwarded-proto': 'https, http' }), false)).toBe('https://localhost:4000');
    expect(requestOrigin(message('127.0.0.1', { host: 'localhost:4000', 'x-forwarded-proto': 'http' }), false)).toBe('http://localhost:4000');
    expect(requestOrigin(message('127.0.0.1', {}), false)).toBeUndefined();
  });
});
