/**
 * UI-Tests des Studios (Playwright): echter Agent-Server mit lokaler Render-Umgebung,
 * das gebaute Studio (`apps/studio/dist`) über `fallback`, Chromium mit SwiftShader.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAgentServer, type AgentServer } from '@agentic-video/agent';
import { createLocalServices, type LocalServices } from '@agentic-video/cli';
import { decodePng } from '@agentic-video/png';
import { expectGolden } from '@agentic-video/testing';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const APP = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(APP, 'dist');
const ARTIFACTS = join(APP, 'test', 'artifacts');
const GOLDEN = join(APP, 'test', 'golden', 'studio.png');
const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--font-render-hinting=none', '--force-color-profile=srgb'];
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Liefert die gebauten Studio-Dateien aus (Option `fallback` des Agent-Servers). */
async function serveStudio(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  const file = resolve(DIST, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(DIST + sep)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const PROJECT = {
  schemaVersion: '1.0.0',
  metadata: { title: 'Studio test' },
  compositions: [
    {
      id: 'main',
      width: 640,
      height: 360,
      fps: 10,
      duration: 20,
      background: '#101418',
      nodes: [
        { id: 'box', type: 'rect', x: 40, y: 40, width: 100, height: 80, fill: '#E5484D' },
        { id: 'disc', type: 'ellipse', x: 300, y: 60, width: 80, height: 80, fill: '#3E63DD', timing: { from: 0, duration: 10 } },
        { id: 'title', type: 'text', text: 'Studio', x: 200, y: 200, fontSize: 40, fill: '#FFFFFF' },
        { id: 'caption', type: 'text', text: 'This caption is far too long for its box', x: 40, y: 280, width: 90, maxLines: 1, fontSize: 24, fill: '#FFFFFF' },
      ],
    },
  ],
};

let workspace: string;
let services: LocalServices;
let server: AgentServer;
let browser: Browser;
let page: Page;
let projectId: string;
let projectCount = 0;
const pageErrors: string[] = [];

async function api(operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${server.url}/v1/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  return (await r.json()) as Record<string, unknown>;
}

type Json = Record<string, unknown>;

async function node(id: string): Promise<Json | undefined> {
  const comp = await api('composition.get', { projectId });
  const find = (list: Json[]): Json | undefined => {
    for (const n of list) {
      if (n['id'] === id) return n;
      const hit = Array.isArray(n['children']) ? find(n['children'] as Json[]) : undefined;
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return find(comp['nodes'] as Json[]);
}

/** Composition-Pixel → Bildschirmpunkt auf der Bühne. */
async function stagePoint(x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByRole('application', { name: 'Stage' }).boundingBox();
  if (box === null) throw new Error('stage not visible');
  return { x: box.x + (x / 640) * box.width, y: box.y + (y / 360) * box.height };
}

async function openStudio(): Promise<void> {
  await page.goto(`${server.url}/?project=${projectId}`);
  await expect.poll(() => page.getByRole('img', { name: /^Frame / }).count(), { timeout: 30_000 }).toBe(1);
  // Szenenbaum (Bounds) ist geladen, sobald die Composition-Nodes im Baum stehen.
  await page.getByRole('treeitem', { name: /caption/ }).waitFor();
}

async function selectInTree(id: string, modifier?: 'Control'): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(`^${id} `) }).click(modifier !== undefined ? { modifiers: [modifier] } : {});
}

beforeAll(async () => {
  await build({ root: APP, logLevel: 'warn', configFile: join(APP, 'vite.config.ts') });
  workspace = mkdtempSync(join(tmpdir(), 'ov-studio-'));
  services = await createLocalServices({ workspaceDir: workspace, isolation: 'trusted' });
  server = await startAgentServer({ services, port: 0, fallback: serveStudio });
  browser = await chromium.launch({ args: CHROMIUM_ARGS });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
}, 180_000);

afterAll(async () => {
  await browser.close();
  await server.close();
  await services.dispose();
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  const created = await api('project.create', { name: `studio ${String(++projectCount)}`, project: PROJECT });
  projectId = String(created['projectId']);
  await openStudio();
});

describe('OpenVideo Studio', () => {
  it('shows every panel of the layout', async () => {
    // Großzügige Poll-Zeit (Story 22.4): der erste Test nach dem Vite-Build läuft unter Last.
    await expect.poll(() => page.getByRole('toolbar', { name: 'Main toolbar' }).isVisible(), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.getByRole('region', { name: 'Preview' }).isVisible(), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.getByRole('tree', { name: 'Scene tree' }).isVisible(), { timeout: 15_000 }).toBe(true);
    const tabs = ['Scene Tree', 'Assets', 'Components', 'Inspector', 'Properties', 'Effects', 'Timeline', 'Audio', 'Keyframes', 'Curves', 'Code', 'Diagnostics', 'Render Queue'];
    for (const name of tabs) {
      const tab = page.getByRole('tab', { name, exact: true });
      expect(await tab.isVisible(), name).toBe(true);
      await tab.click();
      expect(await tab.getAttribute('aria-selected'), name).toBe('true');
      expect(await page.getByRole('tabpanel', { name, exact: true }).isVisible(), name).toBe(true);
    }
    expect(await page.getByRole('separator').count()).toBe(4);
    expect(pageErrors).toEqual([]);
  });

  it('moves a node by dragging on the stage, and Ctrl+Z restores it', async () => {
    const from = await stagePoint(90, 80);
    const to = await stagePoint(140, 110);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.keyboard.down('Alt');
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect.poll(async () => (await node('box'))?.['x'], { timeout: 15_000 }).toBeGreaterThan(85);
    const moved = await node('box');
    expect(Math.abs(Number(moved?.['x']) - 90)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(moved?.['y']) - 70)).toBeLessThanOrEqual(1);
    // Der Undo-Eintrag entsteht, sobald die Antwort von composition.patch da ist.
    await expect.poll(() => page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(true);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await node('box'))?.['x'], { timeout: 15_000 }).toBe(40);
    expect((await node('box'))?.['y']).toBe(40);
    await expect.poll(() => page.getByRole('button', { name: 'Redo', exact: true }).isEnabled()).toBe(true);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await node('box'))?.['x'], { timeout: 15_000 }).toBeGreaterThan(85);
  });

  it('aligns a multi-selection to the left', async () => {
    await selectInTree('box');
    await selectInTree('disc', 'Control');
    expect(await page.getByRole('treeitem', { selected: true }).count()).toBe(2);
    await page.getByRole('button', { name: 'Align left' }).click();
    await expect.poll(async () => (await node('disc'))?.['x'], { timeout: 15_000 }).toBe(40);
    expect((await node('box'))?.['x']).toBe(40);
  });

  it('sets a keyframe from the inspector', async () => {
    await selectInTree('title');
    await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
    // Fünf Frames vor (Fokus auf der Seite, nicht in einem Feld).
    await page.getByRole('treeitem', { name: /^title / }).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.getByLabel('Current time').textContent()).toContain('· 5');
    await page.getByRole('button', { name: 'Set keyframe: x' }).click();
    await expect.poll(async () => (await node('title'))?.['x'], { timeout: 15_000 }).toEqual({ $keyframes: [{ t: 0, v: 200 }, { t: 5, v: 200 }] });
    // Das Keyframe-Symbol erscheint im Inspector.
    await expect.poll(() => page.getByLabel('keyframe at this frame').count()).toBe(1);
  });

  it('moves a timeline bar and changes timing.from', async () => {
    const bar = page.getByRole('button', { name: /^Timing of box:/ });
    const box = await bar.boundingBox();
    if (box === null) throw new Error('bar not visible');
    const perFrame = box.width / 20;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + perFrame * 5, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await node('box'))?.['timing'], { timeout: 15_000 }).toEqual({ from: 5 });
  });

  it('saves the code editor through project.update', async () => {
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    const editor = page.locator('.monaco-editor');
    await editor.waitFor({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    const edited = structuredClone(PROJECT);
    const title = edited.compositions[0]?.nodes.find((n) => n.id === 'title') as { text: string };
    title.text = 'Edited in code';
    await page.keyboard.insertText(JSON.stringify(edited));
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await node('title'))?.['text'], { timeout: 15_000 }).toBe('Edited in code');
    await expect.poll(() => page.getByRole('status').textContent()).toContain('Saved project.json');
  });

  it('selects the node of a diagnostic and jumps to it in the code', async () => {
    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
    const item = page.getByRole('button', { name: /OV_TEXT_OVERFLOW.*caption/ });
    await item.waitFor({ timeout: 15_000 });
    await item.click();
    await expect.poll(() => page.getByRole('treeitem', { name: /^caption / }).getAttribute('aria-selected')).toBe('true');
    expect(await page.getByRole('tab', { name: 'Code', exact: true }).getAttribute('aria-selected')).toBe('true');
    await page.locator('.monaco-editor').waitFor({ timeout: 30_000 });
    await expect.poll(() => page.locator('.monaco-editor .selected-text').count(), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  it('runs a render queue job until it succeeds', async () => {
    await page.getByRole('tab', { name: 'Render Queue', exact: true }).click();
    await page.getByRole('button', { name: 'Start render' }).click();
    const job = page.getByRole('listitem', { name: /^Preview \(MP4, 25 %\): / });
    await expect.poll(() => job.getAttribute('aria-label'), { timeout: 90_000 }).toBe('Preview (MP4, 25 %): succeeded');
    const link = job.getByRole('link');
    expect(await link.getAttribute('href')).toMatch(new RegExp(`^/v1/files/${projectId}/out/preview-main\\.mp4$`));
    const file = await fetch(`${server.url}${String(await link.getAttribute('href'))}`);
    expect(file.status).toBe(200);
  });

  it('duplicates the selection with Ctrl+D', async () => {
    await selectInTree('box');
    await page.keyboard.press('Control+d');
    await expect.poll(async () => (await node('box-copy'))?.['x'], { timeout: 15_000 }).toBe(60);
    await expect.poll(() => page.getByRole('treeitem', { name: /^box-copy / }).getAttribute('aria-selected')).toBe('true');
  });

  it('lädt mit Token aus dem Fragment und entfernt es aus der Adresse', async () => {
    const secured = await startAgentServer({ services, port: 0, token: 'studio-test-token', fallback: serveStudio });
    const tokenPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    try {
      const unauthorized = await fetch(`${secured.url}/v1/project.inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(unauthorized.status).toBe(401);
      await tokenPage.goto(`${secured.url}/?project=${projectId}#token=studio-test-token`);
      await expect.poll(() => tokenPage.getByRole('img', { name: /^Frame / }).count(), { timeout: 30_000 }).toBe(1);
      expect(tokenPage.url()).not.toContain('studio-test-token');
      expect(await tokenPage.evaluate(() => sessionStorage.getItem('openvideo.token'))).toBe('studio-test-token');
    } finally {
      await tokenPage.close();
      await secured.close();
    }
  });

  it('matches the screenshot golden (tolerant) and stores it for review', async () => {
    await selectInTree('title');
    await selectInTree('disc', 'Control');
    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('button', { name: /OV_TEXT_OVERFLOW/ }).waitFor({ timeout: 15_000 });
    mkdirSync(ARTIFACTS, { recursive: true });
    // Veränderliche Stellen (Projekt-ID je Testreihenfolge, Live-Status, blinkender Cursor) maskieren;
    // feste Breiten halten die übrige Werkzeugleiste an ihrem Platz.
    const png = await page.screenshot({ path: join(ARTIFACTS, 'studio.png'), mask: [page.locator('.toolbar .project'), page.locator('.toolbar .live')], caret: 'hide', animations: 'disabled', style: '.toolbar .project, .toolbar .live { display: inline-block; width: 90px; overflow: hidden; }' });
    expect(pageErrors).toEqual([]);
    // Golden mit Toleranz (Story 22.5): Schriftkanten dürfen zwischen Chromium-Builds leicht abweichen,
    // ein verschobenes Panel oder ein fehlendes Element nicht. Abweichungen landen als .actual/.diff
    // neben dem Golden und in CI als Artefakt.
    const result = expectGolden(decodePng(new Uint8Array(png)), GOLDEN, { maxChannelDelta: 64, maxDiffRatio: 0.02 });
    expect(result.pass).toBe(true);
  });
});

/** Kurzer Sinuston als 16-Bit-PCM-WAV (für Audio-Tests). */
function toneWav(seconds: number, rate = 8000): string {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  return data.toString('base64');
}

describe('Epic 20: Studio', () => {
  it('20.1: übernimmt Fremdänderungen live und verwirft veraltetes Undo', async () => {
    await expect.poll(() => page.locator('.live').textContent(), { timeout: 15_000 }).toContain('Live');
    // Eigene Änderung erzeugt einen Undo-Schritt …
    await selectInTree('box');
    await page.getByRole('application', { name: 'Stage' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await node('box'))?.['x'], { timeout: 15_000 }).toBe(41);
    await expect.poll(() => page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(true);
    // … dann ändert ein Agent das Projekt über die API.
    await api('composition.patch', { projectId, patches: [{ op: 'addNode', parentId: null, node: { id: 'fromagent', type: 'rect', x: 500, y: 20, width: 40, height: 40, fill: '#00FF00' } }] });
    await page.getByRole('treeitem', { name: /^fromagent / }).waitFor({ timeout: 15_000 });
    await expect.poll(() => page.getByRole('status').textContent()).toContain('changed outside the Studio');
    expect(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(false);
  });

  it('20.1: warnt bei offenem Code-Entwurf statt ihn zu überschreiben', async () => {
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    const editor = page.locator('.monaco-editor');
    await editor.waitFor({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' ');
    await expect.poll(() => page.getByText('Unsaved changes').count()).toBe(1);
    await api('composition.patch', { projectId, patches: [{ op: 'setProperty', nodeId: 'title', property: 'text', value: 'Agent edit' }] });
    await expect.poll(() => page.getByText('project.json changed outside the Studio').count(), { timeout: 15_000 }).toBe(1);
    expect(await page.getByText('Unsaved changes').count()).toBe(1);
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect.poll(() => page.getByText('In sync with the server').count()).toBe(1);
  });

  it('20.3: zeigt einen Fehlerzustand mit Retry für unbekannte Projekte', async () => {
    await page.goto(`${server.url}/?project=does-not-exist`);
    await page.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 15_000 });
    expect(await page.getByRole('alert').first().textContent()).toContain('OV_PROJECT');
    expect(await page.getByRole('link', { name: 'Choose another project' }).count()).toBe(1);
  });

  it('20.3: Nudges sind ein Undo-Schritt, Code-Save ist rückgängig machbar', async () => {
    await selectInTree('box');
    await page.getByRole('application', { name: 'Stage' }).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await node('box'))?.['y'], { timeout: 15_000 }).toBe(43);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await node('box'))?.['y'], { timeout: 15_000 }).toBe(40);
    await expect.poll(() => page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(false);

    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    const editor = page.locator('.monaco-editor');
    await editor.waitFor({ timeout: 30_000 });
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    const edited = structuredClone(PROJECT);
    const title = edited.compositions[0]?.nodes.find((n) => n.id === 'title');
    if (title === undefined || !('text' in title)) throw new Error('no title');
    title.text = 'Saved from code';
    await page.keyboard.insertText(JSON.stringify(edited));
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await node('title'))?.['text'], { timeout: 15_000 }).toBe('Saved from code');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await node('title'))?.['text'], { timeout: 15_000 }).toBe('Studio');
  });

  it('20.4/20.5: Griffe ändern Größe und Drehung, beim Ziehen gibt es eine Live-Vorschau', async () => {
    await selectInTree('box');
    const previews: string[] = [];
    const onRequest = (r: { url: () => string; postData: () => string | null }): void => {
      if (r.url().endsWith('/v1/frame.render') && (r.postData() ?? '').includes('"patches"')) previews.push(r.postData() ?? '');
    };
    page.on('request', onRequest);
    try {
      const handle = page.locator('[data-handle="se"]');
      await handle.waitFor();
      const hb = await handle.boundingBox();
      if (hb === null) throw new Error('no handle');
      const to = await stagePoint(160, 140);
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await expect.poll(() => previews.length, { timeout: 15_000 }).toBeGreaterThan(0);
      await page.mouse.up();
      await expect.poll(async () => (await node('box'))?.['width'], { timeout: 15_000 }).toBeGreaterThan(110);
      const resized = await node('box');
      expect(Math.abs(Number(resized?.['width']) - 120)).toBeLessThanOrEqual(2);
      expect(Math.abs(Number(resized?.['height']) - 100)).toBeLessThanOrEqual(2);
      expect(resized?.['x']).toBe(40);
      // Vorschau-Patches werden nie gespeichert: gespeichert ist nur der Endstand.
      expect(previews.some((p) => p.includes('"width"'))).toBe(true);

      const rotate = page.locator('[data-handle="rotate"]');
      const rb = await rotate.boundingBox();
      if (rb === null) throw new Error('no rotate handle');
      const center = await stagePoint(100, 90);
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await page.mouse.down();
      await page.keyboard.down('Shift');
      await page.mouse.move(center.x + 200, center.y, { steps: 10 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect.poll(async () => (await node('box'))?.['rotation'], { timeout: 15_000 }).toBe(90);
    } finally {
      page.off('request', onRequest);
    }
  });

  it('20.5: Drehen speichert den Endstand, auch wenn pointermove und pointerup vor dem nächsten Render kommen', async () => {
    // Unter Last kamen Zeigerereignisse schneller als Renders; pointerup las den Zustand des letzten
    // Renders (Winkel beim Start) und speicherte nichts. Hier kommen alle Ereignisse in einem Task.
    await selectInTree('box');
    const rotate = page.locator('[data-handle="rotate"]');
    await rotate.waitFor();
    const rb = await rotate.boundingBox();
    if (rb === null) throw new Error('no rotate handle');
    const center = await stagePoint(90, 80);
    await page.evaluate(
      ([from, to]) => {
        const handle = document.querySelector('[data-handle="rotate"]');
        if (handle === null) throw new Error('no rotate handle');
        const fire = (type: string, p: { x: number; y: number }, shiftKey: boolean): void => {
          handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: p.x, clientY: p.y, shiftKey }));
        };
        fire('pointerdown', from, false);
        for (let i = 1; i <= 5; i++) fire('pointermove', { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 }, true);
        fire('pointerup', to, true);
      },
      [{ x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 }, { x: center.x + 200, y: center.y }] as const,
    );
    await expect.poll(async () => (await node('box'))?.['rotation'], { timeout: 15_000 }).toBe(90);
  });

  it('20.4: Rahmenauswahl wählt mehrere Nodes', async () => {
    const from = await stagePoint(20, 20);
    const to = await stagePoint(400, 150);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => page.getByRole('treeitem', { selected: true }).count()).toBe(2);
    expect(await page.getByRole('treeitem', { name: /^box / }).getAttribute('aria-selected')).toBe('true');
    expect(await page.getByRole('treeitem', { name: /^disc / }).getAttribute('aria-selected')).toBe('true');
  });

  it('20.6: Marker mit M anlegen, umbenennen und löschen', async () => {
    await page.getByRole('treeitem', { name: /^title / }).focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('m');
    const marker = page.getByRole('button', { name: /^Marker marker at / });
    await marker.waitFor({ timeout: 15_000 });
    await expect.poll(async () => JSON.stringify((await api('composition.get', { projectId }))['markers'])).toBe('[{"id":"marker","time":4}]');
    await marker.focus();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: 'Label of marker marker' });
    await input.fill('Intro');
    await input.press('Enter');
    await expect.poll(async () => JSON.stringify((await api('composition.get', { projectId }))['markers'])).toBe('[{"id":"marker","time":4,"label":"Intro"}]');
    const renamed = page.getByRole('button', { name: /^Marker Intro at / });
    await renamed.focus();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await api('composition.get', { projectId }))['markers']).toBeUndefined();
  });

  it('20.6: Ebenen-Befehle, Ctrl+Wheel zoomt nur die Timeline, Backspace nur auf Bühne/Baum', async () => {
    await selectInTree('box');
    await page.getByRole('button', { name: 'Bring to front' }).click();
    await expect
      .poll(async () => {
        const nodes = (await api('composition.get', { projectId }))['nodes'];
        return Array.isArray(nodes) ? nodes.map((n: unknown) => (typeof n === 'object' && n !== null && 'id' in n ? n.id : undefined)) : [];
      })
      .toEqual(['disc', 'title', 'caption', 'box']);

    const body = page.locator('.tl-body');
    const bb = await body.boundingBox();
    if (bb === null) throw new Error('no timeline');
    await page.evaluate(() => {
      window.addEventListener('wheel', (e) => {
        document.body.dataset['wheelPrevented'] = String(e.defaultPrevented);
      });
    });
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(() => page.evaluate(() => document.body.dataset['wheelPrevented'])).toBe('true');

    // Backspace in der Timeline (Fokus auf einem Balken) löscht nichts.
    await page.getByRole('button', { name: /^Timing of box:/ }).focus();
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    expect(await node('box')).toBeDefined();
    await selectInTree('box');
    await page.keyboard.press('Backspace');
    await expect.poll(async () => node('box'), { timeout: 15_000 }).toBeUndefined();
  });

  it('20.7: Audio-Asset erzeugt Spur und Clip mit Wellenform; Clips lassen sich verschieben', async () => {
    await api('asset.import', { projectId, base64: toneWav(1), fileName: 'tone.wav', id: 'tone' });
    await page.reload();
    await expect.poll(() => page.getByRole('img', { name: /^Frame / }).count(), { timeout: 30_000 }).toBe(1);
    await page.getByRole('tab', { name: 'Assets', exact: true }).click();
    await page.getByRole('button', { name: 'Add tone to the timeline at the playhead' }).click();
    await expect.poll(async () => JSON.stringify((await api('composition.get', { projectId }))['tracks']), { timeout: 15_000 }).toBe('[{"id":"audio","kind":"audio","clips":[{"id":"tone","source":"tone","start":0}]}]');
    const clip = page.getByRole('button', { name: /^Audio clip tone:/ });
    await clip.waitFor({ timeout: 15_000 });
    await clip.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => JSON.stringify((await api('composition.get', { projectId }))['tracks']), { timeout: 15_000 }).toContain('"start":10');
    // Die Wellenform ist gezeichnet (Canvas nicht leer).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = document.querySelector('.tl-clip canvas');
          if (!(c instanceof HTMLCanvasElement)) return 0;
          const g = c.getContext('2d');
          if (g === null) return 0;
          return g.getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 === 3 && v > 0).length;
        }),
      )
      .toBeGreaterThan(0);
    // Wiedergabe mit Ton (WebAudio) läuft ohne Fehler und bewegt den Playhead.
    await page.getByRole('application', { name: 'Stage' }).focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('l');
    await expect.poll(() => page.getByLabel('Current time').textContent(), { timeout: 15_000 }).not.toContain('· 0');
    await page.keyboard.press('k');
    expect(pageErrors).toEqual([]);
    // Mute-Schalter bleibt gespeichert.
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Unmute', exact: true }).getAttribute('aria-pressed')).toBe('true');
  });

  it('20.8: Mehrfachbearbeitung im Inspector und Tastaturauswahl auf der Bühne', async () => {
    await selectInTree('box');
    await selectInTree('disc', 'Control');
    await page.getByRole('tab', { name: 'Inspector', exact: true }).click();
    await page.getByRole('heading', { name: /^2 nodes/ }).waitFor();
    const opacity = page.getByRole('spinbutton', { name: 'opacity', exact: true });
    await opacity.fill('0.5');
    await opacity.press('Enter');
    await expect.poll(async () => [(await node('box'))?.['opacity'], (await node('disc'))?.['opacity']], { timeout: 15_000 }).toEqual([0.5, 0.5]);
    await page.keyboard.press('Escape');
    await page.getByRole('application', { name: 'Stage' }).focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => page.getByRole('treeitem', { selected: true }).count()).toBe(1);
  });

  it('20.8: Kopieren und Einfügen über die System-Zwischenablage', async () => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
    await selectInTree('box');
    await page.getByRole('application', { name: 'Stage' }).focus();
    await page.keyboard.press('Control+c');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 10_000 }).toContain('"openvideo":"nodes"');
    // Eine Node aus einem Editor oder Agenten einfügen.
    await page.evaluate(() => navigator.clipboard.writeText('{"id":"pasted","type":"rect","x":1,"y":1,"width":5,"height":5}'));
    await page.getByRole('application', { name: 'Stage' }).focus();
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await node('pasted'))?.['x'], { timeout: 15_000 }).toBe(21);
  });

  it('20.8: Render-Jobs erscheinen nach dem Neuladen wieder', async () => {
    const started = await api('preview.render', { projectId, scale: 0.25 });
    expect(typeof started['jobId']).toBe('string');
    await page.reload();
    await expect.poll(() => page.getByRole('img', { name: /^Frame / }).count(), { timeout: 30_000 }).toBe(1);
    await page.getByRole('tab', { name: 'Render Queue', exact: true }).click();
    await expect.poll(() => page.getByRole('listitem', { name: /^Preview: / }).count(), { timeout: 30_000 }).toBe(1);
  });

  it('20.8: Projekt aus Template im Picker anlegen, Panels einklappen und Größe merken', async () => {
    await page.goto(`${server.url}/`);
    await page.getByRole('heading', { name: 'New project' }).waitFor();
    await page.getByRole('textbox', { name: 'Name' }).fill('From picker');
    // Aus einem Template, wenn der Katalog welche hat.
    const select = page.getByRole('combobox', { name: 'Start from' });
    await expect.poll(async () => (await select.locator('option').count()) > 1, { timeout: 15_000 }).toBe(true);
    const template = await select.locator('option').nth(1).getAttribute('value');
    await select.selectOption(template ?? '');
    await page.getByRole('button', { name: 'Create and open' }).click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('?project=from-picker');
    await page.getByRole('toolbar', { name: 'Main toolbar' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Collapse Project panel' }).click();
    await page.getByRole('button', { name: 'Expand Project panel' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Expand Project panel' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Expand Project panel' }).click();
    await page.getByRole('tree', { name: 'Scene tree' }).or(page.getByText('No nodes yet')).first().waitFor();
    // Komponenten-Suche.
    await page.getByRole('tab', { name: 'Components', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search components' }).fill('sequence');
    await expect.poll(() => page.getByRole('button', { name: /^Sequence/ }).count()).toBe(1);
    await page.getByRole('button', { name: /^Sequence/ }).click();
    await page.getByRole('tab', { name: 'Scene Tree', exact: true }).click();
    await page.getByRole('treeitem', { name: /^sequence sequence/ }).waitFor({ timeout: 15_000 });
    await page.evaluate(() => {
      localStorage.clear();
    });
  });
});
