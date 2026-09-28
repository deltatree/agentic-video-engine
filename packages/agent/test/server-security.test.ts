import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Type from 'typebox';
import { OpenVideoError } from '@agentic-video/core';
import { defineOperation, startAgentServer, type AgentServer, type AgentServices } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** HTTP-Anfrage mit frei wählbaren Kopfzeilen (fetch verbietet `Host`). */
function raw(url: string, method: string, path: string, headers: Readonly<Record<string, string>>, body?: string): Promise<RawResponse> {
  const target = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: target.hostname.replace(/^\[|\]$/gu, ''), port: target.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const TOKEN = 'sec-token';
let root: string;
let services: AgentServices;
let server: AgentServer;
let host: string;
let projectId: string;

const leaky = defineOperation({
  name: 'test.leak',
  summary: 'Throws an internal error with a host path.',
  input: Type.Object({}, { additionalProperties: false }),
  output: Type.Object({}),
  example: { input: {} },
  handler: () => Promise.reject(new Error(`ENOENT: no such file or directory, open '${root}/secret/file.json'`)),
});

async function post(op: string, body: unknown, headers: Readonly<Record<string, string>> = {}): Promise<RawResponse> {
  return raw(server.url, 'POST', `/v1/${op}`, { host, 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers }, JSON.stringify(body));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ov-sec-'));
  services = testServices(root);
  server = await startAgentServer({ services, port: 0, token: TOKEN, allowedHosts: ['studio.example'], extraOperations: new Map([[leaky.name, leaky]]) });
  host = new URL(server.url).host;
  const created = await post('project.create', { name: 'Sec', project: smallProject([{ id: 'box', type: 'rect', width: 10, height: 10, fill: '#FF0000' }]) });
  projectId = (JSON.parse(created.body) as { projectId: string }).projectId;
});

afterAll(async () => {
  await server.close();
});

describe('B1: CSRF und DNS-Rebinding', () => {
  it('lehnt POST ohne content-type application/json ab', async () => {
    const r = await post('project.inspect', {}, { 'content-type': 'text/plain' });
    expect(r.status).toBe(415);
    expect(r.body).toContain('OV_API_CONTENT_TYPE');
  });

  it('lehnt fremde Host-Header ab (DNS-Rebinding)', async () => {
    const r = await post('project.inspect', {}, { host: `evil.example:${new URL(server.url).port}` });
    expect(r.status).toBe(403);
    expect(r.body).toContain('OV_API_HOST');
  });

  it('erlaubt localhost, die Bind-Adresse und konfigurierte Namen', async () => {
    const port = new URL(server.url).port;
    for (const h of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `studio.example:${port}`, 'studio.example']) {
      expect((await post('project.inspect', {}, { host: h })).status, h).toBe(200);
    }
  });

  it('lehnt einen fremden Origin ab und erlaubt die eigene Origin', async () => {
    const bad = await post('project.inspect', {}, { origin: 'http://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.body).toContain('OV_API_ORIGIN');
    expect((await post('project.inspect', {}, { origin: `http://${host}` })).status).toBe(200);
  });
});

describe('B2 und B13: Bind-Adresse, URL und Fehler nach listen', () => {
  it('bricht ohne Token auf einer Nicht-Loopback-Adresse mit Diagnose ab', async () => {
    const attempt = startAgentServer({ services, port: 0, host: '0.0.0.0' });
    await expect(attempt).rejects.toBeInstanceOf(OpenVideoError);
    await expect(attempt).rejects.toMatchObject({ diagnostic: { code: 'OV_API_TOKEN_REQUIRED' } });
  });

  it('meldet für 0.0.0.0 eine erreichbare URL', async () => {
    const s = await startAgentServer({ services, port: 0, host: '0.0.0.0', token: TOKEN });
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    } finally {
      await s.close();
    }
  });

  it('setzt IPv6-Adressen in eckige Klammern', async () => {
    const s = await startAgentServer({ services, port: 0, host: '::1' });
    try {
      expect(s.url).toMatch(/^http:\/\/\[::1\]:\d+$/u);
      const r = await fetch(`${s.url}/v1/health`);
      expect(r.status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('stürzt bei einem Server-Fehler nach listen nicht ab', () => {
    expect(() => server.server.emit('error', new Error('late failure'))).not.toThrow();
  });
});

describe('B3: /v1/files', () => {
  const fileHeaders = (): Record<string, string> => ({ host, authorization: `Bearer ${TOKEN}` });

  it('liefert Sicherheitskopfzeilen und SVG als Anhang', async () => {
    writeFileSync(join(services.workspace.projectDir(projectId), 'assets', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await raw(server.url, 'GET', `/v1/files/${projectId}/assets/x.svg`, fileHeaders());
    expect(r.status).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment/u);
  });

  it('liefert unbekannte Typen als Anhang, PNG inline', async () => {
    const dir = services.workspace.projectDir(projectId);
    writeFileSync(join(dir, 'assets', 'page.html'), '<script>alert(1)</script>');
    writeFileSync(join(dir, 'assets', 'p.png'), new Uint8Array([137, 80, 78, 71]));
    const html = await raw(server.url, 'GET', `/v1/files/${projectId}/assets/page.html`, fileHeaders());
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(String(html.headers['content-disposition'])).toMatch(/^attachment/u);
    const png = await raw(server.url, 'GET', `/v1/files/${projectId}/assets/p.png`, fileHeaders());
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toBeUndefined();
  });

  it('verhindert Ausbrüche mit ..%2f', async () => {
    const r = await raw(server.url, 'GET', `/v1/files/${projectId}/..%2f..%2f..%2fjobs`, fileHeaders());
    expect(r.status).toBe(404);
    const r2 = await raw(server.url, 'GET', `/v1/files/${projectId}/assets%2f..%2f..%2f..%2f..%2fetc%2fpasswd`, fileHeaders());
    expect(r2.status).toBe(404);
    expect(r2.body).not.toContain('root:');
  });

  it('folgt keinem Symlink aus dem Projekt heraus', async () => {
    const outside = join(root, 'outside-secret.txt');
    writeFileSync(outside, 'TOP SECRET');
    symlinkSync(outside, join(services.workspace.projectDir(projectId), 'assets', 'link.txt'));
    const r = await raw(server.url, 'GET', `/v1/files/${projectId}/assets/link.txt`, fileHeaders());
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('TOP SECRET');
  });

  it('verrät in Fehlern keine Host-Pfade', async () => {
    const r = await raw(server.url, 'GET', `/v1/files/${projectId}/assets/missing.png`, fileHeaders());
    expect(r.status).toBe(404);
    expect(r.body).not.toContain(root);
  });
});

describe('B17 und B18: Health ohne Token, keine Pfade in internen Fehlern', () => {
  it('beantwortet /v1/health ohne Token', async () => {
    const r = await raw(server.url, 'GET', '/v1/health', { host });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });

  it('gibt bei OV_INTERNAL keine Host-Pfade preis', async () => {
    const r = await post('test.leak', {});
    expect(r.status).toBe(500);
    expect(r.body).toContain('OV_INTERNAL');
    expect(r.body).not.toContain(root);
  });

  it('gibt in fehlgeschlagenen Jobs keine Host-Pfade preis', async () => {
    const id = services.jobs.start('test', projectId, () => Promise.reject(new Error(`EACCES: permission denied, open '${root}/x'`)));
    const info = await services.jobs.wait(id);
    expect(info.state).toBe('failed');
    expect(JSON.stringify(info.error)).not.toContain(root);
  });
});
