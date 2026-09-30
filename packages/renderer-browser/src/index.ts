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
export { createBrowserHost, chromiumExecutable, CHROMIUM_ARGS, CHROMIUM_GRAPHICS_ARGS, chromiumEnv, pageError, probeOsSandbox, type BrowserHost, type BrowserHostOptions } from './host.js';
export {
  CHROMIUM_NATIVE_GPU_ARGS,
  browserGpuMode,
  chromiumArgsFor,
  chromiumGpuEnv,
  describeHostGpu,
  graphicsArgsFor,
  pageWebGL2,
  readPageGraphics,
  probeBrowserGraphics,
  probeHostGpu,
  type BrowserGpuMode,
  type BrowserGraphicsProbe,
  type HostGpu,
  type HostGpuProbeTools,
  type PageGraphics,
  type PageWebGL2,
} from './gpu.js';
export { createBrowserBackends, PIXI_NODE_TYPES, type BrowserBackends } from './backends.js';
export { checkHtmlNode, HTML_CAPABILITIES, type HtmlCheckOptions } from './html-check.js';
export type { BrowserLayerKind, BrowserLayerPayload, OpenVideoPageApi } from './protocol.js';
export { chromiumVersionFor, createLazyBrowserBackends, expectedChromiumVersion, type GraphicsProbeStore, type LazyBrowserBackends, type LazyBrowserBackendsOptions } from './lazy.js';
export { threeBackendFor } from '@agentic-video/renderer-three';
