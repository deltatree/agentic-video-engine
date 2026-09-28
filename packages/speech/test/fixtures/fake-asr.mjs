// Test-ASR: schreibt ein festes Transkript als JSON und zählt jeden Aufruf.
// Aufruf: node fake-asr.mjs <in.wav> <out.json> <zähler> <sprache>
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [input, out, counter, language] = process.argv.slice(2);
if (input === undefined || out === undefined || counter === undefined) process.exit(2);
readFileSync(input);
appendFileSync(counter, 'call\n');
writeFileSync(
  out,
  JSON.stringify({
    language,
    cues: [
      { start: 0, end: 1.2, text: 'Hello there', words: [{ text: 'Hello', start: 0, end: 0.5 }, { text: 'there', start: 0.5, end: 1.2 }] },
      { start: 1.5, end: 2.5, text: 'no word times' },
    ],
  }),
);
