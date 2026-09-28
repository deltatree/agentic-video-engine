/**
 * Test-Hilfen: CanvasKit laden, Szenen bauen, Golden Images vergleichen.
 * Golden Images neu erzeugen: `UPDATE_GOLDENS=1 npx vitest run packages/renderer-skia`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { CanvasKit } from 'canvaskit-wasm';
import { sha256Hex, type AssetRecord, type AssetResolver, type EvaluatedNode, type EvaluatedScene, type LayerRequest, type RenderBackend, type Reveal, type RgbaImage } from '@agentic-video/core';
import { loadFontSet, type FontSet } from '@agentic-video/fonts';
import { decodePng, encodePng } from '@agentic-video/png';
import { createSkiaBackend, loadCanvasKitNode } from '@agentic-video/renderer-skia';

export const here = dirname(fileURLToPath(import.meta.url));
export const HEBREW_FONT = join(here, 'fixtures', 'noto-sans-hebrew', 'NotoSansHebrew-Regular.ttf');
/** Noto Serif hat eine echte ffi-Ligatur (Inter verzichtet bewusst darauf). */
export const SERIF_FONT = join(here, 'fixtures', 'noto-serif', 'NotoSerif-Regular.ttf');

let ckPromise: Promise<CanvasKit> | undefined;
let fontsPromise: Promise<FontSet> | undefined;

export function canvasKit(): Promise<CanvasKit> {
  ckPromise ??= loadCanvasKitNode();
  return ckPromise;
}

export function fonts(): Promise<FontSet> {
  fontsPromise ??= loadFontSet({ fonts: [{ family: 'Noto Sans Hebrew', src: HEBREW_FONT }, { family: 'Noto Serif', src: SERIF_FONT }] });
  return fontsPromise;
}

export async function backend(): Promise<RenderBackend> {
  return createSkiaBackend({ canvasKit: await canvasKit(), fonts: await fonts() });
}

let counter = 0;

/** Baut eine ausgewertete Node. */
export function n(type: string, props: Record<string, unknown> = {}, extra: { id?: string; children?: EvaluatedNode[]; mask?: EvaluatedNode['mask']; reveal?: Reveal; frame?: number } = {}): EvaluatedNode {
  const frame = extra.frame ?? 0;
  return {
    id: extra.id ?? `${type}-${String(counter++)}`,
    type,
    props,
    children: extra.children ?? [],
    ...(extra.mask !== undefined ? { mask: extra.mask } : {}),
    ...(extra.reveal !== undefined ? { reveal: extra.reveal } : {}),
    time: { localFrame: frame, relFrame: frame, durationFrames: 90, progress: frame / 90, compositionFrame: frame },
    pointer: '/compositions/0/nodes/0',
  };
}

export function scene(nodes: EvaluatedNode[], width: number, height: number, frame = 0): EvaluatedScene {
  return {
    compositionId: 'test',
    width,
    height,
    fps: 30,
    frame,
    time: frame / 30,
    seed: 1,
    durationFrames: 90,
    background: '#000000',
    colorSpace: 'srgb',
    safeArea: { action: 0.035, title: 0.05 },
    nodes,
    diagnostics: [],
  };
}

export interface TestAsset {
  readonly record: AssetRecord;
  readonly bytes: Uint8Array;
}

export function asset(id: string, type: string, bytes: Uint8Array, extra: Partial<AssetRecord> = {}): TestAsset {
  return { record: { id, type, src: `${id}.bin`, path: `/store/${id}`, hash: `sha256:${sha256Hex(bytes)}`, metadata: {}, ...extra }, bytes };
}

/** Asset-Resolver für Tests; Videobilder erzeugt `video` aus der Zeit. */
export function assets(list: TestAsset[] = [], video?: (id: string, seconds: number) => RgbaImage): AssetResolver {
  const map = new Map(list.map((a) => [a.record.id, a]));
  return {
    get: (id) => map.get(id)?.record,
    bytes: (id) => {
      const a = map.get(id);
      return a === undefined ? Promise.reject(new Error(`unknown asset ${id}`)) : Promise.resolve(a.bytes);
    },
    videoFrame: (id, seconds) => (video === undefined ? Promise.reject(new Error('no video')) : Promise.resolve(video(id, seconds))),
    all: () => list.map((a) => a.record),
  };
}

export async function request(nodes: EvaluatedNode[], options: { width: number; height: number; scale?: number; assets?: AssetResolver; frame?: number; debug?: LayerRequest['debug'] }): Promise<LayerRequest> {
  const scale = options.scale ?? 1;
  return {
    layerId: 'layer-0',
    scene: scene(nodes, options.width, options.height, options.frame ?? 0),
    nodes,
    width: Math.round(options.width * scale),
    height: Math.round(options.height * scale),
    scale,
    assets: options.assets ?? assets(),
    fonts: await fonts(),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}

/** Rendert Nodes mit einem neuen Backend. */
export async function render(nodes: EvaluatedNode[], options: Parameters<typeof request>[1], skia?: RenderBackend): Promise<RgbaImage> {
  const b = skia ?? (await backend());
  return b.renderLayer(await request(nodes, options));
}

export function hash(image: RgbaImage): string {
  return sha256Hex(image.data);
}

export function pixel(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(i, i + 4));
}

/** Vergleicht ein Bild mit `test/golden/<name>.png` (Toleranz ±1 je Kanal). */
export function expectGolden(name: string, image: RgbaImage): void {
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
  let maxDiff = 0;
  let count = 0;
  for (let i = 0; i < actual.data.length; i++) {
    const d = Math.abs((actual.data[i] ?? 0) - (expected.data[i] ?? 0));
    if (d > 1) count++;
    maxDiff = Math.max(maxDiff, d);
  }
  expect({ name, differingChannels: count, maxDiff: count > 0 ? maxDiff : 0 }).toEqual({ name, differingChannels: 0, maxDiff: 0 });
}
