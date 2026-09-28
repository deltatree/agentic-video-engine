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
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const APP = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(APP, 'dist');
const ARTIFACTS = join(APP, 'test', 'artifacts');
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
    await expect.poll(() => page.getByRole('toolbar', { name: 'Main toolbar' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('region', { name: 'Preview' }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole('tree', { name: 'Scene tree' }).isVisible()).toBe(true);
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

  it('stores a screenshot for visual review', async () => {
    await selectInTree('title');
    await selectInTree('disc', 'Control');
    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('button', { name: /OV_TEXT_OVERFLOW/ }).waitFor({ timeout: 15_000 });
    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(ARTIFACTS, 'studio.png') });
    expect(pageErrors).toEqual([]);
  });
});
