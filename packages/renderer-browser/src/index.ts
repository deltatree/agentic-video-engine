/**
 * @packageDocumentation
 * Chromium-Render-Host (Playwright) mit eigener HTTP-Origin, virtueller Zeit und
 * Netzblockade (ADR 0013). Drei Backends: `browser` (html), `three` (scene3d), `pixi` (2D).
 *
 * @example
 * ```ts
 * import { createBrowserBackends } from '@agentic-video/renderer-browser';
 * const { browser, three, pixi } = await createBrowserBackends({ assets, fonts, width: 1920, height: 1080 });
 * const image = await browser.renderLayer(request);
 * ```
 */
export { createBrowserHost, CHROMIUM_ARGS, type BrowserHost, type BrowserHostOptions } from './host.js';
export { createBrowserBackends, PIXI_NODE_TYPES, type BrowserBackends } from './backends.js';
export { checkHtmlNode, HTML_CAPABILITIES } from './html-check.js';
export type { BrowserLayerKind, BrowserLayerPayload, OpenVideoPageApi } from './protocol.js';
export { createLazyBrowserBackends, expectedChromiumVersion, type LazyBrowserBackends } from './lazy.js';
