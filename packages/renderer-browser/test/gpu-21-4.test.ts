/**
 * Story 21.4 (T5, ADR 0019) und 21.5: Grafik-Modus des Browser-Renderers, gemeinsame GPU-Proben,
 * WebGPU/WebGL2-Wahl und Texturgrenze in den Versionen (Cache-Schlüssel), strukturierte Seitenfehler.
 */
import { describe, expect, it } from 'vitest';
import { OpenVideoError } from '@agentic-video/core';
import {
  CHROMIUM_ARGS,
  browserGpuMode,
  chromiumArgsFor,
  chromiumGpuEnv,
  createLazyBrowserBackends,
  describeHostGpu,
  graphicsArgsFor,
  pageError,
  probeHostGpu,
  threeBackendFor,
} from '@agentic-video/renderer-browser';
import { buildRuntime, memoryAssets, testFonts } from './helpers.js';

describe('Grafik-Modus (Story 21.4)', () => {
  it('Standard ist SwiftShader; OPENVIDEO_BROWSER_GPU=1 oder gpu: true schaltet nativen ANGLE ein', () => {
    expect(browserGpuMode(undefined, {})).toBe('swiftshader');
    expect(browserGpuMode(undefined, { OPENVIDEO_BROWSER_GPU: '1' })).toBe('native');
    expect(browserGpuMode(undefined, { OPENVIDEO_BROWSER_GPU: '0' })).toBe('swiftshader');
    expect(browserGpuMode(true, {})).toBe('native');
    expect(browserGpuMode(false, { OPENVIDEO_BROWSER_GPU: '1' })).toBe('swiftshader');
  });

  it('ersetzt nur den ANGLE-Schalter; SwiftShader-Schalter nur im Standardmodus', () => {
    expect(chromiumArgsFor(CHROMIUM_ARGS, 'swiftshader')).toEqual([...CHROMIUM_ARGS]);
    const native = chromiumArgsFor(CHROMIUM_ARGS, 'native');
    expect(native).toContain('--use-angle=default');
    expect(native).not.toContain('--use-angle=swiftshader');
    expect(native).toContain('--disable-gpu-rasterization');
    expect(graphicsArgsFor('swiftshader')).toEqual(['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu']);
    expect(graphicsArgsFor('native')).toEqual(['--enable-unsafe-webgpu']);
  });

  it('gibt Chromium im GPU-Modus nur die Variablen der Treiber, nie Tokens', () => {
    const source = { PATH: '/usr/bin', NVIDIA_VISIBLE_DEVICES: 'all', VK_ICD_FILENAMES: '/x.json', OPENVIDEO_WORKER_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 's' };
    expect(chromiumGpuEnv(source, 'swiftshader')).toEqual({ PATH: '/usr/bin' });
    expect(chromiumGpuEnv(source, 'native')).toEqual({ PATH: '/usr/bin', NVIDIA_VISIBLE_DEVICES: 'all', VK_ICD_FILENAMES: '/x.json' });
  });
});

describe('GPU-Probe des Hosts (Story 21.5)', () => {
  it('liest Name und Speicher aus nvidia-smi', async () => {
    const gpu = await probeHostGpu({ run: () => Promise.resolve('NVIDIA A10G, 23028, 512\n'), driNodes: () => [] });
    expect(gpu).toEqual({ name: 'NVIDIA A10G', source: 'nvidia-smi', memoryTotalBytes: 23028 * 1024 * 1024, memoryUsedBytes: 512 * 1024 * 1024 });
    expect(gpu === undefined ? '' : describeHostGpu(gpu)).toBe('NVIDIA A10G (23028 MiB)');
  });

  it('fällt auf DRM-Render-Knoten zurück und meldet ohne GPU nichts', async () => {
    const missing = (): Promise<string> => Promise.reject(new Error('spawn nvidia-smi ENOENT'));
    expect(await probeHostGpu({ run: missing, driNodes: () => ['card0', 'renderD128'] })).toEqual({ name: 'DRM render node renderD128', source: 'dri' });
    expect(await probeHostGpu({ run: missing, driNodes: () => ['card0'] })).toBeUndefined();
  });
});

describe('WebGPU/WebGL2-Wahl (Story 21.5)', () => {
  it('folgt derselben Regel wie der ThreeLayerRenderer', () => {
    const glsl = { type: 'scene3d', children: [{ type: 'mesh3d', material: { type: 'shader', fragmentShader: 'void main(){}' } }] };
    expect(threeBackendFor({ type: 'scene3d', children: [] }, true)).toBe('webgpu');
    expect(threeBackendFor({ type: 'scene3d', children: [] }, false)).toBe('webgl2');
    expect(threeBackendFor(glsl, true)).toBe('webgl2');
    expect(threeBackendFor({ type: 'scene3d', backend: 'webgl2', children: [] }, true)).toBe('webgl2');
    expect(threeBackendFor({ type: 'scene3d', backend: 'webgpu', children: [] }, false)).toBe('webgpu');
  });

  it('steht nach der Grafik-Probe in den Versionen des three-Backends; der GPU-Modus nur im GPU-Modus', async () => {
    buildRuntime();
    const standard = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 64, height: 64, gpu: false });
    const native = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 64, height: 64, gpu: true });
    try {
      expect(standard.three.versions()['browser-gpu']).toBeUndefined();
      expect(native.three.versions()['browser-gpu']).toBe('native');
      expect(standard.three.versions()['three-webgpu']).toBeUndefined();
      expect(standard.runtimeVersions()).toBeUndefined();
      const info = await standard.prepareGraphics();
      const v = standard.three.versions();
      expect(v['three-webgpu']).toBe(info.webgpuAvailable ? 'available' : 'unavailable');
      expect(Number(v['three-max-texture'])).toBe(info.webgl2MaxTextureSize);
      expect(info.webgl2MaxTextureSize).toBeGreaterThan(0);
      // Andere Backends tragen die Probe nicht (ihre Schlüssel hängen nicht davon ab).
      expect(standard.browser.versions()['three-webgpu']).toBeUndefined();
      // Tatsächliche Chromium-Version aus browser.version(), nicht die erwartete aus playwright-core.
      expect(standard.runtimeVersions()?.['chromium']).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
      expect(standard.runtimeVersions()?.['browser-gpu']).toBe('swiftshader');
    } finally {
      await standard.dispose();
      await native.dispose();
    }
  }, 60_000);
});

describe('Strukturierte Seitenfehler (Story 21.7)', () => {
  it('macht aus „Laufzeit fehlt“ in der Seite OV_BROWSER_RUNTIME mit Vorschlägen', () => {
    const e = pageError('html', new Error('page.evaluate: Error: OV_BROWSER_RUNTIME: The page runtime (window.__ovRuntime) is not loaded.'));
    expect(e).toBeInstanceOf(OpenVideoError);
    expect(e.diagnostic.code).toBe('OV_BROWSER_RUNTIME');
    expect(e.diagnostic.problem).toBe('The page runtime (window.__ovRuntime) is not loaded.');
    expect(e.diagnostic.suggestions.length).toBeGreaterThan(0);
  });
});
