#!/usr/bin/env node
// Erzeugt die Assets des Beispiels deterministisch, ohne Abhängigkeiten (nur Node.js):
//   assets/logo.png  – 256×256, Verlauf-Kachel mit Play-Symbol
//   assets/music.wav – 8 s Akkordfolge C–Am–F–G, 48 kHz Stereo, 16 Bit
// Beide Dateien sind eigene, synthetische Inhalte und stehen unter CC0-1.0.
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

/** 16-Bit-PCM-WAV aus einer Funktion (Zeit in Sekunden → [links, rechts] in -1..1). */
function wav(seconds, sampleRate, sample) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const [l, r] = sample(i / sampleRate);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Logo: abgerundete Kachel mit Verlauf (orange → violett) und dunklem Play-Dreieck.
const S = 256;
writeFileSync(
  join(out, 'logo.png'),
  png(S, S, (x, y) => {
    const r = 56;
    const cx = Math.min(Math.max(x + 0.5, r), S - r);
    const cy = Math.min(Math.max(y + 0.5, r), S - r);
    const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
    if (!inside) return [0, 0, 0, 0];
    const t = (x + y) / (2 * S);
    const play = x > 96 && x < 184 && Math.abs(y - 128) < (184 - x) * 0.58;
    if (play) return [11, 13, 18, 255];
    return [Math.round(255 - t * 117), Math.round(90 - t * 47), Math.round(31 + t * 195), 255];
  }),
);

// Musik: vier Akkorde à 2 s mit weicher Hüllkurve, leicht stereo verteilt.
const CHORDS = [
  [261.63, 329.63, 392.0],
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
  [196.0, 246.94, 293.66],
];
writeFileSync(
  join(out, 'music.wav'),
  wav(8, 48000, (t) => {
    const chord = CHORDS[Math.min(3, Math.floor(t / 2))];
    const local = t % 2;
    const env = (1 - Math.exp(-6 * local)) * Math.exp(-0.6 * local) * 0.16;
    const [a, b, c] = chord.map((f) => Math.sin(2 * Math.PI * f * t));
    return [(a + 0.8 * b + 0.6 * c) * env, (0.6 * a + 0.8 * b + c) * env];
  }),
);
console.log(`Assets written to ${out}`);
