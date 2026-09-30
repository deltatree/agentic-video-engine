/**
 * Story 21.7: Fehler der Render-Seite kommen als strukturierter OpenVideoError beim Host an.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenVideoError, type EvaluatedNode, type LayerRequest } from '@agentic-video/core';
import { createBrowserBackends, type BrowserBackends } from '../src/backends.js';
import { hostLayerError, pageDiagnostic, toPageError } from '../src/page-error.js';
import { buildRuntime, memoryAssets, node, testFonts } from './helpers.js';

describe('page-error (rein)', () => {
  it('verpackt die Diagnose eines OpenVideoError und packt sie wieder aus', () => {
    const original = new OpenVideoError({ code: 'OV_PIXI_ASSET_LOAD', errorClass: 'PixiRendererError', problem: 'Could not load "x".', nodeId: 'img', details: { url: '/assets/x' }, suggestions: ['Import it.'] });
    const packed = toPageError(original);
    if (!(packed instanceof Error)) throw new Error('expected an Error');
    const transported = new Error(`page.evaluate: Error: ${packed.message}\n    at stack`);
    expect(pageDiagnostic(transported.message)).toEqual(original.diagnostic);
    expect(hostLayerError(transported, 'pixi', ['img']).diagnostic).toEqual(original.diagnostic);
    // Auch wenn der Host den Seitenfehler schon als OV_BROWSER_RENDER verpackt hat.
    const wrapped = new OpenVideoError({ code: 'OV_BROWSER_RENDER', errorClass: 'BrowserRendererError', problem: 'x', suggestions: [], cause: transported });
    expect(hostLayerError(wrapped, 'pixi', ['img']).diagnostic).toEqual(original.diagnostic);
  });

  it('lässt fremde Fehler durch und macht unbekannte zu OV_BROWSER_LAYER_FAILED', () => {
    const plain = new RangeError('OV_BROWSER_TIMER_LIMIT: too many timers');
    expect(toPageError(plain)).toBe(plain);
    const host = new OpenVideoError({ code: 'OV_BROWSER_TIMEOUT', errorClass: 'BrowserRendererError', problem: 'x', suggestions: [] });
    expect(hostLayerError(host, 'html', ['h'])).toBe(host);
    const failed = hostLayerError(new Error('Target page, context or browser has been closed'), 'pixi', ['a']);
    expect(failed.diagnostic.code).toBe('OV_BROWSER_LAYER_FAILED');
    expect(failed.diagnostic.nodeId).toBe('a');
    expect(pageDiagnostic('no marker')).toBeUndefined();
    expect(pageDiagnostic('[ov-diagnostic]{broken[/ov-diagnostic]')).toBeUndefined();
  });
});

const W = 64;
const H = 48;
let backends: BrowserBackends;

beforeAll(async () => {
  buildRuntime();
  backends = await createBrowserBackends({ assets: memoryAssets({}), fonts: testFonts(), width: W, height: H });
}, 120_000);

afterAll(async () => {
  await backends.browser.dispose();
  await backends.three.dispose();
  await backends.pixi.dispose();
});

describe('Pixi-Layer mit fehlendem Asset', () => {
  it('liefert OV_PIXI_ASSET_LOAD als OpenVideoError statt eines rohen Fehlers', async () => {
    const img: EvaluatedNode = { ...node('photo', 'image', { asset: 'ghost', width: 32, height: 32 }, 0), children: [] };
    const request: LayerRequest = {
      layerId: 'l1',
      scene: { compositionId: 't', width: W, height: H, fps: 30, frame: 0, time: 0, seed: 1, durationFrames: 1, background: '#000000', colorSpace: 'srgb', safeArea: { action: 0.9, title: 0.8 }, nodes: [img], diagnostics: [] },
      nodes: [img],
      width: W,
      height: H,
      scale: 1,
      assets: memoryAssets({}),
      fonts: testFonts(),
    };
    const error: unknown = await backends.pixi.renderLayer(request).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenVideoError);
    if (!(error instanceof OpenVideoError)) return;
    expect(error.diagnostic.code).toBe('OV_PIXI_ASSET_LOAD');
    expect(error.diagnostic.nodeId).toBe('photo');
    expect(error.diagnostic.suggestions.length).toBeGreaterThan(0);
  }, 60_000);
});
