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

/**
 * Baut die minimale Umgebung eines Kindprozesses: nur die Variablen aus {@link CHILD_ENV_NAMES}
 * plus ausdrücklich genannte weitere Namen (`extra`, z. B. `CUDA_VISIBLE_DEVICES` für NVENC).
 * Leere Werte werden übernommen, fehlende weggelassen.
 *
 * @example
 * ```ts
 * minimalChildEnv({ PATH: '/usr/bin', OPENVIDEO_WORKER_TOKEN: 'secret' }); // { PATH: '/usr/bin' }
 * minimalChildEnv(process.env, ['NVIDIA_VISIBLE_DEVICES']);
 * ```
 */
export function minimalChildEnv(source: Readonly<Record<string, string | undefined>>, extra: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...CHILD_ENV_NAMES, ...extra]) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
