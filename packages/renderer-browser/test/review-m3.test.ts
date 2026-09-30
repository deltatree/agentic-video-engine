/**
 * Review-Befunde M3 und m2 im Browser-Renderer: Die Render-Seite entscheidet `backend: 'auto'` und
 * die WebGL2-Texturgrenze nach der Probe aus dem Cache-Schlüssel (nicht live); nur stabile
 * Probe-Ergebnisse werden gespeichert (mit Versionspräfix); freigegebene HTML-Skripte stehen im
 * Schlüssel.
 */
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { OpenVideoError, type EvaluatedScene } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { probeWebGPU } from '@agentic-video/renderer-three';
import { CHROMIUM_ARGS, createLazyBrowserBackends, type GraphicsProbeStore } from '@agentic-video/renderer-browser';
import type { PageGraphics } from '../src/gpu.js';
import { buildRuntime, memoryAssets, node, testFonts } from './helpers.js';

function memoryStore(): GraphicsProbeStore & { readonly entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, bytes) => {
      entries.set(key, bytes);
      return Promise.resolve();
    },
  };
}

const TRANSIENT: PageGraphics = { webgl2: 'ANGLE (SwiftShader)', webgl2MaxTextureSize: 8192, webgpu: 'google swiftshader (unusable: OperationError: device lost)', webgpuAvailable: false, stable: false };
const STABLE: PageGraphics = { webgl2: 'ANGLE (SwiftShader)', webgl2MaxTextureSize: 8192, webgpu: 'google swiftshader (unusable: TypeError: swizzle)', webgpuAvailable: false, stable: true };

describe('Grafik-Probe: nur stabile Ergebnisse speichern (Review M3)', () => {
  it('speichert ein vorübergehendes Ergebnis nicht und prüft beim nächsten Start neu', async () => {
    const store = memoryStore();
    let probes = 0;
    const make = (info: PageGraphics) =>
      createLazyBrowserBackends({
        assets: memoryAssets({}),
        fonts: testFonts(),
        width: 8,
        height: 8,
        gpu: false,
        graphicsCache: store,
        readGraphics: () => {
          probes++;
          return Promise.resolve(info);
        },
      });
    const first = make(TRANSIENT);
    expect(await first.prepareGraphics()).toEqual(TRANSIENT);
    // In dieser Umgebung gilt das Ergebnis (Schlüssel und Seite stimmen überein), gespeichert wird es nicht.
    expect(first.three.versions()['three-webgpu']).toBe('unavailable');
    expect(store.entries.size).toBe(0);
    const second = make(STABLE);
    expect(await second.prepareGraphics()).toEqual(STABLE);
    expect(probes).toBe(2);
    expect(store.entries.size).toBe(1);
    // Mit Versionspräfix gespeichert; ein dritter Start liest ohne Probe.
    const stored: unknown = JSON.parse(new TextDecoder().decode([...store.entries.values()][0]));
    expect(stored).toEqual({ v: 3, webgl2: STABLE.webgl2, webgl2MaxTextureSize: 8192, webgpu: STABLE.webgpu, webgpuAvailable: false });
    const third = make(TRANSIENT);
    expect((await third.prepareGraphics()).webgpu).toBe(STABLE.webgpu);
    expect(probes).toBe(2);
    await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  });

  it('liest Einträge ohne Versionspräfix (alte, evtl. vorübergehende Fehl-Proben) als Fehlgriff', async () => {
    let probes = 0;
    const old = { webgl2: 'ANGLE', webgl2MaxTextureSize: 8192, webgpu: 'no adapter', webgpuAvailable: false };
    const store: GraphicsProbeStore = { get: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(old))), put: () => Promise.resolve() };
    const lazy = createLazyBrowserBackends({
      assets: memoryAssets({}),
      fonts: testFonts(),
      width: 8,
      height: 8,
      gpu: false,
      graphicsCache: store,
      readGraphics: () => {
        probes++;
        return Promise.resolve(STABLE);
      },
    });
    expect(await lazy.prepareGraphics()).toEqual(STABLE);
    expect(probes).toBe(1);
    await lazy.dispose();
  });
});

describe('probeWebGPU unterscheidet stabile und vorübergehende Fehler (Review M3)', () => {
  it('kein Adapter und OperationError sind vorübergehend; fehlende und unvollständige API sind stabil', async () => {
    const browser = await chromium.launch({ args: [...CHROMIUM_ARGS] });
    try {
      const page = await browser.newPage();
      const run = async (mode: 'none' | 'null-adapter' | 'operation-error' | 'type-error') => {
        await page.evaluate((m) => {
          const device = {
            pushErrorScope: () => undefined,
            popErrorScope: () => Promise.resolve(null),
            destroy: () => undefined,
            createTexture: () => ({
              createView: () => {
                throw new TypeError("Failed to execute 'createView': swizzle");
              },
            }),
          };
          const adapter = {
            info: { vendor: 'test', architecture: 'gpu' },
            requestDevice: () => (m === 'operation-error' ? Promise.reject(new DOMException('The device was lost.', 'OperationError')) : Promise.resolve(device)),
          };
          const gpu = m === 'none' ? undefined : { requestAdapter: () => Promise.resolve(m === 'null-adapter' ? null : adapter) };
          Object.defineProperty(navigator, 'gpu', { value: gpu, configurable: true });
        }, mode);
        return page.evaluate(probeWebGPU);
      };
      expect(await run('none')).toEqual({ available: false, adapter: 'unavailable', stable: true });
      expect(await run('null-adapter')).toEqual({ available: false, adapter: 'no adapter', stable: false });
      expect(await run('operation-error')).toMatchObject({ available: false, stable: false });
      expect(await run('type-error')).toMatchObject({ available: false, stable: true, adapter: expect.stringContaining('TypeError') });
    } finally {
      await browser.close();
    }
  }, 60_000);
});

describe('Render-Seite nutzt die Probe aus dem Schlüssel (Review M3)', () => {
  it('die WebGL2-Texturgrenze kommt vom Host, nicht aus einer Live-Messung der Seite', async () => {
    buildRuntime();
    const size = 64;
    const checker = encodePng({ width: size, height: size, data: new Uint8Array(size * size * 4).fill(255) });
    const assets = memoryAssets({ checker: { path: 'checker.png', bytes: checker } });
    // Probe im Schlüssel: 32 px. Live kann SwiftShader 8192 px – ohne Weitergabe gelänge der Render.
    const lazy = createLazyBrowserBackends({ assets, fonts: testFonts(), width: 64, height: 64, gpu: false, readGraphics: () => Promise.resolve({ ...STABLE, webgl2MaxTextureSize: 32 }) });
    try {
      await lazy.prepareGraphics();
      expect(lazy.three.versions()['three-max-texture']).toBe('32');
      const scene = node('s3d', 'scene3d', { width: 64, height: 64, backend: 'auto', camera: 'cam' }, 0, 10, {
        children: [
          node('cam', 'camera3d', { position: [0, 0, 4], target: [0, 0, 0], fov: 50 }),
          node('amb', 'light3d', { kind: 'ambient', intensity: 1 }),
          node('box', 'mesh3d', { geometry: { type: 'box' }, material: { color: '#FFFFFF', map: 'checker' } }),
        ],
      });
      const sceneInfo: EvaluatedScene = { compositionId: 'main', frame: 0, time: 0, fps: 10, width: 64, height: 64, seed: 1, durationFrames: 10, background: 'transparent', colorSpace: 'srgb', safeArea: { action: 0.05, title: 0.1 }, nodes: [scene], diagnostics: [] };
      const error = await lazy.three.renderLayer({ layerId: 'l', scene: sceneInfo, nodes: [scene], width: 64, height: 64, scale: 1, assets, fonts: testFonts() }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OpenVideoError);
      expect(error instanceof OpenVideoError ? error.diagnostic.code : '').toBe('OV_THREE_TEXTURE_TOO_LARGE');
    } finally {
      await lazy.dispose();
    }
  }, 60_000);
});

describe('HTML-Skripte im Schlüssel (Review m2)', () => {
  it('nur mit allowHtmlScripts steht html-scripts in den Versionen des browser-Backends', () => {
    const off = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 8, height: 8 });
    const on = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 8, height: 8, allowHtmlScripts: true });
    expect(off.browser.versions()['html-scripts']).toBeUndefined();
    expect(on.browser.versions()['html-scripts']).toBe('allowed');
    // Nur HTML-Layer führen Skripte aus; three und pixi behalten ihre Schlüssel.
    expect(on.three.versions()).toEqual(off.three.versions());
  });
});
