/**
 * Test-Hilfen: Laufzeit bauen, In-Memory-Resolver, Nodes, Goldens.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { sha256Hex, type AssetRecord, type AssetResolver, type EvaluatedNode, type FontFace, type FontResolver, type RgbaImage } from '@agentic-video/core';
import { decodePng, encodePng } from '@agentic-video/png';

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(here, '..');
const repoRoot = join(packageDir, '..', '..');

let built = false;
/** Baut dist/runtime.js und dist/clock.js einmal je Testprozess. */
export function buildRuntime(): void {
  if (built) return;
  execFileSync(process.execPath, [join(packageDir, 'scripts', 'build-runtime.mjs')], { stdio: 'inherit' });
  built = true;
}

/** Schriftfamilie aus dem FontResolver (nicht im System installiert). */
export const TEST_FONT = 'OV Test Inter';

export function testFonts(): FontResolver {
  const bytes = new Uint8Array(readFileSync(join(repoRoot, 'packages/fonts/assets/inter/InterVariable.ttf')));
  const face: FontFace = { family: TEST_FONT, weight: [100, 900], style: 'normal', hash: sha256Hex(bytes).slice(0, 16), path: 'InterVariable.ttf', bytes, variable: true };
  return { all: () => [face], has: (f) => f === TEST_FONT, fallbacks: () => [] };
}

export function memoryAssets(files: Record<string, { path: string; bytes: Uint8Array; type?: string }>, video?: (id: string, seconds: number) => RgbaImage): AssetResolver {
  const records = new Map<string, AssetRecord>(
    Object.entries(files).map(([id, f]) => [id, { id, type: f.type ?? 'image', src: f.path, path: f.path, hash: sha256Hex(f.bytes), metadata: {} }]),
  );
  return {
    get: (id) => records.get(id),
    bytes: (id) => {
      const f = files[id];
      return f === undefined ? Promise.reject(new Error(`unknown asset ${id}`)) : Promise.resolve(f.bytes);
    },
    videoFrame: (id, seconds) => (video === undefined ? Promise.reject(new Error('no video')) : Promise.resolve(video(id, seconds))),
    all: () => [...records.values()],
  };
}

export function node(id: string, type: string, props: Record<string, unknown>, localFrame = 0, durationFrames = 60, extra: Partial<EvaluatedNode> = {}): EvaluatedNode {
  return {
    id,
    type,
    props,
    children: [],
    time: { localFrame, relFrame: localFrame, durationFrames, progress: durationFrames > 0 ? localFrame / durationFrames : 0, compositionFrame: localFrame },
    pointer: `/nodes/${id}`,
    ...extra,
  };
}

export function hashImage(image: RgbaImage): string {
  return sha256Hex(image.data);
}

export function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0, image.data[i + 3] ?? 0];
}

/**
 * Vergleicht mit `test/golden/<name>.png`. Mit `UPDATE_GOLDENS=1` wird die Datei geschrieben.
 * Toleranz: Kanal-Abweichung ≤ 2 bei höchstens 0,5 % der Pixel größer.
 */
export function expectGolden(name: string, image: RgbaImage): void {
  const file = join(packageDir, 'test', 'golden', `${name}.png`);
  if (process.env['UPDATE_GOLDENS'] === '1' || !existsSync(file)) {
    if (process.env['UPDATE_GOLDENS'] !== '1') throw new Error(`Golden ${name}.png is missing; run with UPDATE_GOLDENS=1 and review it.`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, encodePng(image));
    return;
  }
  const golden = decodePng(new Uint8Array(readFileSync(file)));
  expect([image.width, image.height]).toEqual([golden.width, golden.height]);
  // Vergleich über PNG-Rundreise, denn das Golden speichert gerades Alpha.
  const actual = decodePng(encodePng(image));
  let off = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs((actual.data[i + c] ?? 0) - (golden.data[i + c] ?? 0)));
    if (d > 2) off++;
  }
  expect(off / (actual.width * actual.height)).toBeLessThanOrEqual(0.005);
}

let sandboxProbe: Promise<boolean> | undefined;

/**
 * Startet Chromium hier mit OS-Sandbox? Nur dann laufen HTML-Skripte (Story 16.1); Tests mit
 * Skripten werden sonst mit dieser Begründung übersprungen (z. B. als root ohne User Namespaces).
 */
export function osSandboxAvailable(): Promise<boolean> {
  sandboxProbe ??= import('../src/host.js').then((m) => m.probeOsSandbox());
  return sandboxProbe;
}

/** Kommandozeilen und Umgebungen der Chromium-Kindprozesse dieses Test-Prozesses (Linux, `/proc`). */
export function chromiumProcesses(): { readonly pid: number; readonly args: string; readonly env: string }[] {
  const pids = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter((p) => p !== '');
  return pids
    .map((pid) => ({ pid: Number(pid), args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '), env: readFileSync(`/proc/${pid}/environ`, 'utf8') }))
    .filter((p) => p.args.includes('--remote-debugging-pipe'));
}
