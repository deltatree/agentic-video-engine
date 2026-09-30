/**
 * Story 21.1: Ein Studio-Panel aus einem Plugin lädt in einem `sandbox="allow-scripts"`-iframe
 * (undurchsichtige Origin, Modul-Import mit `Origin: null`), bekommt das Projekt per postMessage und
 * meldet sich zurück. Prüft Server-Route, CSP und Seitenskript zusammen in Chromium.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { Registry, isPlugin, isRecord } from '@agentic-video/core';
import { OPERATIONS, invokeOperation, startAgentServer } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'plugin-hello', 'index.mjs');

/** Seite wie das Studio: iframe mit Sandbox, sammelt Nachrichten und schickt das Projekt nach „ready“. */
function hostPage(panelUrl: string): string {
  return `<!doctype html><iframe id="f" sandbox="allow-scripts" src="${panelUrl}"></iframe><script>
window.msgs = [];
addEventListener('message', (e) => {
  window.msgs.push(e.data);
  if (e.data.type === 'openvideo.panel.ready') document.getElementById('f').contentWindow.postMessage({ type: 'openvideo.panel.project', project: { compositions: [{ id: 'main', width: 64, height: 36, fps: 10, nodes: [] }] } }, '*');
});
</script>`;
}

it('lädt das Panel im sandboxed iframe, liefert das Projekt und empfängt Meldungen', async () => {
  const registry = new Registry();
  const mod: unknown = await import(pathToFileURL(ENTRY).href);
  const plugin = isRecord(mod) ? mod['default'] : undefined;
  if (!isPlugin(plugin)) throw new Error('example plugin has no default export');
  await registry.use(plugin, { readFile: () => Promise.resolve(new Uint8Array()), writeFile: () => Promise.resolve() }, { origin: ENTRY });
  const services = testServices(mkdtempSync(join(tmpdir(), 'ov-panel-browser-')), { registry });
  const created = await invokeOperation(OPERATIONS, 'project.create', { name: 'Panel', project: smallProject() }, { services, via: 'test' });
  if (!created.ok || !isRecord(created.result)) throw new Error('project.create failed');
  const listed = await invokeOperation(OPERATIONS, 'plugins.list', { projectId: created.result['projectId'] }, { services, via: 'test' });
  const panels: unknown = listed.ok && isRecord(listed.result) ? listed.result['studioPanels'] : undefined;
  const first: unknown = Array.isArray(panels) ? panels[0] : undefined;
  if (!isRecord(first) || typeof first['url'] !== 'string') throw new Error('no panel');
  const panelUrl = first['url'];
  const server = await startAgentServer({
    services,
    port: 0,
    fallback: (req, res) => {
      if (req.url !== '/host.html') return Promise.resolve(false);
      // Wie das Studio (STUDIO_HEADERS): Frames nur von der eigenen Origin.
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'" });
      res.end(hostPage(panelUrl));
      return Promise.resolve(true);
    },
  });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/host.html`);
    const types = (): Promise<string[]> => page.evaluate(() => (Reflect.get(window, 'msgs') as { type: string }[]).map((m) => m.type));
    await expect.poll(types, { timeout: 15_000 }).toContain('openvideo.panel.ready');
    const frame = page.frames().find((f) => f.url().includes('/plugin-panels/'));
    if (frame === undefined) throw new Error('panel frame missing');
    await expect.poll(() => frame.evaluate(() => document.body.innerText), { timeout: 5_000 }).toContain('main: 64×36 @ 10 fps, 0 nodes');
    await frame.evaluate(() => document.querySelector('button')?.click());
    await expect.poll(types, { timeout: 5_000 }).toContain('openvideo.panel.notify');
    // Die Panel-Seite hat eine eigene, undurchsichtige Origin und kein Netz (connect-src 'none').
    expect(await frame.evaluate(() => fetch('/v1/operations').then(() => 'allowed', () => 'blocked'))).toBe('blocked');
  } finally {
    await browser.close();
    await server.close();
  }
}, 60_000);
