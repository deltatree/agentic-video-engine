# @agentic-video/ffmpeg

FFmpeg-Medienschicht: Encoding, Decoding, Inspektion, Capabilities.

OpenVideo bündelt FFmpeg nicht. Die Suche folgt dieser Reihenfolge:

1. Option `ffmpegPath` (bzw. `ffprobePath`).
2. Umgebungsvariable `OPENVIDEO_FFMPEG` (bzw. `OPENVIDEO_FFPROBE`).
3. Nur ffprobe: dasselbe Verzeichnis wie das gefundene FFmpeg.
4. `PATH`.

Fehlt ein Programm, meldet `locateFfmpeg()` den Code `OV_FFMPEG_MISSING` mit Installationshinweis.

| Funktion | Zweck |
|---|---|
| `probeCapabilities()` | Version, Lizenz, Encoder, Decoder, Hardware-Encoder (Probe mit 1 Frame) |
| `probeMedia(path)` | Container, Streams, Codec, Maße, fps, Farbe, Alpha, Audio, Metadaten |
| `extractThumbnail(path, s)` | Einzelbild als vormultipliziertes RGBA |
| `VideoFrameReader` | Frame-genaues Lesen: Index = `floor(s · fps + 1e-6)` |
| `createEncoder(options)` | Deterministisches Encoding aus vormultipliziertem RGBA |
| `concatSegments(paths, out)` | Segmente ohne Neukodierung zusammenfügen |

Die Abbildung von `quality` (0–100) auf CRF und qscale steht in `src/encoder.ts`.

Hardware-Encoding ist Opt-in (Story 21.5): Ohne `hardware` kodiert der Encoder auf der CPU (`none`), damit jede
Maschine dieselben Bytes schreibt. `hardware: 'auto'` nutzt einen Hardware-Encoder nach erfolgreicher Probe,
`nvenc`/`vaapi`/`qsv`/`videotoolbox` verlangen die Familie (Render-Profil: `hardwareAcceleration`).
