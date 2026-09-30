/**
 * Öffnet das Studio im Standard-Browser (`openvideo dev --open`, Story 20.1, Audit §47).
 */
import { spawn } from 'node:child_process';

/** Befehl, der auf einer Plattform eine URL im Standard-Browser öffnet. */
export interface BrowserCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Plattformgerechter Befehl zum Öffnen einer URL. `rundll32` unter Windows reicht die URL
 * unverändert weiter (auch `#`, `&` und `?`), anders als `cmd /c start`.
 *
 * @example
 * ```ts
 * browserCommand('darwin', 'http://127.0.0.1:7788/'); // { command: 'open', args: ['http://127.0.0.1:7788/'] }
 * ```
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Warum der Browser nicht automatisch geöffnet wird, oder `undefined`, wenn er geöffnet werden kann
 * (CI und Linux ohne grafische Sitzung öffnen nichts).
 *
 * @example
 * ```ts
 * cannotOpenReason('linux', {}); // 'no graphical session (DISPLAY/WAYLAND_DISPLAY not set)'
 * ```
 */
export function cannotOpenReason(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== 'false') return 'running in CI';
  if (platform !== 'darwin' && platform !== 'win32' && (env['DISPLAY'] ?? '') === '' && (env['WAYLAND_DISPLAY'] ?? '') === '') return 'no graphical session (DISPLAY/WAYLAND_DISPLAY not set)';
  return undefined;
}

/**
 * Startet den Browser losgelöst vom Prozess; Fehler (z. B. fehlendes `xdg-open`) kommen als Rückgabe.
 *
 * @example
 * ```ts
 * const problem = await openBrowser('http://127.0.0.1:7788/');
 * if (problem !== undefined) console.error(problem);
 * ```
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const { command, args } = browserCommand(platform, url);
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', (error) => {
        resolvePromise(`${command} failed: ${error.message}`);
      });
      child.once('spawn', () => {
        child.unref();
        resolvePromise(undefined);
      });
    } catch (error) {
      resolvePromise(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
