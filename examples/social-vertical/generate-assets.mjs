#!/usr/bin/env node
// Erzeugt das Asset des Beispiels deterministisch, ohne Abhängigkeiten (nur Node.js):
//   assets/avatar.png – 256×256 Profilbild (stilisiertes Gesicht auf Verlauf)
// Das Bild ist ein eigener, synthetischer Inhalt und steht unter CC0-1.0.
// Aufruf: node generate-assets.mjs  (schreibt nach ./assets neben diesem Skript)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), 'assets');
mkdirSync(out, { recursive: true });

/** Minimaler PNG-Encoder (RGBA, 8 Bit, ohne Filter). */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Profilbild: Verlauf (türkis → violett), Kopf und Schultern als helle Formen. Die Node schneidet es rund aus.
const S = 256;
writeFileSync(
  join(out, 'avatar.png'),
  png(S, S, (x, y) => {
    const t = y / S;
    const head = Math.hypot(x - 128, y - 104) < 46;
    const shoulders = y > 170 && Math.hypot((x - 128) / 1.6, y - 250) < 78;
    if (head || shoulders) return [245, 247, 255, 255];
    return [Math.round(20 + t * 120), Math.round(184 - t * 120), Math.round(166 + t * 60), 255];
  }),
);
console.log(`Assets written to ${out}`);
