/**
 * Lokaler HTTP-Server des Render-Hosts (ADR 0013).
 *
 * - Bindet nur an `127.0.0.1` mit zufälligem Port.
 * - Jede Anfrage braucht ein zufälliges Token im Header {@link TOKEN_HEADER}. Der Host setzt
 *   den Header im Route-Handler des Browsers (D2). So steht das Token weder in `location`
 *   noch in `baseURI` der Seite; Skripte in Layer-Dokumenten können es nicht lesen.
 *   Andere Prozesse auf demselben Rechner kennen das Token nicht und bekommen 404.
 * - Frame-Uploads haben zufällige IDs (`crypto.randomUUID`), damit Layer-Skripte keinen
 *   erwarteten Upload erraten und überschreiben können.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { OpenVideoError, type AssetResolver, type FontResolver } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';

/** Laufender Host-Server. */
export interface HostServer {
  /** z. B. `http://127.0.0.1:41234` */
  readonly origin: string;
  /** Header mit dem Zugangs-Token; der Host hängt ihn an jede Anfrage der Seite an. */
  readonly headers: Readonly<Record<string, string>>;
  /** Erwartet einen Pixel-Upload `POST /frame/<zufällige id>` mit genau `byteLength` Bytes. */
  expectFrame(byteLength: number): { readonly url: string; readonly bytes: Promise<Uint8Array>; cancel(reason: unknown): void };
  close(): Promise<void>;
}

/** Eingaben des Servers. */
export interface HostServerOptions {
  readonly runtimeJs: string;
  readonly assets: AssetResolver;
  readonly fonts: FontResolver;
}

/** Name des Headers mit dem Zugangs-Token. */
export const TOKEN_HEADER = 'x-openvideo-token';

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.obj': 'model/obj',
  '.hdr': 'image/vnd.radiance',
  '.exr': 'image/x-exr',
  '.cube': 'text/plain',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

/**
 * MIME-Typ nach Dateiendung; unbekannt → `application/octet-stream`.
 *
 * @example
 * ```ts
 * mimeType('logo.png'); // 'image/png'
 * ```
 */
export function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function cssString(value: string): string {
  return `"${value.replace(/["\\\n\r]/gu, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

/**
 * `@font-face`-Regeln für alle Schriften des Resolvers; Dateien liegen unter `fonts/<hash>`.
 *
 * @example
 * ```ts
 * fontFaceCss(fonts); // '@font-face{font-family:"Inter";src:url("fonts/ab12");…}'
 * ```
 */
export function fontFaceCss(fonts: FontResolver): string {
  return fonts
    .all()
    .map((face) => {
      const weight = typeof face.weight === 'number' ? String(face.weight) : `${String(face.weight[0])} ${String(face.weight[1])}`;
      return `@font-face{font-family:${cssString(face.family)};src:url(${cssString(`fonts/${encodeURIComponent(face.hash)}`)});font-weight:${weight};font-style:${face.style};font-display:block;}`;
    })
    .join('\n');
}

const INDEX_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<link rel="stylesheet" href="fonts.css">',
  '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}</style>',
  '<script src="runtime.js"></script>',
  '</head><body></body></html>',
].join('');

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!(chunk instanceof Buffer)) continue;
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

interface PendingFrame {
  readonly byteLength: number;
  resolve(bytes: Uint8Array): void;
  reject(reason: unknown): void;
}

/**
 * Startet den Server auf `127.0.0.1` mit zufälligem Port und Pfad-Token.
 *
 * @example
 * ```ts
 * const server = await startHostServer({ runtimeJs, assets, fonts });
 * await context.route('**' + '/*', (route) => route.continue({ headers: { ...route.request().headers(), ...server.headers } }));
 * await page.goto(`${server.origin}/index.html`);
 * ```
 */
export async function startHostServer(options: HostServerOptions): Promise<HostServer> {
  const token = Buffer.from(randomBytes(16).toString('hex'));
  const fontsByHash = new Map(options.fonts.all().map((f) => [f.hash, f]));
  const fontCss = fontFaceCss(options.fonts);
  const pending = new Map<string, PendingFrame>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const given = req.headers[TOKEN_HEADER];
    const presented = Buffer.from(typeof given === 'string' ? given : '');
    if (presented.length !== token.length || !timingSafeEqual(presented, token)) {
      send(res, 404, 'text/plain', 'Not found');
      return;
    }
    const parts = url.pathname.slice(1).split('/').map((p) => decodeURIComponent(p));
    const [route, a, b] = parts;
    if (req.method === 'POST' && route === 'frame' && a !== undefined && parts.length === 2) {
      const wait = pending.get(a);
      if (wait === undefined) {
        send(res, 404, 'text/plain', 'Unknown frame');
        return;
      }
      const body = await readBody(req, wait.byteLength);
      if (body?.length !== wait.byteLength) {
        send(res, 413, 'text/plain', 'Wrong frame size');
        pending.delete(a);
        wait.reject(new Error(`Frame upload had the wrong size (expected ${String(wait.byteLength)} bytes).`));
        return;
      }
      pending.delete(a);
      wait.resolve(body);
      send(res, 204, 'text/plain', '');
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, 'text/plain', 'Method not allowed');
      return;
    }
    if (route === 'index.html' && parts.length === 1) {
      send(res, 200, 'text/html; charset=utf-8', INDEX_HTML);
      return;
    }
    if (route === 'runtime.js' && parts.length === 1) {
      send(res, 200, 'text/javascript; charset=utf-8', options.runtimeJs);
      return;
    }
    if (route === 'fonts.css' && parts.length === 1) {
      send(res, 200, 'text/css; charset=utf-8', fontCss);
      return;
    }
    if (route === 'fonts' && a !== undefined && parts.length === 2) {
      const face = fontsByHash.get(a);
      if (face === undefined) send(res, 404, 'text/plain', 'Unknown font');
      else send(res, 200, mimeType(face.path), face.bytes);
      return;
    }
    if (route === 'assets' && a !== undefined && parts.length === 2) {
      const record = options.assets.get(a);
      if (record === undefined) send(res, 404, 'text/plain', 'Unknown asset');
      else send(res, 200, mimeType(record.path), await options.assets.bytes(a));
      return;
    }
    if (route === 'video' && a !== undefined && b !== undefined && parts.length === 3) {
      const seconds = Number(b);
      if (options.assets.get(a) === undefined || !Number.isFinite(seconds)) send(res, 404, 'text/plain', 'Unknown video frame');
      else send(res, 200, 'image/png', encodePng(await options.assets.videoFrame(a, seconds), { level: 1 }));
      return;
    }
    send(res, 404, 'text/plain', 'Not found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, 'text/plain', error instanceof Error ? error.message : String(error));
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new OpenVideoError({ code: 'OV_BROWSER_SERVER', errorClass: 'BrowserRendererError', problem: 'The render host HTTP server has no TCP address.', suggestions: ['Check that the process may open local TCP ports on 127.0.0.1.'] });
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    origin,
    headers: { [TOKEN_HEADER]: token.toString() },
    expectFrame(byteLength) {
      const id = randomUUID();
      let resolve: (bytes: Uint8Array) => void = () => undefined;
      let reject: (reason: unknown) => void = () => undefined;
      const bytes = new Promise<Uint8Array>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.set(id, { byteLength, resolve, reject });
      return {
        url: `/frame/${id}`,
        bytes,
        cancel(reason) {
          if (pending.delete(id)) reject(reason);
        },
      };
    },
    close() {
      for (const wait of pending.values()) wait.reject(new Error('Render host closed.'));
      pending.clear();
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
