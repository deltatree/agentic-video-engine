/**
 * Zugriff auf die Agent API (gleiche Origin, nur `/v1/*`).
 * Das Studio hat keinen eigenen Speicher: jede Änderung geht als Operation an den Server.
 */
import type { Diagnostic } from '@agentic-video/core';
import { rec, toDiagnostic, type Rec } from './json.js';

/** Fehler einer Operation mit der Diagnose des Servers. */
export class ApiError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.problem);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'openvideo.token';
let cachedToken: string | null | undefined;

/**
 * Liest das Token einmal aus `#token=` (oder `?token=`), legt es in `sessionStorage`
 * und entfernt es aus der Adresse. So landet es nicht im Verlauf und nicht im Referer.
 */
function apiToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token');
  const search = new URLSearchParams(window.location.search);
  const fresh = fromHash ?? search.get('token');
  if (fresh !== null && fresh !== '') {
    cachedToken = fresh;
    try {
      sessionStorage.setItem(TOKEN_KEY, fresh);
    } catch (error) {
      // Gesperrter Speicher: Das Token gilt dann nur für diese Seite.
      console.warn('OpenVideo Studio: token not stored', error);
    }
    search.delete('token');
    const rest = search.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest !== '' ? `?${rest}` : ''}`);
    return fresh;
  }
  try {
    cachedToken = sessionStorage.getItem(TOKEN_KEY);
  } catch (error) {
    console.warn('OpenVideo Studio: token storage unavailable', error);
    cachedToken = null;
  }
  return cachedToken;
}

/** Bearer-Header, wenn der Server ein Token verlangt (`OPENVIDEO_API_TOKEN`). */
function authHeaders(): Record<string, string> {
  const token = apiToken();
  return token !== null && token !== '' ? { authorization: `Bearer ${token}` } : {};
}

/**
 * `true`, wenn Dateien ein Token brauchen. Dann lädt das Studio sie per `fetch` statt über `src`/`href`.
 *
 * @example
 * ```ts
 * if (needsAuthFetch()) await downloadWithAuth(url);
 * ```
 */
export function needsAuthFetch(): boolean {
  const token = apiToken();
  return token !== null && token !== '';
}

/**
 * Ruft eine Operation auf und liefert das Ergebnisobjekt.
 *
 * @example
 * ```ts
 * const comp = await call('composition.get', { projectId: 'demo' });
 * ```
 */
export async function call(operation: string, input: Readonly<Rec>): Promise<Rec> {
  let response: Response;
  try {
    response = await fetch(`/v1/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new ApiError({
      code: 'OV_STUDIO_OFFLINE',
      severity: 'error',
      errorClass: 'ApiError',
      problem: `The Agent API is not reachable (${error instanceof Error ? error.message : String(error)}).`,
      suggestions: ['Start the server with `openvideo studio` or `openvideo serve`.'],
    });
  }
  const body: unknown = await response.json();
  const result = rec(body);
  if (!response.ok || 'error' in result) throw new ApiError(toDiagnostic(result['error'] ?? { problem: `HTTP ${String(response.status)}` }));
  return result;
}

/**
 * URL einer Projektdatei (`/v1/files/<projekt>/<pfad>`).
 *
 * @example
 * ```ts
 * fileUrl('demo', './assets/logo.png'); // '/v1/files/demo/assets/logo.png'
 * ```
 */
export function fileUrl(projectId: string, path: string): string {
  const clean = path.replace(/^\.\//u, '').replace(/^\/v1\/files\/[a-z0-9-]+\//u, '');
  return `/v1/files/${projectId}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Lädt eine Projektdatei als Bytes.
 *
 * @example
 * ```ts
 * const bytes = await fetchFile('demo', 'assets/voice.wav');
 * ```
 */
export async function fetchFile(projectId: string, path: string): Promise<ArrayBuffer> {
  const response = await fetch(fileUrl(projectId, path), { headers: authHeaders() });
  if (!response.ok) {
    throw new ApiError({ code: 'OV_FILE_NOT_FOUND', severity: 'error', errorClass: 'ApiError', problem: `File "${path}" could not be loaded (HTTP ${String(response.status)}).`, suggestions: ['Check the asset path in the project.'] });
  }
  return response.arrayBuffer();
}

/**
 * Lädt eine Projektdatei als Text.
 *
 * @example
 * ```ts
 * const json = await fetchText('demo', 'project.json');
 * ```
 */
export async function fetchText(projectId: string, path: string): Promise<string> {
  return new TextDecoder().decode(await fetchFile(projectId, path));
}

/**
 * Formatiert einen Fehler für die Statuszeile.
 *
 * @example
 * ```ts
 * errorText(new Error('x')); // 'x'
 * ```
 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.diagnostic.code}: ${error.diagnostic.problem}${error.diagnostic.suggestions[0] !== undefined ? ` ${error.diagnostic.suggestions[0]}` : ''}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lädt eine Datei mit Token und liefert eine Blob-URL (für `<img src>`).
 * Der Aufrufer gibt die URL mit `URL.revokeObjectURL` frei.
 *
 * @example
 * ```ts
 * const url = await fileObjectUrl('demo', 'assets/logo.png');
 * ```
 */
export async function fileObjectUrl(projectId: string, path: string): Promise<string> {
  return URL.createObjectURL(new Blob([await fetchFile(projectId, path)]));
}

/**
 * Lädt eine URL mit Token herunter und speichert sie unter ihrem Dateinamen.
 *
 * @example
 * ```ts
 * await downloadWithAuth('/v1/files/demo/out/hero.mp4');
 * ```
 */
export async function downloadWithAuth(url: string): Promise<void> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new ApiError({ code: 'OV_FILE_NOT_FOUND', severity: 'error', errorClass: 'ApiError', problem: `Download failed (HTTP ${String(response.status)}).`, suggestions: ['Check that the render job succeeded.'] });
  const objectUrl = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = url.split('/').pop() ?? 'download';
  a.click();
  URL.revokeObjectURL(objectUrl);
}
