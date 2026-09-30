/**
 * Träge Browser-Backends: Prüfung und Versionen stehen sofort bereit, Chromium startet erst
 * beim ersten Layer, der den Browser braucht. So kostet ein reines 2D-Projekt keinen Browserstart.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpenVideoError, isRecord, type BackendCheck, type LayerRequest, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { checkPixiNode, PIXI_CAPABILITIES, PIXI_VERSION } from '@agentic-video/renderer-pixi';
import { checkThreeNode, THREE_CAPABILITIES, THREE_VERSION } from '@agentic-video/renderer-three';
import { createBrowserBackends, PIXI_NODE_TYPES, type BrowserBackends } from './backends.js';
import { checkHtmlNode, HTML_CAPABILITIES } from './html-check.js';
import type { BrowserHostOptions } from './host.js';

/** Chromium-Version, die zur installierten playwright-core-Version gehört (aus `browsers.json`). */
export function expectedChromiumVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('playwright-core/package.json');
  const raw: unknown = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8'));
  const browsers = isRecord(raw) && Array.isArray(raw['browsers']) ? raw['browsers'].filter(isRecord) : [];
  const chromium = browsers.find((b) => b['name'] === 'chromium');
  return typeof chromium?.['browserVersion'] === 'string' ? chromium['browserVersion'] : 'unknown';
}

function toCheck(diagnostics: ReturnType<typeof checkThreeNode>): BackendCheck {
  return { supported: diagnostics.every((d) => d.severity !== 'error'), diagnostics };
}

/** Träge Backends mit gemeinsamem Aufräumen. */
export interface LazyBrowserBackends {
  readonly browser: RenderBackend;
  readonly three: RenderBackend;
  readonly pixi: RenderBackend;
  /** Wurde Chromium gestartet? */
  started(): boolean;
  dispose(): Promise<void>;
}

/**
 * Erzeugt die drei Browser-Backends (`browser`, `three`, `pixi`), ohne Chromium sofort zu starten.
 *
 * @example
 * ```ts
 * const lazy = createLazyBrowserBackends({ assets, fonts, width: 1920, height: 1080 });
 * registry.registerBackend(lazy.browser);
 * ```
 */
export function createLazyBrowserBackends(options: BrowserHostOptions): LazyBrowserBackends {
  let real: Promise<BrowserBackends> | undefined;
  const chromium = expectedChromiumVersion();
  const ensure = (): Promise<BrowserBackends> => {
    real ??= createBrowserBackends(options);
    return real;
  };
  const make = (id: 'browser' | 'three' | 'pixi', nodeTypes: readonly string[], capabilities: readonly string[], fusable: boolean, check: (node: Readonly<Record<string, unknown>>) => BackendCheck, versions: Readonly<Record<string, string>>): RenderBackend => ({
    id,
    nodeTypes,
    capabilities,
    fusable,
    versions: () => ({ chromium, ...versions }),
    check,
    async renderLayer(request: LayerRequest): Promise<RgbaImage> {
      const backends = await ensure();
      return backends[id].renderLayer(request);
    },
    async dispose() {
      if (real === undefined) return;
      await (await real)[id].dispose();
    },
  });
  const browser = make('browser', ['html'], HTML_CAPABILITIES, true, (n) => checkHtmlNode(n, { allowScripts: options.allowHtmlScripts === true }), {});
  const three = make('three', ['scene3d'], THREE_CAPABILITIES, false, (n) => toCheck(checkThreeNode(n)), { three: THREE_VERSION });
  const pixi = make('pixi', PIXI_NODE_TYPES, PIXI_CAPABILITIES, true, (n) => toCheck(checkPixiNode(n)), { 'pixi.js': PIXI_VERSION });
  return {
    browser,
    three,
    pixi,
    started: () => real !== undefined,
    async dispose() {
      if (real === undefined) return;
      try {
        const r = await real;
        await Promise.all([r.browser.dispose(), r.three.dispose(), r.pixi.dispose()]);
      } catch (error) {
        if (!(error instanceof OpenVideoError)) throw error;
      }
    },
  };
}
