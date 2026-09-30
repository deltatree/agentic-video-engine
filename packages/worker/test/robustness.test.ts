/**
 * Robustheit von Koordinator und Worker (Story 22.5, Audit P1-7): falsches Token, Body-Limit,
 * Pfad-Traversal in Projektdateien und kaputte stdio-Rahmen.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { FileStore } from '@agentic-video/cache';
import { SCHEMA_VERSION, isOpenVideoError } from '@agentic-video/core';
import { MessageDecoder, encodeMessage, startCoordinator, type Coordinator, type ProtocolMessage } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { runWorkerHttp, runWorkerStdio, writeTempProject } from '@agentic-video/worker';

const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [{ id: 'main', width: 32, height: 18, fps: 30, duration: 3, background: '#101418', nodes: [] }],
};
const chunk = { compositionId: 'main', start: 0, end: 1, scale: 1, step: 1, offset: 0 };
const TOKEN = 'robustness-token-0123456789abcdef';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function coordinatorWith(options: { token?: string; maxBodyBytes?: number } = {}): Promise<{ coordinator: Coordinator; store: FileStore }> {
  const dir = tmp('ov-robust-');
  const store = new FileStore(join(dir, 'shared'));
  const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), leaseSeconds: 10, ...options });
  return { coordinator, store };
}

function post(c: Coordinator, path: string, body: string, token?: string): Promise<Response> {
  return fetch(`${c.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) }, body });
}

async function codeOf(res: Response): Promise<string> {
  const body: unknown = await res.json();
  const text = JSON.stringify(body);
  return /"code":"(OV_[A-Z_]+)"/u.exec(text)?.[1] ?? text;
}

describe('Koordinator und HTTP-Worker: falsches Token', () => {
  it('ein Worker mit falschem Token bekommt keine Lease; der Job bleibt in der Warteschlange', async () => {
    const { coordinator, store } = await coordinatorWith({ token: TOKEN });
    const logs: string[] = [];
    const stop = new AbortController();
    try {
      const submitted = await post(coordinator, '/v1/jobs', JSON.stringify({ project, files: [], chunks: [chunk] }), TOKEN);
      expect(submitted.status).toBe(201);
      expect((await post(coordinator, '/v1/lease', JSON.stringify({ worker: 'x' }), 'wrong-token-0123456789abcdef')).status).toBe(401);
      expect((await post(coordinator, '/v1/lease', JSON.stringify({ worker: 'x' }))).status).toBe(401);
      const worker = runWorkerHttp({
        coordinatorUrl: coordinator.url,
        token: 'wrong-token-0123456789abcdef',
        store,
        worker: 'intruder',
        signal: stop.signal,
        pollIntervalMs: 20,
        telemetry: createTelemetry({ serviceName: 'test', exporter: 'none', logSink: (l) => logs.push(l) }),
      });
      await expect.poll(() => logs.filter((l) => l.includes('lease request failed') && l.includes('401')).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      stop.abort();
      expect(await worker).toEqual({ completed: 0, failed: 0, released: 0, rejected: 0 });
      const queue = await (await fetch(`${coordinator.url}/v1/queue`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      expect(queue).toMatchObject({ queueLength: 1, leasesActive: 0 });
    } finally {
      stop.abort();
      await coordinator.close();
    }
  });
});

describe('Koordinator: Body-Limit', () => {
  it('lehnt zu große Lease-, Complete- und Job-Anfragen mit 413 ab und bleibt danach erreichbar', async () => {
    const { coordinator } = await coordinatorWith({ maxBodyBytes: 256 });
    try {
      const pad = 'x'.repeat(1024);
      for (const path of ['/v1/lease', '/v1/complete', '/v1/fail', '/v1/jobs']) {
        const res = await post(coordinator, path, JSON.stringify({ worker: 'w', pad }));
        expect(res.status).toBe(413);
        expect(await codeOf(res)).toBe('OV_COORDINATOR_TOO_LARGE');
      }
      // Kaputtes JSON unter dem Limit ist 400, keine Ausnahme im Server.
      const broken = await post(coordinator, '/v1/lease', '{ "worker": ');
      expect(broken.status).toBe(400);
      expect((await post(coordinator, '/v1/lease', JSON.stringify({ worker: 'w' }))).status).toBe(204);
    } finally {
      await coordinator.close();
    }
  });
});

describe('Pfad-Traversal in Projektdateien', () => {
  it('der Koordinator lehnt Dateien mit "..", absoluten Pfaden und Backslashes ab', async () => {
    const { coordinator } = await coordinatorWith();
    try {
      for (const path of ['../evil.txt', 'assets/../../evil.txt', '/etc/passwd', '..\\evil.txt', '']) {
        const res = await post(coordinator, '/v1/jobs', JSON.stringify({ project, files: [{ path, data: Buffer.from('x').toString('base64') }], chunks: [chunk] }));
        expect(res.status, path).toBe(400);
        expect(await codeOf(res)).toMatch(/^OV_COORDINATOR_/u);
      }
    } finally {
      await coordinator.close();
    }
  });

  it('writeTempProject schreibt nichts außerhalb des Projektordners und räumt auf', async () => {
    const marker = `ov-traversal-${String(process.pid)}.txt`;
    let caught: unknown;
    try {
      await writeTempProject([
        { path: 'assets/ok.txt', bytes: new TextEncoder().encode('ok') },
        { path: `../${marker}`, bytes: new TextEncoder().encode('evil') },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(isOpenVideoError(caught) ? caught.diagnostic.code : caught).toBe('OV_WORKER_UNSAFE_PATH');
    expect(existsSync(join(tmpdir(), marker))).toBe(false);
  });
});

/** Startet einen stdio-Worker auf Speicher-Streams und sammelt seine Antworten. */
function stdioWorker(): { input: PassThrough; messages: ProtocolMessage[]; done: Promise<unknown> } {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new MessageDecoder();
  const messages: ProtocolMessage[] = [];
  output.on('data', (data: Buffer) => {
    messages.push(...decoder.push(data));
  });
  const done = runWorkerStdio({ input, output }).then(
    () => 'ok',
    (error: unknown) => error,
  );
  return { input, messages, done };
}

function frame(header: string): Uint8Array {
  const body = new TextEncoder().encode(header);
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

function codeFrom(value: unknown): string {
  return isOpenVideoError(value) ? value.diagnostic.code : String(value);
}

describe('stdio-Worker: kaputte Rahmen', () => {
  it('ein zu großer Rahmen-Kopf beendet den Worker mit OV_WORKER_PROTOCOL', async () => {
    const w = stdioWorker();
    const huge = new Uint8Array(4);
    new DataView(huge.buffer).setUint32(0, 0xffffffff, false);
    w.input.write(huge);
    expect(codeFrom(await w.done)).toBe('OV_WORKER_PROTOCOL');
  });

  it('ein Kopf, der kein JSON-Objekt ist, beendet den Worker mit OV_WORKER_PROTOCOL', async () => {
    const w = stdioWorker();
    w.input.write(frame('[1,2,3]'));
    expect(codeFrom(await w.done)).toBe('OV_WORKER_PROTOCOL');
  });

  it('ein unbekannter Nachrichtentyp beendet den Worker mit OV_WORKER_PROTOCOL', async () => {
    const w = stdioWorker();
    w.input.write(frame('{"type":"format-disk"}'));
    expect(codeFrom(await w.done)).toBe('OV_WORKER_PROTOCOL');
  });

  it('ungültiges JSON im Kopf beendet den Worker mit OV_WORKER_PROTOCOL statt rohem SyntaxError', async () => {
    const w = stdioWorker();
    w.input.write(frame('{ not json'));
    const done = await w.done;
    expect(codeFrom(done)).toBe('OV_WORKER_PROTOCOL');
    expect(isOpenVideoError(done) ? done.diagnostic.problem : '').toMatch(/cannot decode/u);
    // Der Koordinator erfährt den Grund auch über den Ausgabestrom.
    await expect.poll(() => w.messages.find((m) => m.type === 'error')).toBeDefined();
    const reported = w.messages.find((m) => m.type === 'error');
    expect(reported?.type === 'error' ? reported.diagnostic.code : '').toBe('OV_WORKER_PROTOCOL');
  });

  it('ein abgeschnittener Rahmen am Eingabeende beendet den Worker ohne Antwort', async () => {
    const w = stdioWorker();
    const partial = frame('{"type":"shutdown"}').slice(0, 7);
    w.input.end(partial);
    expect(await w.done).toBe('ok');
    expect(w.messages).toEqual([]);
  });

  it('chunk vor init und ein zweites init werden als Fehler gemeldet; der Worker läuft weiter', async () => {
    const w = stdioWorker();
    w.input.write(encodeMessage({ type: 'chunk', id: 'c1', request: chunk }));
    await expect.poll(() => w.messages.find((m) => m.type === 'error')).toBeDefined();
    const first = w.messages.find((m) => m.type === 'error');
    expect(first?.type === 'error' ? [first.id, first.diagnostic.code] : []).toEqual(['c1', 'OV_WORKER_PROTOCOL']);
    const dir = tmp('ov-robust-stdio-');
    const init = encodeMessage({ type: 'init', mode: 'shared', worker: 'w', project, projectDir: dir, cacheDir: join(dir, 'cache'), options: {} });
    w.input.write(init);
    w.input.write(init);
    await expect.poll(() => w.messages.filter((m) => m.type === 'error').length, { timeout: 30_000 }).toBe(2);
    const second = w.messages.filter((m) => m.type === 'error')[1];
    expect(second?.type === 'error' ? second.diagnostic.problem : '').toMatch(/second init/u);
    w.input.end(encodeMessage({ type: 'shutdown' }));
    expect(await w.done).toBe('ok');
  });

  it('Stream-Modus: init mit Traversal-Pfad meldet OV_WORKER_UNSAFE_PATH und endet mit Fehler', async () => {
    const w = stdioWorker();
    w.input.write(encodeMessage({ type: 'init', mode: 'stream', worker: 'w', project, files: [{ path: '../escape.txt', bytes: new TextEncoder().encode('x') }], options: {} }));
    expect(codeFrom(await w.done)).toBe('OV_WORKER_UNSAFE_PATH');
    expect(w.messages.some((m) => m.type === 'error' && m.diagnostic.code === 'OV_WORKER_UNSAFE_PATH')).toBe(true);
  });
});
