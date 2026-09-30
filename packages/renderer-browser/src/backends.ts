/**
 * Drei Render-Backends auf einem gemeinsamen Chromium-Host (AD-5):
 * `browser` (html), `three` (scene3d) und `pixi` (2D-Nodes).
 */
import { OpenVideoError, type BackendCheck, type LayerRequest, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { checkPixiNode, PIXI_CAPABILITIES } from '@agentic-video/renderer-pixi';
import { checkThreeNode, THREE_CAPABILITIES } from '@agentic-video/renderer-three';
import { checkHtmlNode, checkResult, HTML_CAPABILITIES } from './html-check.js';
import { createBrowserHost, type BrowserHost, type BrowserHostOptions } from './host.js';
import { hostLayerError } from './page-error.js';
import type { BrowserLayerKind, BrowserLayerPayload } from './protocol.js';

/** Node-Typen, die das `pixi`-Backend rendert (Teilmenge von Skia, siehe `checkPixiNode`). */
export const PIXI_NODE_TYPES: readonly string[] = ['group', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'image', 'video', 'sprite', 'shader', 'particles'];

/** Die drei Backends und ihr gemeinsamer Host. */
export interface BrowserBackends {
  readonly host: BrowserHost;
  /** `browser`: html-Nodes. */
  readonly browser: RenderBackend;
  /** `three`: scene3d-Nodes, ein Node je Layer. */
  readonly three: RenderBackend;
  /** `pixi`: 2D-Nodes, fusionierbar. */
  readonly pixi: RenderBackend;
}

/** Grafik-Probe für `three`-Layer (siehe {@link BrowserLayerPayload.graphics}). */
export type ThreeGraphicsSource = () => BrowserLayerPayload['graphics'];

/** Optionen für {@link createBrowserBackends}. */
export interface BrowserBackendsOptions extends BrowserHostOptions {
  /**
   * Liefert das Probe-Ergebnis, das im Cache-Schlüssel steht (Review M3); es geht mit jedem
   * `three`-Layer an die Seite. Ohne Angabe entscheidet die Seite live.
   */
  readonly threeGraphics?: ThreeGraphicsSource;
}

function toPayload(request: LayerRequest, graphics?: BrowserLayerPayload['graphics']): BrowserLayerPayload {
  const debug = request.debug === undefined ? undefined : { ...(request.debug.showCameraFrustum === undefined ? {} : { showCameraFrustum: request.debug.showCameraFrustum }), ...(request.debug.showLightHelpers === undefined ? {} : { showLightHelpers: request.debug.showLightHelpers }) };
  return {
    nodes: request.nodes,
    width: request.width,
    height: request.height,
    scale: request.scale,
    frame: request.scene.frame,
    time: request.scene.time,
    fps: request.scene.fps,
    seed: request.scene.seed,
    compositionWidth: request.scene.width,
    compositionHeight: request.scene.height,
    ...(debug === undefined ? {} : { debug }),
    ...(graphics === undefined ? {} : { graphics }),
  };
}

/**
 * Startet einen Host und liefert die drei Backends. `dispose()` jedes Backends gibt seinen
 * Anteil frei; der Host schließt, sobald alle drei freigegeben sind.
 *
 * @example
 * ```ts
 * const { browser, three, pixi } = await createBrowserBackends({ assets, fonts, width: 1920, height: 1080 });
 * registry.registerBackend(browser);
 * ```
 */
export async function createBrowserBackends(options: BrowserBackendsOptions): Promise<BrowserBackends> {
  const { threeGraphics, ...hostOptions } = options;
  const host = await createBrowserHost(hostOptions);
  let holders = 3;
  const make = (
    id: string,
    kind: BrowserLayerKind,
    nodeTypes: readonly string[],
    capabilities: readonly string[],
    fusable: boolean,
    check: (node: Readonly<Record<string, unknown>>) => BackendCheck,
    library: string | undefined,
  ): RenderBackend => {
    let disposed = false;
    return {
      id,
      nodeTypes,
      capabilities,
      fusable,
      versions() {
        const all = host.versions();
        const out: Record<string, string> = { chromium: all['chromium'] ?? 'unknown' };
        if (library !== undefined) out[library] = all[library] ?? 'unknown';
        // Freigegebene HTML-Skripte ändern die Pixel: eigener Schlüssel, nur wenn gesetzt (Review m2).
        if (kind === 'html' && options.allowHtmlScripts === true) out['html-scripts'] = 'allowed';
        return out;
      },
      check,
      async renderLayer(request: LayerRequest): Promise<RgbaImage> {
        if (request.signal?.aborted === true) {
          throw new OpenVideoError({ code: 'OV_BROWSER_ABORTED', errorClass: 'BrowserRendererError', problem: `Rendering layer "${request.layerId}" was aborted.`, suggestions: ['Start the render again.'] });
        }
        if (kind === 'html') {
          const masked = request.nodes.find((n) => n.mask !== undefined);
          if (masked !== undefined) {
            throw new OpenVideoError({ code: 'OV_BROWSER_UNSUPPORTED', errorClass: 'BrowserRendererError', problem: 'The browser backend cannot apply a node mask to an html node.', nodeId: masked.id, pointer: masked.pointer, suggestions: ['Wrap the html node in a group and put the mask on the group.'] });
          }
        }
        try {
          return await host.render(kind, toPayload(request, kind === 'three' ? threeGraphics?.() : undefined));
        } catch (error) {
          // Fehler der Seite kommen als Text; die Diagnose darin wird wieder ein OpenVideoError (Story 21.7).
          throw hostLayerError(error, kind, request.nodes.map((n) => n.id));
        }
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        holders--;
        if (holders === 0) await host.close();
      },
    };
  };
  const threeCheck = (node: Readonly<Record<string, unknown>>): BackendCheck => checkResult(checkThreeNode(node));
  const pixiCheck = (node: Readonly<Record<string, unknown>>): BackendCheck => checkResult(checkPixiNode(node));
  return {
    host,
    browser: make('browser', 'html', ['html'], HTML_CAPABILITIES, true, (n) => checkHtmlNode(n, { allowScripts: options.allowHtmlScripts === true }), undefined),
    three: make('three', 'three', ['scene3d'], THREE_CAPABILITIES, false, threeCheck, 'three'),
    pixi: make('pixi', 'pixi', PIXI_NODE_TYPES, PIXI_CAPABILITIES, true, pixiCheck, 'pixi'),
  };
}
