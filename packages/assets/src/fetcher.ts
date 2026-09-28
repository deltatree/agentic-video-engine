/**
 * Kontrollierter Asset-Fetcher (FR-51, A24): lädt Remote-Assets vor jeder Code-Ausführung.
 * Blockiert interne Netze, Loopback und Cloud-Metadaten-Endpunkte; prüft jede Weiterleitung.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { OpenVideoError } from '@agentic-video/core';

/** Optionen für {@link fetchAsset}. */
export interface FetchOptions {
  /** Private Adressen erlauben (nur für Tests und bewusst lokale Quellen). */
  readonly allowPrivate?: boolean;
  readonly timeoutMs?: number;
  /** Maximale Größe in Bytes (Standard 512 MiB). */
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
}

function inRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : 0xffffffff << (32 - bits);
  return (ipv4ToInt(ip) & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
}

/**
 * Prüft, ob eine IP-Adresse privat, lokal oder ein Metadaten-Endpunkt ist.
 *
 * @example
 * ```ts
 * isBlockedAddress('169.254.169.254'); // true
 * isBlockedAddress('93.184.216.34');   // false
 * ```
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const ranges: [string, number][] = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return ranges.some(([base, bits]) => inRange(ip, base, bits));
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('ff')) return true;
  const mapped = /^::ffff:([0-9.]+)$/u.exec(v6);
  if (mapped?.[1] !== undefined) return isBlockedAddress(mapped[1]);
  return false;
}

function blocked(url: string, address: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FETCH_BLOCKED',
    errorClass: 'SecurityError',
    problem: `Fetching ${url} is blocked: it resolves to the internal address ${address}.`,
    suggestions: ['Download the file yourself and import it with asset.import.', 'Use a public URL.'],
  });
}

async function assertPublic(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OpenVideoError({ code: 'OV_FETCH_PROTOCOL', errorClass: 'SecurityError', problem: `Protocol ${url.protocol} is not allowed.`, suggestions: ['Use an http(s) URL.'] });
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addresses) if (isBlockedAddress(a)) throw blocked(url.toString(), a);
}

/**
 * Lädt eine Datei unter Sicherheitsregeln herunter.
 *
 * @example
 * ```ts
 * const { bytes, contentType } = await fetchAsset('https://example.com/logo.png');
 * ```
 */
export async function fetchAsset(url: string, options: FetchOptions = {}): Promise<{ readonly bytes: Uint8Array; readonly contentType: string | undefined; readonly finalUrl: string }> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  let current = new URL(url);
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    await assertPublic(current, options.allowPrivate === true);
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
    } catch (error) {
      throw new OpenVideoError({ code: 'OV_FETCH_FAILED', errorClass: 'AssetError', problem: `Could not fetch ${current.toString()}.`, details: { reason: error instanceof Error ? error.message : String(error) }, suggestions: ['Check the URL and your network connection.'], cause: error });
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location === null) break;
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new OpenVideoError({ code: 'OV_FETCH_FAILED', errorClass: 'AssetError', problem: `Fetching ${current.toString()} returned HTTP ${String(res.status)}.`, suggestions: ['Check the URL.'] });
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > maxBytes) throw new OpenVideoError({ code: 'OV_FETCH_TOO_LARGE', errorClass: 'AssetError', problem: `The file is ${String(length)} bytes, more than ${String(maxBytes)}.`, suggestions: ['Import a smaller file.'] });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new OpenVideoError({ code: 'OV_FETCH_TOO_LARGE', errorClass: 'AssetError', problem: `The file is larger than ${String(maxBytes)} bytes.`, suggestions: ['Import a smaller file.'] });
    return { bytes, contentType: res.headers.get('content-type') ?? undefined, finalUrl: current.toString() };
  }
  throw new OpenVideoError({ code: 'OV_FETCH_REDIRECTS', errorClass: 'AssetError', problem: `Too many redirects for ${url}.`, suggestions: ['Use the final URL directly.'] });
}
