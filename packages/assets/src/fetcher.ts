/**
 * Kontrollierter Asset-Fetcher (FR-51, A24): lädt Remote-Assets vor jeder Code-Ausführung.
 * Blockiert interne Netze, Loopback und Cloud-Metadaten-Endpunkte; prüft jede Weiterleitung.
 *
 * Die Adressprüfung passiert beim Verbindungsaufbau (eigene `lookup`-Funktion): geprüft wird
 * genau die Adresse, mit der verbunden wird. Das verhindert DNS-Rebinding zwischen Prüfung
 * und Verbindung.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { OpenVideoError } from '@agentic-video/core';

/** Eine aufgelöste Adresse. */
export interface ResolvedAddress {
  readonly address: string;
  /** 4 oder 6. */
  readonly family: number;
}

/** Löst einen Hostnamen in alle Adressen auf. */
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** Optionen für {@link fetchAsset}. */
export interface FetchOptions {
  /** Private Adressen erlauben (nur für Tests und bewusst lokale Quellen). */
  readonly allowPrivate?: boolean;
  readonly timeoutMs?: number;
  /** Maximale Größe in Bytes (Standard 512 MiB). */
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  /** Namensauflösung (Standard: System-DNS). Nur für Tests austauschen. */
  readonly resolve?: AddressResolver;
  /** Sperrregel für Adressen (Standard {@link isBlockedAddress}). Nur für Tests austauschen. */
  readonly isBlocked?: (address: string) => boolean;
}

/** IPv4-Sperrliste: [Basis, Präfixlänge]. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
}

function blockedV4(value: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
  });
}

/** Zerlegt eine IPv6-Adresse in 8 Gruppen zu 16 Bit (auch mit eingebetteter IPv4 am Ende). */
function parseIpv6(ip: string): number[] | undefined {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted !== null) {
    const v4 = dotted[1] ?? '';
    if (isIP(v4) !== 4) return undefined;
    const n = ipv4ToInt(v4);
    text = `${text.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string | undefined): number[] => (part === undefined || part === '' ? [] : part.split(':').map((p) => (/^[0-9a-f]{1,4}$/iu.test(p) ? Number.parseInt(p, 16) : Number.NaN)));
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  if ([...head, ...rest].some((v) => Number.isNaN(v))) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  if (head.length + rest.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

function embeddedV4(high: number, low: number): number {
  return high * 0x10000 + low;
}

/**
 * Prüft, ob eine IP-Adresse privat, lokal, reserviert oder ein Metadaten-Endpunkt ist.
 * IPv6-Formen mit eingebetteter IPv4-Adresse (mapped, kompatibel, NAT64, 6to4) werden in
 * IPv4 umgerechnet und gegen die IPv4-Sperrliste geprüft. Unlesbare Eingaben gelten als gesperrt.
 *
 * @example
 * ```ts
 * isBlockedAddress('169.254.169.254'); // true
 * isBlockedAddress('::ffff:7f00:1');   // true (IPv4-mapped 127.0.0.1)
 * isBlockedAddress('93.184.216.34');   // false
 * ```
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/%.*$/u, '');
  if (isIP(bare) === 4) return blockedV4(ipv4ToInt(bare));
  if (isIP(bare) !== 6) return true;
  const g = parseIpv6(bare.toLowerCase());
  if (g?.length !== 8) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const v4Tail = embeddedV4(g6, g7);
  const firstFourZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  // ::/96 (unspezifiziert, Loopback, IPv4-kompatibel) und ::ffff:0:0/96 (IPv4-mapped).
  if (firstFourZero && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return g5 === 0 && v4Tail <= 1 ? true : blockedV4(v4Tail);
  // ::ffff:0:0:0/96 (IPv4-übersetzt, RFC 2765).
  if (firstFourZero && g4 === 0xffff && g5 === 0) return blockedV4(v4Tail);
  // 64:ff9b::/96 (NAT64) → eingebettete IPv4; sonst 64:ff9b::/32 (u. a. lokales NAT64 64:ff9b:1::/48) → gesperrt.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? blockedV4(v4Tail) : true;
  // 2002::/16 (6to4): IPv4 in Bit 16–47.
  if (g0 === 0x2002) return blockedV4(embeddedV4(g1, g2));
  // 2001::/32 (Teredo, IPv4 verschleiert) und 2001:db8::/32 (Dokumentation).
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  // 100::/64 (Discard).
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (veraltet)
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
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

function failed(url: URL, error: unknown): OpenVideoError {
  if (error instanceof OpenVideoError) return error;
  return new OpenVideoError({ code: 'OV_FETCH_FAILED', errorClass: 'AssetError', problem: `Could not fetch ${url.toString()}.`, details: { reason: error instanceof Error ? error.message : String(error) }, suggestions: ['Check the URL and your network connection.'], cause: error });
}

const systemResolver: AddressResolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

/** Baut eine `lookup`-Funktion für `net.connect`, die jede aufgelöste Adresse prüft. */
function checkedLookup(url: URL, resolve: AddressResolver, isBlocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (all) => {
        const bad = all.find((a) => isBlocked(a.address));
        if (bad !== undefined) {
          callback(blocked(url.toString(), bad.address), '', 0);
          return;
        }
        const wanted = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
        const first = wanted[0];
        if (first === undefined) {
          callback(Object.assign(new Error(`No address found for ${hostname}.`), { code: 'ENOTFOUND' }), '', 0);
          return;
        }
        if (options.all === true) callback(null, wanted.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, first.address, first.family);
      },
      (error: unknown) => { callback(error instanceof Error ? error : new Error(String(error)), '', 0); },
    );
  };
}

function send(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    // Kein Agent: keine wiederverwendeten Verbindungen, jede Verbindung läuft durch `lookup`.
    const req = request(url, { method: 'GET', agent: false, lookup, signal, headers: { 'accept-encoding': 'identity' } }, resolve);
    req.on('error', reject);
    req.end();
  });
}

function incomplete(received: number, cause?: unknown): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FETCH_INCOMPLETE',
    errorClass: 'AssetError',
    problem: `The connection closed after ${String(received)} bytes, before the body was complete.`,
    details: { receivedBytes: received },
    ...(cause !== undefined ? { cause } : {}),
    suggestions: ['Retry the import; the server or network interrupted the download.', 'Download the file manually and import the local copy.'],
  });
}

function tooLarge(maxBytes: number, length?: number): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FETCH_TOO_LARGE',
    errorClass: 'AssetError',
    problem: length !== undefined ? `The file is ${String(length)} bytes, more than ${String(maxBytes)}.` : `The file is larger than ${String(maxBytes)} bytes.`,
    suggestions: ['Import a smaller file.'],
  });
}

/** Liest den Body in Teilen und bricht ab, sobald er größer als `maxBytes` ist. */
function readLimited(res: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (error: Error | undefined) => {
      if (done) return;
      done = true;
      if (error === undefined) resolve(new Uint8Array(Buffer.concat(chunks, total)));
      else {
        res.destroy();
        reject(error);
      }
    };
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) finish(tooLarge(maxBytes));
      else chunks.push(chunk);
    });
    res.on('end', () => { finish(undefined); });
    // Bricht die Verbindung vor dem Ende ab (Node meldet `aborted` oder nur `close`), ist das ein unvollständiger Download.
    res.on('error', (error) => { finish(res.complete ? error : incomplete(total, error)); });
    res.on('close', () => { finish(res.complete ? undefined : incomplete(total)); });
  });
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
  const isBlocked = options.allowPrivate === true ? () => false : (options.isBlocked ?? isBlockedAddress);
  const resolve = options.resolve ?? systemResolver;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  let current = new URL(url);
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new OpenVideoError({ code: 'OV_FETCH_PROTOCOL', errorClass: 'SecurityError', problem: `Protocol ${current.protocol} is not allowed.`, suggestions: ['Use an http(s) URL.'] });
    }
    // IP-Literale löst `net.connect` nicht auf; sie werden hier geprüft. Hostnamen prüft `lookup`.
    const host = current.hostname.replace(/^\[|\]$/gu, '');
    if (isIP(host) !== 0 && isBlocked(host)) throw blocked(current.toString(), host);
    let res: IncomingMessage;
    try {
      res = await send(current, checkedLookup(current, resolve, isBlocked), signal);
    } catch (error) {
      throw failed(current, error);
    }
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.destroy();
      const location = res.headers.location;
      if (location === undefined || location === '') {
        throw new OpenVideoError({ code: 'OV_FETCH_REDIRECT_LOCATION', errorClass: 'AssetError', problem: `${current.toString()} answered HTTP ${String(status)} without a Location header.`, suggestions: ['Use the final URL of the file directly.'] });
      }
      current = new URL(location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      throw new OpenVideoError({ code: 'OV_FETCH_FAILED', errorClass: 'AssetError', problem: `Fetching ${current.toString()} returned HTTP ${String(status)}.`, suggestions: ['Check the URL.'] });
    }
    const length = Number(res.headers['content-length'] ?? '0');
    if (length > maxBytes) {
      res.destroy();
      throw tooLarge(maxBytes, length);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readLimited(res, maxBytes);
    } catch (error) {
      throw failed(current, error);
    }
    return { bytes, contentType: res.headers['content-type'], finalUrl: current.toString() };
  }
  throw new OpenVideoError({ code: 'OV_FETCH_REDIRECTS', errorClass: 'AssetError', problem: `Too many redirects for ${url}.`, suggestions: ['Use the final URL directly.'] });
}
