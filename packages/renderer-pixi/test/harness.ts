/**
 * Test-Harness für Browser-Renderer: bündelt einen Test-Einstieg mit esbuild, liefert ihn über
 * eine lokale HTTP-Origin aus (nötig für WebGPU) und rendert in Chromium mit SwiftShader.
 * Pixel kommen über `getImageData` zurück nach Node. Golden Images sind PNG (nicht vormultipliziert).
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Chromium-Flags für GPU-lose Rechner (siehe agent-rules). */
export const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'];

/** Bündelt einen Browser-Einstieg; Workspace-Pakete kommen aus ihren Quellen. */
export async function bundle(entry: string): Promise<string> {
  const alias: Record<string, string> = {};
  for (const name of ['core', 'schema', 'timeline', 'renderer-three', 'renderer-pixi']) alias[`@agentic-video/${name}`] = join(ROOT, 'packages', name, 'src', 'index.ts');
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', write: false, alias, logLevel: 'silent', target: 'es2022' });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return out.text;
}

/** Statischer HTTP-Server auf 127.0.0.1 mit zufälligem Port. */
export async function serve(files: Record<string, { body: string | Uint8Array; type: string }>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const file = files[path === '/' ? '/index.html' : path];
    if (file === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', file.type);
    res.end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: () => new Promise<void>((resolve) => server.close(() => { resolve(); })),
  };
}

/** Startet einen frischen Chromium und öffnet die Test-Seite. */
export async function openPage(url: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => 'ovReady' in window, undefined, { timeout: 30_000 }).catch((e: unknown) => {
    throw new Error(`test page did not start: ${errors.join('\n')} ${String(e)}`);
  });
  return { browser, page };
}

/** RGBA-Bild, nicht vormultipliziert (wie `getImageData`). */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Dekodiert die Rückgabe der Test-Seite (`{ width, height, data: base64 }`). */
export function fromPage(value: { width: number; height: number; data: string }): Rgba {
  return { width: value.width, height: value.height, data: new Uint8Array(Buffer.from(value.data, 'base64')) };
}

/** SHA-256 der Pixel. */
export function hashImage(img: Rgba): string {
  return createHash('sha256').update(img.data).digest('hex');
}

// ---------------------------------------------------------------------------
// Minimaler PNG-Kodierer/-Dekodierer (8 Bit RGBA, Filter 0) für Golden Images
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Kodiert ein RGBA-Bild als PNG. */
export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width * 4, img.width * 4).copy(raw, y * (img.width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

/** Dekodiert ein PNG, das {@link encodePng} geschrieben hat. */
export function decodePng(bytes: Buffer): Rgba {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width * 4 + 1)] !== 0) throw new Error('unsupported PNG filter');
    out.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, data: out };
}

/**
 * Vergleicht ein Bild mit seinem Golden Image. Mit `UPDATE_GOLDENS=1` wird das Golden geschrieben.
 * Toleranz: Ein Pixel gilt als abweichend, wenn ein Kanal um mehr als 8 abweicht; höchstens 0,5 % abweichende Pixel.
 */
export function matchGolden(dir: string, name: string, img: Rgba): { ok: boolean; message: string } {
  const file = join(dir, `${name}.png`);
  if (process.env['UPDATE_GOLDENS'] === '1' || !existsSync(file)) {
    if (process.env['UPDATE_GOLDENS'] !== '1') return { ok: false, message: `golden ${file} is missing; run with UPDATE_GOLDENS=1` };
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, encodePng(img));
    return { ok: true, message: 'written' };
  }
  const golden = decodePng(readFileSync(file));
  if (golden.width !== img.width || golden.height !== img.height) return { ok: false, message: `size ${String(img.width)}x${String(img.height)} != golden ${String(golden.width)}x${String(golden.height)}` };
  let diff = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs((img.data[i + c] ?? 0) - (golden.data[i + c] ?? 0)) > 8) {
        diff++;
        break;
      }
    }
  }
  const ratio = diff / (img.width * img.height);
  return { ok: ratio <= 0.005, message: `${String(diff)} differing pixels (${(ratio * 100).toFixed(2)} %)` };
}

/** Schreibt einen Kontaktbogen aller Bilder (für die visuelle Prüfung), Hintergrund Schachbrett. */
export function writeContactSheet(file: string, images: readonly { name: string; img: Rgba }[], columns = 6): void {
  if (images.length === 0) return;
  const cw = Math.max(...images.map((i) => i.img.width));
  const ch = Math.max(...images.map((i) => i.img.height));
  const rows = Math.ceil(images.length / columns);
  const w = cw * columns;
  const h = ch * rows;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 200 : 150;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  images.forEach(({ img }, k) => {
    const ox = (k % columns) * cw;
    const oy = Math.floor(k / columns) * ch;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        const d = ((oy + y) * w + ox + x) * 4;
        const a = (img.data[s + 3] ?? 0) / 255;
        for (let c = 0; c < 3; c++) data[d + c] = Math.round((img.data[s + c] ?? 0) * a + (data[d + c] ?? 0) * (1 - a));
      }
    }
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng({ width: w, height: h, data }));
}
