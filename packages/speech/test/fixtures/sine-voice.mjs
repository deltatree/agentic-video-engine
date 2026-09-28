// Test-Stimme: schreibt eine Sinus-WAV (22,05 kHz, mono, 16 Bit), 0,2 s je Wort,
// und zählt jeden Aufruf mit einer Zeile in der Zählerdatei.
// Aufruf: node sine-voice.mjs <out.wav> <text> <zähler>
import { appendFileSync, writeFileSync } from 'node:fs';

const [out, text, counter] = process.argv.slice(2);
if (out === undefined || text === undefined || counter === undefined) {
  process.stderr.write('usage: sine-voice.mjs <out> <text> <counter>\n');
  process.exit(2);
}
if (text.includes('FAIL')) {
  process.stderr.write('synthetic failure requested\n');
  process.exit(3);
}
appendFileSync(counter, 'call\n');
const rate = 22050;
const words = text.split(/\s+/).filter((w) => w !== '').length;
const samples = Math.round(rate * 0.2 * Math.max(1, words));
const buf = Buffer.alloc(44 + samples * 2);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + samples * 2, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
writeFileSync(out, buf);
