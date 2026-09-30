// Hilfen für `npm run setup` (ADR 0029): Programme im PATH finden, kurze Proben ausführen, Shell-Quoting.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Sucht ein Programm im PATH der übergebenen Umgebung (Tests setzen einen eigenen PATH mit Stub-Programmen).
 *
 * @example
 * which('docker', process.env); // '/usr/bin/docker' oder undefined
 */
export function which(name, env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter((d) => d !== '');
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()).concat(['']) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (platform !== 'win32') accessSync(file, constants.X_OK);
        return file;
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR')) continue;
        throw error;
      }
    }
  }
  return undefined;
}

/**
 * Führt ein Programm kurz aus (Erkennung, keine Ausgabe an den Nutzer) und liefert Status und Ausgabe.
 * Ein Timeout gilt als Fehlschlag (z. B. `kubectl version` gegen einen nicht erreichbaren Cluster).
 *
 * @example
 * probe('docker', ['info'], { env: process.env }); // { ok: true, stdout: '…', stderr: '' }
 */
export function probe(cmd, args, { env, timeoutMs = 15_000, cwd } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: timeoutMs, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = (r.stdout ?? '').trim();
  const stderr = (r.stderr ?? '').trim();
  if (r.error !== undefined) return { ok: false, stdout, stderr: r.error.message, timedOut: r.error.message.includes('ETIMEDOUT') };
  return { ok: r.status === 0, stdout, stderr, status: r.status };
}

/** Erste nicht leere Zeile einer Fehlermeldung (für kurze Gründe in der Ausgabe). */
export function firstLine(text) {
  return (text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

/**
 * Setzt einen Wert für POSIX-Shellskripte in einfache Anführungszeichen (keine Interpolation).
 *
 * @example
 * shq("it's"); // "'it'\\''s'"
 */
export function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Setzt einen Wert für PowerShell in einfache Anführungszeichen.
 *
 * @example
 * psq("it's"); // "'it''s'"
 */
export function psq(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Befehl als lesbare Zeile (Ausgabe und `--dry-run`). */
export function commandLine(cmd, argv) {
  return [cmd, ...argv].map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(a) ? a : shq(a))).join(' ');
}
