# @agentic-video/testing

Testwerkzeuge: Golden Images, Pixel-Diff, Audio-Analyse, Determinismus und überwachte Skips.

## Überwachte Skips (`skipUnless`)

Tests, die eine fehlende Umgebung brauchen (Docker, Piper, whisper.cpp, Blender, FFmpeg, OS-Sandbox),
überspringen nie still, sondern mit Begründung:

```ts
import { it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';

it.skipIf(skipUnless(dockerOk, 'Docker fehlt: Docker-Daemon starten'))('läuft im Container', async () => {
  // ...
});
```

- Lokal wird der Test mit der Begründung übersprungen.
- Mit `OPENVIDEO_REQUIRE_ALL=1` (so läuft CI) wirft `skipUnless` den Fehler `OV_TEST_SKIP_FORBIDDEN`:
  eine fehlende Werkzeugkette macht CI rot, statt Tests verschwinden zu lassen.
- Ausnahmen, die kein CI-Runner erfüllen kann (GPU-Hardware), stehen mit `{ allowInCi: true }` auf der Allowlist.
- Ein Test in `packages/testing/test/skip.test.ts` prüft, dass jedes `skipIf`/`runIf` im Repo über
  `skipUnless` (oder `perfStrict`) läuft.

## Wall-Clock-Grenzen (`perfStrict`)

Harte Zeitgrenzen („unter 600 ms“) hängen von der Maschine ab. Solche Tests laufen nur mit
`OV_PERF_STRICT=1` (Nightly-Benchmark), sonst werden sie benannt übersprungen:

```ts
it.skipIf(!perfStrict())('1080p in unter 600 ms (nur mit OV_PERF_STRICT=1)', () => { /* ... */ });
```

## Weitere Werkzeuge

- `expectGolden(image, path, { maxChannelDelta, maxDiffRatio })`: Golden Images, `UPDATE_GOLDENS=1` schreibt neu.
- `compareImages`, `imageHash`, `solidImage`, `checkerImage`: Pixel-Vergleich und Testbilder.
- `rms`, `peak`, `integratedLoudness`, `findOnsets`: Audio-Analyse (z. B. A/V-Sync mit Klick-Spur).
- `determinism(fn, frames)`: vergleicht Frame-Hashes vorwärts und rückwärts.
