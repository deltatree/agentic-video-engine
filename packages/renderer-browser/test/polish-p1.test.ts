/**
 * Politur P1: tatsächliche Chromium-Version im Schlüssel bei eigenem Pfad, Grafik-Probe aus dem
 * Speicher ohne Browserstart, WebGPU nur nach gelungenem Mini-Render (Three.js-Pfad).
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { chromiumExecutable, chromiumVersionFor, createLazyBrowserBackends, expectedChromiumVersion, type GraphicsProbeStore } from '@agentic-video/renderer-browser';
import { buildRuntime, memoryAssets, testFonts } from './helpers.js';

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

function fakeChrome(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ov-fake-chrome-'));
  const bin = join(dir, 'chrome');
  writeFileSync(bin, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('Chromium-Version im Cache-Schlüssel (Politur P1)', () => {
  it('bleibt ohne eigenen Pfad die erwartete Version von playwright-core (Schlüssel unverändert)', () => {
    expect(chromiumVersionFor(undefined, {})).toBe(expectedChromiumVersion());
    expect(chromiumVersionFor(undefined, { OPENVIDEO_CHROMIUM: '' })).toBe(expectedChromiumVersion());
    // Der Pfad von playwright-core selbst zählt nicht als eigener Pfad.
    expect(chromiumVersionFor(chromium.executablePath(), {})).toBe(expectedChromiumVersion());
    expect(chromiumExecutable(undefined, {}).custom).toBe(false);
  });

  it('liest mit OPENVIDEO_CHROMIUM die tatsächliche Version aus --version, ohne Browserstart', () => {
    const bin = fakeChrome('Chromium 99.1.2.3 built for test');
    expect(chromiumVersionFor(undefined, { OPENVIDEO_CHROMIUM: bin })).toBe('99.1.2.3');
    const lazy = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 8, height: 8, env: { OPENVIDEO_CHROMIUM: bin } });
    expect(lazy.three.versions()['chromium']).toBe('99.1.2.3');
    expect(lazy.browser.versions()['chromium']).toBe('99.1.2.3');
    expect(lazy.started()).toBe(false);
  });

  it('nutzt einen Fingerabdruck der Datei, wenn das Programm keine Version nennt', () => {
    const bin = fakeChrome('no version here');
    const v = chromiumVersionFor(bin, {});
    expect(v).toMatch(/^custom-[0-9a-f]{16}$/u);
    expect(chromiumVersionFor(join(tmpdir(), 'ov-does-not-exist-chrome'), {})).toMatch(/^missing-[0-9a-f]{16}$/u);
  });
});

describe('Grafik-Probe aus dem Speicher (Politur P1)', () => {
  it('startet Chromium beim ersten Mal und liest das Ergebnis danach ohne Browserstart', async () => {
    buildRuntime();
    const store = memoryStore();
    const first = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 64, height: 64, gpu: false, graphicsCache: store });
    let info;
    try {
      info = await first.prepareGraphics();
      expect(first.started()).toBe(true);
      expect(store.entries.size).toBe(1);
    } finally {
      await first.dispose();
    }
    // WebGPU zählt nur nach gelungenem Mini-Render; in dieser Umgebung (Chromium ohne `swizzle` als Text) nicht.
    if (!info.webgpuAvailable) expect(info.webgpu).toMatch(/unavailable|no adapter|unusable/u);
    const second = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 64, height: 64, gpu: false, graphicsCache: store });
    try {
      expect(await second.prepareGraphics()).toEqual(info);
      expect(second.started()).toBe(false);
      expect(second.three.versions()).toEqual(first.three.versions());
    } finally {
      await second.dispose();
    }
  }, 60_000);

  it('trennt die Probe je Modus und Host-GPU; ein Treffer startet kein Chromium', async () => {
    const info = { webgl2: 'ANGLE (NVIDIA)', webgl2MaxTextureSize: 16384, webgpu: 'nvidia ampere', webgpuAvailable: true };
    const keys: string[] = [];
    const store: GraphicsProbeStore = {
      get: (key) => {
        keys.push(key);
        return Promise.resolve(new TextEncoder().encode(JSON.stringify(info)));
      },
      put: () => Promise.reject(new Error('must not write on a hit')),
    };
    const make = (gpu: boolean, hostGpu?: string) => createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 8, height: 8, gpu, ...(hostGpu !== undefined ? { hostGpu } : {}), graphicsCache: store });
    const all = [make(true, 'NVIDIA A10G (23028 MiB)'), make(true, 'NVIDIA L4 (23034 MiB)'), make(false)];
    try {
      for (const lazy of all) {
        expect(await lazy.prepareGraphics()).toEqual(info);
        expect(lazy.started()).toBe(false);
        expect(lazy.three.versions()['three-webgpu']).toBe('available');
        expect(lazy.three.versions()['three-max-texture']).toBe('16384');
      }
      expect(new Set(keys).size).toBe(3);
    } finally {
      await Promise.all(all.map((l) => l.dispose()));
    }
  });

  it('liest ein unbrauchbares Speicher-Ergebnis als Fehlgriff', async () => {
    const puts: string[] = [];
    const store: GraphicsProbeStore = {
      get: () => Promise.resolve(new TextEncoder().encode('{"webgl2":1}')),
      put: (key) => {
        puts.push(key);
        return Promise.resolve();
      },
    };
    buildRuntime();
    const lazy = createLazyBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: 16, height: 16, gpu: false, graphicsCache: store });
    try {
      const info = await lazy.prepareGraphics();
      expect(lazy.started()).toBe(true);
      expect(info.webgl2MaxTextureSize).toBeGreaterThan(0);
      expect(puts).toHaveLength(1);
    } finally {
      await lazy.dispose();
    }
  }, 60_000);
});
