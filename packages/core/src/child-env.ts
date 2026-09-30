/**
 * Minimale Umgebung für Kindprozesse (Story 16.5, N1): FFmpeg, Chromium, Blender, Piper und
 * whisper erben nur eine feste Liste unkritischer Variablen. Tokens und Zugangsdaten
 * (`OPENVIDEO_*_TOKEN`, `OPENVIDEO_S3_*`, `AWS_*`) bleiben im Elternprozess.
 */

/**
 * Variablen, die jeder Kindprozess erben darf: Suchpfade, Temp-Ordner, Sprache/Zeitzone,
 * Bibliotheks- und Schriftpfade, XDG-Ordner und die Windows-Systemvariablen.
 */
export const CHILD_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'LD_LIBRARY_PATH',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'SYSTEMROOT',
  'WINDIR',
];

/** Zusätzlich erlaubte Variablen eines Programms. */
export interface ChildEnvExtra {
  /** Weitere Namen, z. B. `PYTHONPATH` für Piper. */
  readonly names?: readonly string[];
  /** Präfixe für Einstellungen des Programms oder der GPU-Treiber, z. B. `CUDA_`, `BLENDER_`. */
  readonly prefixes?: readonly string[];
}

/**
 * Baut die minimale Umgebung eines Kindprozesses: nur die Variablen aus {@link CHILD_ENV_NAMES}
 * plus ausdrücklich genannte Namen und Präfixe (`extra`). Fehlende Werte werden weggelassen.
 *
 * @example
 * ```ts
 * minimalChildEnv({ PATH: '/usr/bin', OPENVIDEO_WORKER_TOKEN: 'secret' }); // { PATH: '/usr/bin' }
 * minimalChildEnv(process.env, { prefixes: ['CUDA_', 'NVIDIA_'] });
 * ```
 */
export function minimalChildEnv(source: Readonly<Record<string, string | undefined>>, extra: ChildEnvExtra = {}): Record<string, string> {
  const names = new Set([...CHILD_ENV_NAMES, ...(extra.names ?? [])]);
  const prefixes = extra.prefixes ?? [];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (names.has(name) || prefixes.some((p) => name.startsWith(p))) out[name] = value;
  }
  return out;
}
