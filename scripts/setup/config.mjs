// Konfigurationsverzeichnis von `npm run setup` (ADR 0029): runtime.json (gewählte Laufzeit und Einstellungen)
// und api.env (zufälliges API-Token für serve/dev/studio), beide nur für den Nutzer lesbar (0600).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Konfigurationsverzeichnis: `OPENVIDEO_CONFIG_DIR`, sonst `$XDG_CONFIG_HOME/openvideo`,
 * `~/.config/openvideo` bzw. `%APPDATA%\openvideo` unter Windows.
 *
 * @example
 * configDir({ OPENVIDEO_CONFIG_DIR: '/tmp/ov' }); // '/tmp/ov'
 */
export function configDir(env, platform = process.platform, home = env.HOME ?? homedir()) {
  if (env.OPENVIDEO_CONFIG_DIR !== undefined && env.OPENVIDEO_CONFIG_DIR !== '') return env.OPENVIDEO_CONFIG_DIR;
  if (platform === 'win32' && env.APPDATA !== undefined && env.APPDATA !== '') return join(env.APPDATA, 'openvideo');
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '') return join(env.XDG_CONFIG_HOME, 'openvideo');
  return join(home, '.config', 'openvideo');
}

/** Pfade im Konfigurationsverzeichnis. */
export function configPaths(dir) {
  return { dir, runtime: join(dir, 'runtime.json'), envFile: join(dir, 'api.env'), kubernetes: join(dir, 'kubernetes') };
}

/** Liest runtime.json; fehlt die Datei oder ist sie kaputt, `undefined` (mit Grund). */
export function readConfig(paths) {
  if (!existsSync(paths.runtime)) return { config: undefined };
  try {
    const config = JSON.parse(readFileSync(paths.runtime, 'utf8'));
    return typeof config === 'object' && config !== null && typeof config.runtime === 'string' ? { config } : { config: undefined, problem: `${paths.runtime} has no "runtime"; ignoring it.` };
  } catch (error) {
    return { config: undefined, problem: `${paths.runtime} is not valid JSON (${error instanceof Error ? error.message : String(error)}); ignoring it.` };
  }
}

/** Schreibt eine Datei nur für den Nutzer lesbar (0600), auch wenn sie schon mit anderen Rechten existierte. */
export function writePrivate(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Legt das Verzeichnis nur für den Nutzer zugänglich an (0700). */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Vorhandenes Token aus api.env oder `undefined`. */
export function readToken(envFile) {
  if (!existsSync(envFile)) return undefined;
  const m = /^OPENVIDEO_API_TOKEN=([A-Za-z0-9_-]{24,})$/mu.exec(readFileSync(envFile, 'utf8'));
  return m?.[1];
}

/**
 * Inhalt von api.env: bestehendes Token behalten (laufende Studio-Tabs bleiben gültig), sonst ein neues
 * (32 zufällige Bytes, base64url).
 *
 * @example
 * envFileContent(undefined); // 'OPENVIDEO_API_TOKEN=…\n'
 */
export function envFileContent(existing) {
  const token = existing ?? randomBytes(32).toString('base64url');
  return `OPENVIDEO_API_TOKEN=${token}\n`;
}
