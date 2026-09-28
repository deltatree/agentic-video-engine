/**
 * `PixiLayerRenderer`: rendert 2D-Nodes mit PixiJS (WebGL) in ein Canvas (FR-31).
 * Läuft nur im Browser (Chromium-Render-Host oder Studio).
 */
import 'pixi.js/advanced-blend-modes';
import { OpenVideoError } from '@agentic-video/core';
import { Container, RenderTexture, Texture, autoDetectRenderer, type Renderer } from 'pixi.js';
import { buildNode, type BuildContext, type PixiLayerInput } from './build.js';

async function loadTexture(url: string, nearest: boolean): Promise<Texture> {
  let bitmap: ImageBitmap;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
  } catch (error) {
    throw new OpenVideoError({
      code: 'OV_PIXI_ASSET_LOAD',
      errorClass: 'PixiRendererError',
      problem: `Could not load the image at "${url}".`,
      details: { url },
      cause: error,
      suggestions: ['Check that the asset id exists and was imported.', 'Check that the host serves the asset under this URL.'],
    });
  }
  const texture = Texture.from(bitmap);
  texture.source.scaleMode = nearest ? 'nearest' : 'linear';
  return texture;
}

/**
 * Rendert die 2D-Nodes eines Layers mit PixiJS.
 *
 * - Semantik wie Skia (docs/reference/node-semantics.md); Transform über `localMatrix` aus core.
 * - Zeit kommt nur aus der Eingabe; es gibt keinen Ticker. Der Szenengraph wird pro Aufruf neu
 *   gebaut, daher hängt Frame n nie von Frame n−1 ab. Bilder werden pro URL zwischengespeichert.
 * - Ergebnis: ein neues 2D-Canvas `width·scale × height·scale` mit transparentem Hintergrund.
 * - Was PixiJS nicht kann, meldet `checkPixiNode`; nicht unterstützte Node-Typen werfen `OV_PIXI_UNSUPPORTED`.
 *
 * @example
 * ```ts
 * const renderer = new PixiLayerRenderer();
 * const canvas = await renderer.render({ nodes, width: 1920, height: 1080, scale: 0.5, frame: 12, time: 0.4, fps: 30, seed: 1, assetUrl, videoFrame, defaultFont: 'Inter' });
 * ```
 */
export class PixiLayerRenderer {
  private renderer: Promise<Renderer> | undefined;
  private readonly textures = new Map<string, Promise<Texture>>();
  private renderTexture: RenderTexture | undefined;

  /** Rendert einen Frame des Layers. */
  async render(input: PixiLayerInput): Promise<HTMLCanvasElement> {
    const width = Math.max(1, Math.round(input.width * input.scale));
    const height = Math.max(1, Math.round(input.height * input.scale));
    this.renderer ??= autoDetectRenderer({
      preference: 'webgl',
      width,
      height,
      backgroundAlpha: 0,
      antialias: true,
      resolution: 1,
      autoDensity: false,
      // Erweiterte Blend Modes (overlay, difference …) brauchen in PixiJS diese Option.
      useBackBuffer: true,
    });
    const renderer = await this.renderer;
    if (renderer.width !== width || renderer.height !== height) renderer.resize(width, height, 1);
    const ctx: BuildContext = { input, renderer, texture: (url, nearest) => this.texture(url, nearest), disposables: [] };
    const stage = new Container();
    stage.scale.set(input.scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      for (const node of input.nodes) stage.addChild(await buildNode(node, ctx));
      // Ziel ist eine eigene Render-Textur: Erweiterte Blend Modes können dort den Hintergrund lesen,
      // und kein Inhalt eines vorigen Frames bleibt im Canvas stehen.
      const target = this.target(width, height);
      renderer.render({ container: stage, target, clear: true, clearColor: [0, 0, 0, 0] });
      const out = canvas.getContext('2d');
      if (out === null) throw new OpenVideoError({ code: 'OV_PIXI_CANVAS', errorClass: 'PixiRendererError', problem: 'Could not create a 2D canvas context for the output.', suggestions: ['Reduce the output size.'] });
      const pixels = renderer.extract.canvas(target);
      if (!(pixels instanceof HTMLCanvasElement) && !(pixels instanceof OffscreenCanvas)) {
        throw new OpenVideoError({ code: 'OV_PIXI_CANVAS', errorClass: 'PixiRendererError', problem: 'PixiJS returned no drawable canvas for the layer.', suggestions: ['Run the PixiJS renderer in a browser page.'] });
      }
      out.drawImage(pixels, 0, 0);
    } finally {
      stage.destroy({ children: true });
      for (const d of ctx.disposables) d.destroy();
    }
    return canvas;
  }

  private target(width: number, height: number): RenderTexture {
    if (this.renderTexture?.width !== width || this.renderTexture.height !== height) {
      this.renderTexture?.destroy(true);
      this.renderTexture = RenderTexture.create({ width, height, resolution: 1, antialias: true });
    }
    return this.renderTexture;
  }

  private texture(url: string, nearest: boolean): Promise<Texture> {
    const key = `${nearest ? 'nearest' : 'linear'}:${url}`;
    let p = this.textures.get(key);
    if (p === undefined) {
      p = loadTexture(url, nearest);
      p.catch(() => this.textures.delete(key));
      this.textures.set(key, p);
    }
    return p;
  }

  /** Gibt Renderer und zwischengespeicherte Texturen frei. */
  dispose(): void {
    const textures = [...this.textures.values()];
    this.textures.clear();
    for (const p of textures) {
      p.then(
        (t) => {
          t.destroy(true);
        },
        () => undefined,
      );
    }
    this.renderTexture?.destroy(true);
    this.renderTexture = undefined;
    const renderer = this.renderer;
    this.renderer = undefined;
    renderer?.then(
      (r) => {
        r.destroy();
      },
      () => undefined,
    );
  }
}
