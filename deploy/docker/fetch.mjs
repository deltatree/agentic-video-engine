// Lädt eine Datei im Image-Build und prüft ihre SHA-256 (Ersatz für `ADD --checksum`, das Buildah/Podman
// vor 1.37 nicht kennt; ADR 0029). Aufruf: node fetch.mjs <url> <sha256> <ziel>
// Proxy: NODE_USE_ENV_PROXY=1 mit HTTPS_PROXY; TLS-Proxy: NODE_EXTRA_CA_CERTS (Build-Secret `ca`).
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, expected, target] = process.argv.slice(2);
if (url === undefined || !/^[0-9a-f]{64}$/u.test(expected ?? '') || target === undefined) {
  process.stderr.write('usage: node fetch.mjs <url> <sha256> <target>\n');
  process.exit(2);
}
const hash = createHash('sha256');
for (let attempt = 1; ; attempt++) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status} for ${url}`);
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => hash.update(chunk));
    await pipeline(source, createWriteStream(target));
    break;
  } catch (error) {
    await rm(target, { force: true });
    if (attempt >= 5) throw error;
    process.stderr.write(`fetch ${url} failed (${error instanceof Error ? error.message : String(error)}), retry ${attempt}/4\n`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}
const actual = hash.digest('hex');
if (actual !== expected) {
  await rm(target, { force: true });
  process.stderr.write(`SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}\n`);
  process.exit(1);
}
process.stdout.write(`${target}: ${actual} OK\n`);
