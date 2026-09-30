/**
 * Gemeinsame Helfer der Beispiel-Tests (Story 19.7). Jeder Test kopiert sein Beispielprojekt in einen
 * temporären Ordner, erzeugt dort die Assets mit dem Skript des Beispiels und ruft die CLI genau so auf,
 * wie es die README beschreibt (`openvideo validate`, `openvideo render-frame`).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCli } from '@agentic-video/cli';
import { isRecord, type RgbaImage } from '@agentic-video/core';
import { decodePng } from '@agentic-video/png';

/** Ergebnis eines CLI-Aufrufs. */
export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Kopiert ein Beispiel ohne Render-Ausgaben und Caches in einen temporären Ordner und führt dort
 * `generate-assets.mjs` aus, falls vorhanden.
 *
 * @example
 * ```ts
 * const dir = prepareExample(fileURLToPath(new URL('.', import.meta.url)));
 * ```
 */
export function prepareExample(source: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `ov-example-${basename(source)}-`)), basename(source));
  cpSync(source, dir, { recursive: true, filter: (path) => !['out', '.openvideo', 'node_modules'].includes(basename(path)) });
  const script = join(dir, 'generate-assets.mjs');
  if (existsSync(script)) {
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`generate-assets.mjs failed (${String(r.status)}):\n${r.stdout}\n${r.stderr}`);
  }
  return dir;
}

/**
 * Führt die CLI im Prozess aus (wie `openvideo <args>` im Beispielordner).
 *
 * @example
 * ```ts
 * const r = await openvideo(['validate', '--json'], dir);
 * ```
 */
export async function openvideo(args: readonly string[], cwd: string): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd,
    env: { ...process.env, OPENVIDEO_FFMPEG: process.env['OPENVIDEO_FFMPEG'] ?? '/usr/bin/ffmpeg', OPENVIDEO_FFPROBE: process.env['OPENVIDEO_FFPROBE'] ?? '/usr/bin/ffprobe' },
  });
  return { code, stdout, stderr };
}

/**
 * Liest die JSON-Ausgabe eines CLI-Aufrufs mit `--json`.
 *
 * @example
 * ```ts
 * const out = jsonOf(await openvideo(['validate', '--json'], dir));
 * ```
 */
export function jsonOf(result: CliResult): Record<string, unknown> {
  const value: unknown = JSON.parse(result.stdout);
  if (!isRecord(value)) throw new Error(`Expected a JSON object, got:\n${result.stdout}\n${result.stderr}`);
  return value;
}

/**
 * Diagnosen mit `severity: "error"` aus einer Liste.
 *
 * @example
 * ```ts
 * expect(errorsOf(out['diagnostics'])).toEqual([]);
 * ```
 */
export function errorsOf(diagnostics: unknown): Record<string, unknown>[] {
  return Array.isArray(diagnostics) ? diagnostics.filter(isRecord).filter((d) => d['severity'] === 'error') : [];
}

/**
 * Anteil der Pixel eines PNG, die sich von einer Hintergrundfarbe (`#RRGGBB`) unterscheiden.
 *
 * @example
 * ```ts
 * expect(changedFraction('out/frame.png', '#0B0D12')).toBeGreaterThan(0.05);
 * ```
 */
export function changedFraction(pngFile: string, background: string): number {
  const img: RgbaImage = decodePng(readFileSync(pngFile));
  const bg = [1, 3, 5].map((i) => Number.parseInt(background.slice(i, i + 2), 16));
  let changed = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const diff = Math.abs((img.data[i] ?? 0) - (bg[0] ?? 0)) + Math.abs((img.data[i + 1] ?? 0) - (bg[1] ?? 0)) + Math.abs((img.data[i + 2] ?? 0) - (bg[2] ?? 0));
    if (diff > 12) changed++;
  }
  return changed / (img.data.length / 4);
}
