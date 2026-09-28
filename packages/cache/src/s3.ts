/**
 * S3-kompatibler Speicher (AWS S3, MinIO) mit AWS Signature Version 4.
 * Eigene kleine Implementierung statt AWS-SDK: wenige Operationen, keine schwere Abhängigkeit.
 */
import { createHash, createHmac } from 'node:crypto';
import { OpenVideoError } from '@agentic-video/core';
import { assertSafeKey, type ContentStore, type StoreEntry } from './store.js';

/** Zugangsdaten und Ziel eines S3-kompatiblen Speichers. */
export interface S3Options {
  /** Basis-URL, z. B. `http://minio:9000` oder `https://s3.eu-central-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Präfix für alle Schlüssel, z. B. `openvideo/`. */
  readonly prefix?: string;
  /** Timeout je Anfrage in Millisekunden (Standard 30 000). */
  readonly timeoutMs?: number;
  /** Größtes Objekt, das `get` liest, in Bytes (Standard 2 GiB). Größere Antworten brechen ab. */
  readonly maxObjectBytes?: number;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Dekodiert die XML-Entities in einem Textknoten (benannt und numerisch).
 *
 * @example
 * ```ts
 * decodeXmlText('a&amp;b&#x3D;'); // 'a&b='
 * ```
 */
export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/gu, (all, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? all;
  });
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

/** Zeitstempel im SigV4-Format. Die Signatur braucht die echte Uhrzeit (kein Render-Pfad). */
function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[-:]/gu, '').replace(/\.[0-9]{3}/u, '');
  return { date: iso.slice(0, 8), stamp: iso };
}

/**
 * Signiert eine Anfrage nach AWS SigV4 (Pfad-Stil).
 *
 * @example
 * ```ts
 * const headers = signV4({ method: 'GET', url: new URL('http://minio:9000/bucket/key'), region: 'us-east-1', accessKeyId, secretAccessKey, body: new Uint8Array(), now: new Date() });
 * ```
 */
export function signV4(input: {
  readonly method: string;
  readonly url: URL;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly body: Uint8Array;
  readonly now: Date;
  readonly service?: string;
}): Record<string, string> {
  const service = input.service ?? 's3';
  const { date, stamp } = amzDate(input.now);
  const payloadHash = sha256Hex(input.body);
  const query = [...input.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const headers: Record<string, string> = { host: input.url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k] ?? ''}\n`)
    .join('');
  const canonicalRequest = [input.method, input.url.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * S3-kompatibler Inhaltsspeicher (Pfad-Stil-Adressierung, funktioniert mit MinIO).
 *
 * @example
 * ```ts
 * const store = new S3Store({ endpoint: 'http://minio:9000', bucket: 'openvideo', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' });
 * ```
 */
export class S3Store implements ContentStore {
  readonly name: string;

  constructor(private readonly options: S3Options) {
    this.name = `s3://${options.bucket}/${options.prefix ?? ''}`;
  }

  private url(key: string, query: Record<string, string> = {}): URL {
    const url = new URL(`${this.options.endpoint.replace(/\/$/u, '')}/${encodePath(this.options.bucket)}${key === '' ? '' : `/${encodePath(`${this.options.prefix ?? ''}${key}`)}`}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private async request(method: string, url: URL, body: Uint8Array = new Uint8Array()): Promise<Response> {
    const headers = signV4({ method, url, region: this.options.region, accessKeyId: this.options.accessKeyId, secretAccessKey: this.options.secretAccessKey, body, now: new Date() });
    try {
      return await fetch(url, { method, headers, ...(method === 'PUT' ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) });
    } catch (error) {
      throw new OpenVideoError({
        code: 'OV_CACHE_REMOTE',
        errorClass: 'CacheError',
        problem: `S3 request ${method} ${url.pathname} failed.`,
        details: { endpoint: this.options.endpoint, reason: error instanceof Error ? error.message : String(error) },
        suggestions: ['Check OPENVIDEO_S3_ENDPOINT and network access to the object store.'],
        cause: error,
      });
    }
  }

  private fail(action: string, key: string, res: Response): OpenVideoError {
    return new OpenVideoError({
      code: 'OV_CACHE_REMOTE',
      errorClass: 'CacheError',
      problem: `S3 ${action} of "${key}" failed with HTTP ${String(res.status)}.`,
      details: { endpoint: this.options.endpoint, bucket: this.options.bucket },
      suggestions: ['Check the bucket name and the access keys.', 'Make sure the bucket exists.'],
    });
  }

  async has(key: string): Promise<boolean> {
    assertSafeKey(key);
    const res = await this.request('HEAD', this.url(key));
    if (res.status === 404) return false;
    if (!res.ok) throw this.fail('HEAD', key, res);
    return true;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    assertSafeKey(key);
    const res = await this.request('GET', this.url(key));
    if (res.status === 404) return undefined;
    if (!res.ok) throw this.fail('GET', key, res);
    return this.#readLimited(key, res);
  }

  /** Liest den Body in Teilen und bricht ab, sobald er größer als erlaubt ist. */
  async #readLimited(key: string, res: Response): Promise<Uint8Array> {
    const max = this.options.maxObjectBytes ?? 2 * 1024 * 1024 * 1024;
    const tooLarge = () =>
      new OpenVideoError({
        code: 'OV_CACHE_TOO_LARGE',
        errorClass: 'CacheError',
        problem: `S3 object "${key}" is larger than ${String(max)} bytes.`,
        details: { endpoint: this.options.endpoint, bucket: this.options.bucket },
        suggestions: ['Raise maxObjectBytes if such large cache entries are expected.', 'Check that the key points to a cache entry.'],
      });
    if (Number(res.headers.get('content-length') ?? '0') > max) {
      await res.body?.cancel();
      throw tooLarge();
    }
    const reader = res.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      let part: Awaited<ReturnType<typeof reader.read>>;
      try {
        part = await reader.read();
      } catch (error) {
        throw new OpenVideoError({ code: 'OV_CACHE_REMOTE', errorClass: 'CacheError', problem: `Reading S3 object "${key}" failed.`, details: { reason: error instanceof Error ? error.message : String(error) }, suggestions: ['Check the network access to the object store.'], cause: error });
      }
      if (part.done) break;
      total += part.value.length;
      if (total > max) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(part.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertSafeKey(key);
    const res = await this.request('PUT', this.url(key), bytes);
    if (!res.ok) throw this.fail('PUT', key, res);
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const res = await this.request('DELETE', this.url(key));
    if (!res.ok && res.status !== 404) throw this.fail('DELETE', key, res);
  }

  async list(prefix = ''): Promise<StoreEntry[]> {
    const out: StoreEntry[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: `${this.options.prefix ?? ''}${prefix}` };
      if (token !== undefined) query['continuation-token'] = token;
      const res = await this.request('GET', this.url('', query));
      if (!res.ok) throw this.fail('LIST', prefix, res);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
        const body = m[1] ?? '';
        const key = decodeXmlText(/<Key>([^<]*)<\/Key>/u.exec(body)?.[1] ?? '');
        const size = Number(/<Size>([0-9]+)<\/Size>/u.exec(body)?.[1] ?? '0');
        const modified = Date.parse(/<LastModified>([^<]*)<\/LastModified>/u.exec(body)?.[1] ?? '');
        out.push({ key: key.slice((this.options.prefix ?? '').length), size, lastUsed: Number.isFinite(modified) ? modified : 0 });
      }
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u.exec(xml)?.[1];
      token = next === undefined ? undefined : decodeXmlText(next);
    } while (token !== undefined);
    return out;
  }
}
