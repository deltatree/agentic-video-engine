---
title: 'FFmpeg-Medienschicht und Audio-Engine (Stories 2.5, 5.1, 5.2)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/packages/core/src/contracts.ts'
  - '{project-root}/packages/schema/src/project.ts'
---

## Intent

**Problem:** OpenVideo braucht eine klar isolierte Medienschicht für Encoding, Decoding, Inspektion und eine deterministische Offline-Audio-Engine (FR-52..FR-54, FR-60..FR-64).

**Approach:** Paket `ffmpeg` kapselt den externen FFmpeg-Prozess. Paket `audio` dekodiert Quellen über FFmpeg zu Float32 und mischt, filtert und normalisiert in reinem TypeScript (deterministisch, bitgleich).

## Boundaries & Constraints

**Always:**
- Pakete: `packages/ffmpeg`, `packages/audio`. Nichts anderes ändern.
- FFmpeg wird nie gebündelt. Suche: Option `ffmpegPath` → Umgebungsvariable `OPENVIDEO_FFMPEG` → `PATH`. Gleiches für `ffprobe` (`OPENVIDEO_FFPROBE`).
- Jeder Prozessaufruf hat einen Timeout und liefert bei Fehler `OpenVideoError` mit der letzten stderr-Zeile in `details` und einem Lösungsvorschlag.
- Encoding deterministisch: `-fflags +bitexact`, `-flags:v +bitexact`, `-flags:a +bitexact`, `-map_metadata -1`, feste Threadzahl (Option, Standard 4) statt `auto`.

## Anforderungen

### ffmpeg
- `locateFfmpeg(options?) → { ffmpeg, ffprobe }` (Fehler `OV_FFMPEG_MISSING` mit Installationshinweis je Betriebssystem).
- `probeCapabilities() → { version, configuration, license: 'LGPL-2.1-or-later' | 'GPL-2.0-or-later' | 'GPL-3.0-or-later' | 'nonfree', encoders: string[], decoders: string[], hwaccels: string[], hardwareEncoders: { nvenc, vaapi, qsv, videotoolbox }: boolean je Familie (erkannt über Encoder-Liste UND eine Probe-Kodierung von 1 Frame; Probe schlägt ohne Hardware fehl → false) }`. Ergebnis pro Pfad zwischenspeichern.
- `codecLicenses` Tabelle (x264/x265 GPL, libvpx BSD-3-Clause, libaom BSD-2-Clause, prores_ks LGPL, …) für das Manifest.
- `probeMedia(path) → MediaInfo` (ffprobe JSON: Dauer, Container, Streams, Codec, Maße, fps als Bruch und Zahl, pix_fmt, Farbraum/Transfer/Primaries, Alpha ja/nein, Audio-Samplerate/Kanäle, Metadaten).
- `extractThumbnail(path, seconds, { width? }) → RgbaImage`.
- `VideoFrameReader`: `open(path)`, `frameAt(seconds) → RgbaImage` (vormultipliziert!). Frame-genaue Zuordnung: Quell-Frame-Index = `floor(seconds · fps + 1e-6)`, geklemmt. Effizient für fortlaufende Zugriffe (ein laufender Decoder-Prozess, der sequenziell rawvideo liefert; Sprung → Neustart mit `-ss` vor dem Frame plus exaktem Frame-Filter). Kleiner LRU-Cache.
- `createEncoder(options) → { write(image: RgbaImage): Promise<void>; finish(): Promise<EncodeResult>; abort(): Promise<void> }`:
  - Formate: `mp4`, `mov`, `webm`, `gif`, `webp` (animiert), `png-sequence`, `jpeg-sequence`, `webp-sequence`.
  - Codecs: `h264`, `h265`, `vp9`, `av1` (libaom oder libsvtav1, je nach Verfügbarkeit), `prores` (prores_ks, Profil hq), `prores-4444` (mit Alpha, `yuva444p10le`), `ffv1` (verlustfrei, mkv/mov), `png`, `gif` (Palette in einem Durchlauf: `split`, `palettegen`, `paletteuse`), `webp`.
  - `alpha: true`: VP9 mit `yuva420p`, ProRes 4444, PNG/WebP-Sequenzen mit Alpha. Nicht alpha-fähige Kombinationen → `OV_ENCODE_ALPHA_UNSUPPORTED` mit Vorschlag.
  - `quality` 0–100 auf CRF/qscale abgebildet (Tabelle dokumentieren).
  - `hardware: 'auto' | 'none' | 'nvenc' | 'vaapi' | 'qsv' | 'videotoolbox'`; `auto` nutzt Hardware nur, wenn die Probe erfolgreich war; sonst CPU (Fallback immer).
  - Eingabe: RGBA vormultipliziert → vor dem Schreiben entmultiplizieren (straight alpha) und als `rawvideo rgba` über stdin schreiben. Farbraum-Metadaten setzen (`-colorspace bt709 -color_primaries bt709 -color_trc` passend zu srgb/bt709).
  - Audio: optional `audioPath` (WAV) muxen, Codec `aac`/`opus`/`pcm` mit Bitrate.
  - `EncodeResult`: Pfad(e), Frames, Dauer, verwendeter Encoder, Argumente (für das Manifest).
- `concatSegments(paths, outPath)` (concat-Demuxer, stream copy) für Chunk-Rendering.

### audio
- `decodeAudio(path, { sampleRate = 48000, channels = 2, start?, duration?, rate? }) → { sampleRate, channels: Float32Array[] }` über FFmpeg (`-f f32le`), Tempo-Änderung per `atempo`-Kette.
- `mixComposition(input) → { sampleRate, channels: Float32Array[] }`: Eingabe sind die `tracks` einer Composition (IR-Typen `AudioTrack`), aufgelöste Quellen (`resolveSource(id) → { path, duration }`), fps, Dauer in Frames, Marker, Seed. Unterstützt: mehrere Spuren, Clips mit `start`, `offset` (Trim), `duration`, `loop`, `playbackRate`, `fadeIn`/`fadeOut`, Clip- und Spur-`volume` und `pan` (animierbar: mit `evaluateAnimated` aus core pro Block von 1/1000 s, dazwischen linear), `crossfade` zwischen aufeinanderfolgenden Clips einer Spur, `ducking` (Sidechain: Hüllkurve der Führungsspur mit Attack/Release, Absenkung um `amount` dB), `eq` (RBJ-Biquads), `compressor`, `limiter` (Lookahead 5 ms, True-Peak nicht nötig).
- `masterAudio(buffer, { loudness?: number (LUFS), limiter?: { ceiling } })`: Loudness-Normalisierung (BS.1770-4 Messung, Gain, danach Limiter).
- `measureLoudness(buffer)` (integriert, LUFS), `writeWav(buffer, path, { bitDepth: 16 | 24 | 32 })`.
- Pan-Gesetz: konstante Leistung (−3 dB Mitte), dokumentiert.
- Alles deterministisch: gleiche Eingabe → bitgleiche Ausgabe (Hash-Test).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected |
|---|---|---|
| FFmpeg fehlt | `ffmpegPath: '/nope'` | `OV_FFMPEG_MISSING` |
| Frame-genaues Lesen | Testvideo mit Frame-Nummer in der Farbe | `frameAt(n / fps)` liefert Frame n |
| Alpha-Export | halbtransparenter Frame, VP9 alpha / ProRes 4444 / PNG | ffprobe meldet Alpha-Format; PNG-Pixel Alpha 128 ±1 |
| Leere Spur | Track ohne Clips | Stille |
| Clip nach Ende | start > Dauer | wird ignoriert, keine Exception |

## Tasks & Acceptance

**Acceptance Criteria:**
- ffprobe-Test je Format und Codec aus der Liste (Container, Codec, Maße, Frame-Anzahl).
- Hardware-Erkennung meldet auf dieser Maschine (keine GPU) `false` für alle; `auto` fällt auf CPU zurück.
- Audio: Dauer ±1 Sample-Block, Sync-Test (Klick bei Frame 30 → Onset bei 1.000 s ±1 Frame), Mix-Pegel, Loudness-Ziel −16 LUFS ±0.5, Ducking senkt Musik messbar, Crossfade ohne Lücke, Pan links/rechts.
- Test-Medien erzeugst du im Test mit FFmpeg (`lavfi`: `testsrc2`, `sine`, `color`) im Temp-Verzeichnis.

## Verification

- `npx tsc -b packages/ffmpeg packages/audio`
- `npx vitest run packages/ffmpeg packages/audio`
- `npx eslint packages/ffmpeg packages/audio --max-warnings 0`
