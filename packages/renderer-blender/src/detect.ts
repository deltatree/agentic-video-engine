/**
 * Findet eine Blender-Installation und liest ihre Version.
 *
 * Suchreihenfolge: Option `blenderPath` → Umgebungsvariable `OPENVIDEO_BLENDER` → `PATH`
 * → `~/.local/opt/blender*∕blender` (höchste Version zuerst).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Diagnostic } from '@agentic-video/core';

/** Gefundene Blender-Installation. */
export interface BlenderInstall {
  readonly path: string;
  /** Version wie `4.2.23`. */
  readonly version: string;
}

/** Ergebnis von {@link detectBlender}. */
export type BlenderDetection = ({ readonly found: true } & BlenderInstall) | { readonly found: false; readonly diagnostic: Diagnostic };

/** Optionen für {@link detectBlender}. */
export interface DetectOptions {
  readonly blenderPath?: string;
  /** Umgebung für `OPENVIDEO_BLENDER`, `PATH` und `HOME`. Standard: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (never) {
    // Nicht vorhanden oder nicht ausführbar: nächster Kandidat.
    return false;
  }
}

function localOptCandidates(home: string): string[] {
  const dir = join(home, '.local', 'opt');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((e) => e.startsWith('blender'))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((e) => join(dir, e, 'blender'));
}

/** Alle Kandidaten in Suchreihenfolge. */
export function blenderCandidates(options: DetectOptions = {}): string[] {
  const env = options.env ?? process.env;
  const out: string[] = [];
  if (options.blenderPath !== undefined) out.push(options.blenderPath);
  const fromEnv = env['OPENVIDEO_BLENDER'];
  if (fromEnv !== undefined && fromEnv !== '') out.push(fromEnv);
  for (const dir of (env['PATH'] ?? '').split(delimiter)) if (dir !== '') out.push(join(dir, 'blender'));
  out.push(...localOptCandidates(env['HOME'] ?? homedir()));
  return out;
}

/**
 * Sucht Blender und liest die Version (`blender --version`).
 *
 * @example
 * ```ts
 * const found = detectBlender();
 * if (found.found) console.info(found.path, found.version);
 * else console.error(found.diagnostic.problem);
 * ```
 */
export function detectBlender(options: DetectOptions = {}): BlenderDetection {
  const tried = blenderCandidates(options);
  for (const path of tried) {
    if (!executable(path)) continue;
    const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 60_000 });
    const match = /Blender\s+(\d+\.\d+(?:\.\d+)?)/u.exec(result.stdout);
    if (result.status === 0 && match?.[1] !== undefined) return { found: true, path, version: match[1] };
  }
  return {
    found: false,
    diagnostic: {
      code: 'OV_BLENDER_MISSING',
      severity: 'error',
      errorClass: 'BlenderRendererError',
      problem: 'Blender was not found.',
      details: { tried: tried.join(delimiter) },
      suggestions: [
        'Install Blender 4.2 LTS: download blender-4.2.*-linux-x64.tar.xz from https://download.blender.org/release/Blender4.2/, check its .sha256, and unpack it to ~/.local/opt/.',
        'Or set OPENVIDEO_BLENDER=/path/to/blender.',
        'Or pass blenderPath to createBlenderBackend().',
      ],
    },
  };
}
