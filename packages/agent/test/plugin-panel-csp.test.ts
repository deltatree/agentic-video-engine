/**
 * Review Q5: Die CSP der Studio-Panels erlaubt kein Nachladen (`'strict-dynamic'` entfernt, nur
 * die absolute Modul-URL), und `panel.module` muss eine `.js`/`.mjs`-Datei im Plugin-Ordner sein.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Registry, isRecord } from '@agentic-video/core';
import { OPERATIONS, invokeOperation, pluginPanelUrl, servePluginPanel, type AgentServices } from '@agentic-video/agent';
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
});
