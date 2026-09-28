/**
 * Tests der 15 Templates (Story 12.3):
 * - `compileTsx` (trusted-host) liefert gültige IR, `project.json` ist aktuell;
 * - Frames 0/Mitte/Ende rendern ohne Fehler-Diagnosen, Kontaktbogen als Golden;
 * - Katalog mit Maßen, fps und Dauer;
 * - ein anderes Theme färbt die Templates um.
 *
 * Goldens neu erzeugen: `UPDATE_GOLDENS=1 npx vitest run packages/templates` und jedes Bild visuell prüfen.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { compileTsx } from '@agentic-video/compiler';
import { THEMES } from '@agentic-video/components';
import { compositionDurationFrames, findComposition, type Diagnostic, type RgbaImage } from '@agentic-video/core';
import { decodePng, encodePng } from '@agentic-video/png';
import { createNodeEnvironment, renderFrame, type BackendProvider, type NodeEnvironment } from '@agentic-video/render';
import { createBrowserBackends, type BrowserBackends } from '@agentic-video/renderer-browser';
import { TEMPLATES_DIR, createTemplateCatalog } from '@agentic-video/templates';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/** Die 15 Templates aus A29. */
const NAMES = [
  'product-launch',
  'saas-explainer',
  'logo-reveal',
  'social-video',
  'youtube-intro',
  'presentation',
  'data-visualization',
  'code-tutorial',
  'architecture-diagram',
  '3d-product-showcase',
  'lower-third',
  'subtitle-video',
  'podcast-clip',
  'cinematic-title',
  'comparison-video',
] as const;

/** Vorschau-Skalierung der Kontaktbögen. */
const SCALE = 0.25;

type Project = Record<string, unknown>;

function loadProject(name: string): Project {
  return JSON.parse(readFileSync(join(TEMPLATES_DIR, name, 'project.json'), 'utf8')) as Project;
}

function uses3d(project: Project): boolean {
  return JSON.stringify(project).includes('"type":"scene3d"');
}

/** Browser-Backends (three.js über SwiftShader) für Templates mit `scene3d`. */
function browserProvider(width: number, height: number): BackendProvider {
  let backends: BrowserBackends | undefined;
  return {
    ids: ['browser', 'three', 'pixi'],
    async register(registry, ctx) {
      const runtime = join(repoRoot, 'packages', 'renderer-browser', 'dist', 'runtime.js');
      if (!existsSync(runtime)) execFileSync(process.execPath, [join(repoRoot, 'packages', 'renderer-browser', 'scripts', 'build-runtime.mjs')], { stdio: 'inherit' });
      backends = await createBrowserBackends({ assets: ctx.assets, fonts: ctx.fonts, width, height });
      registry.registerBackend(backends.browser);
      registry.registerBackend(backends.three);
      registry.registerBackend(backends.pixi);
      return { chromium: backends.host.versions()['chromium'] ?? 'unknown' };
    },
    async dispose() {
      if (backends === undefined) return;
      await backends.browser.dispose();
      await backends.three.dispose();
      await backends.pixi.dispose();
    },
  };
}

async function withEnvironment<T>(name: string, project: Project, fn: (env: NodeEnvironment) => Promise<T>): Promise<T> {
  const comp = findComposition(project);
  const providers = uses3d(project) ? [browserProvider(Number(comp['width']) * SCALE, Number(comp['height']) * SCALE)] : [];
  // Die Templates haben keine Asset-Dateien; ein leerer Ordner hält Laufzeitdaten (.openvideo/) aus dem Paket.
  const projectDir = mkdtempSync(join(tmpdir(), `ov-template-${name}-`));
  const env = await createNodeEnvironment({ projectDir, project, cache: createCache(new MemoryStore()), offline: true, providers });
  try {
    return await fn(env);
  } finally {
    await env.dispose();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/** Frames 0, Mitte und Ende. */
function keyFrames(project: Project): number[] {
  const total = compositionDurationFrames(findComposition(project));
  return [0, Math.floor(total / 2), total - 1];
}

function errors(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.problem}${d.nodeId !== undefined ? ` (${d.nodeId})` : ''}`);
}

/** Anteil der Farbkanäle, die um mehr als `threshold` abweichen. */
function differingShare(a: RgbaImage, b: RgbaImage, threshold: number): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i++) if (Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > threshold) count++;
  return count / Math.max(1, a.data.length);
}

function expectGolden(name: string, image: RgbaImage, tolerance: number): void {
  const file = join(here, 'golden', `${name}.png`);
  const png = encodePng(image);
  if (process.env['UPDATE_GOLDENS'] === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return;
  }
  expect(existsSync(file), `golden ${name}.png is missing; run with UPDATE_GOLDENS=1 and review it`).toBe(true);
  const expected = decodePng(new Uint8Array(readFileSync(file)));
  const actual = decodePng(png);
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
  expect({ name, share: differingShare(actual, expected, 8) <= tolerance }).toEqual({ name, share: true });
}

describe('Katalog', () => {
  it('listet 15 Templates mit Maßen, fps und Dauer', () => {
    const list = createTemplateCatalog().list();
    expect(list.map((t) => t.name)).toEqual([...NAMES].sort());
    for (const t of list) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.width).toBeGreaterThan(0);
      expect(t.height).toBeGreaterThan(0);
      expect(t.fps).toBe(30);
      expect(t.durationSeconds).toBeGreaterThanOrEqual(5);
      expect(t.durationSeconds).toBeLessThanOrEqual(20);
      expect(t.files).toContain('src/video.tsx');
      expect(t.files).toContain('README.md');
      expect(t.files).not.toContain('project.json');
    }
    const social = list.find((t) => t.name === 'social-video');
    expect([social?.width, social?.height]).toEqual([1080, 1920]);
  });

  it('liefert IR und Quelldateien eines Templates', async () => {
    const t = await createTemplateCatalog().get('logo-reveal');
    expect(t.info.name).toBe('logo-reveal');
    expect(t.project).toEqual(loadProject('logo-reveal'));
    expect(Object.keys(t.files)).toEqual([...t.info.files]);
    expect(t.files['src/video.tsx']).toContain('composition(');
  });

  it('meldet ein unbekanntes Template mit Vorschlägen', async () => {
    await expect(createTemplateCatalog().get('nope')).rejects.toMatchObject({ diagnostic: { code: 'OV_TEMPLATE_UNKNOWN' } });
  });
});

describe.each(NAMES)('Template %s', (name) => {
  it('kompiliert fehlerfrei; project.json ist aktuell', async () => {
    const { project, diagnostics } = await compileTsx('src/video.tsx', { projectDir: join(TEMPLATES_DIR, name), mode: 'trusted-host' });
    expect(errors(diagnostics)).toEqual([]);
    expect(project, 'project.json is stale; run "npm run build:extra -w @agentic-video/templates"').toEqual(loadProject(name));
  });

  it('rendert Frames 0/Mitte/Ende ohne Fehler (Kontaktbogen-Golden)', async () => {
    const project = loadProject(name);
    const frames = keyFrames(project);
    await withEnvironment(name, project, async (env) => {
      const images: { image: RgbaImage; label: string }[] = [];
      for (const frame of frames) {
        const r = await renderFrame(env, project, { frame, scale: SCALE, useCache: false });
        expect(errors(r.diagnostics), `frame ${String(frame)}`).toEqual([]);
        images.push({ image: r.image, label: `frame ${String(frame)}` });
      }
      const sheet = env.overlays?.contactSheet(images, { columns: 3, cellWidth: 320, background: '#101014' });
      expect(sheet).toBeDefined();
      if (sheet !== undefined) expectGolden(name, sheet, uses3d(project) ? 0.02 : 0.002);
    });
  });
});

describe('Theme', () => {
  it.each(['product-launch', 'data-visualization'] as const)('%s färbt sich mit THEMES.light um', async (name) => {
    const dark = loadProject(name);
    const settings = dark['settings'] as Record<string, unknown>;
    const light: Project = { ...dark, settings: { ...settings, theme: THEMES.light } };
    const frame = keyFrames(dark)[1] ?? 0;
    const render = (p: Project): Promise<RgbaImage> => withEnvironment(name, p, async (env) => (await renderFrame(env, p, { frame, scale: SCALE, useCache: false })).image);
    const a = await render(dark);
    const b = await render(light);
    const mean = (img: RgbaImage): number => {
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) sum += (img.data[i] ?? 0) + (img.data[i + 1] ?? 0) + (img.data[i + 2] ?? 0);
      return sum / (img.data.length * 0.75);
    };
    expect(differingShare(a, b, 24)).toBeGreaterThan(0.5);
    // Das helle Theme hat einen hellen Hintergrund: das Bild wird deutlich heller.
    expect(mean(b) - mean(a)).toBeGreaterThan(100);
  });
});
