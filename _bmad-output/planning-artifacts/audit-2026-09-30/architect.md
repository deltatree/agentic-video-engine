# Audit Architektur (Winston) – 2026-09-30

Regeln eingehalten (kein any/as/!/ts-ignore/leeres catch/TODO/Fake; keine Zyklen). Hebel: Leistung, Speicher, Abbruch.
DoD-Lauf A: 6 Worker, renderFrames 4442 s, ffmpeg 430 s nacheinander → ≈14,8 s Worker-Zeit je 4K-Frame.

| # | Befund | Beleg | Schwere |
|---|---|---|---|
| 1 | Compositor: jede Gruppe Vollbild-Float32 (132,7 MB bei 4K), transform/blend/mask/crop über alle Pixel; applyCrop fill je Pixel | compositor/src/composite.ts:141,180,201,229,271 | hoch |
| 2 | color-grade: pro Pixel Closures/Arrays und bis 7× Math.pow; Vignette sqrt je Pixel | compositor/src/effects.ts:199,234,305,473 | hoch |
| 3 | Skia: neuer 33-MB-Malloc je Layer + doppelte Kopie; jeder Layer zlib-komprimiert in Layer-Cache, obwohl animierte Layer nie treffen | renderer-skia/src/backend.ts:294; image.ts:62,109; render/src/frame.ts:74,92,132,163 | hoch |
| 4 | HTML-Layer als Vollbild-PNG übertragen, JS-PNG-Decode | renderer-browser/src/host.ts:375; png/src/index.ts:198 | mittel-hoch |
| 5 | imageHash: concat 33 MB + JS-SHA-256 je Frame im Main-Thread | render/src/manifest.ts:62-67; video.ts:117 | mittel |
| 6 | Encoding erst nach allen Frames, inflateSync + unpremultiply im Main-Thread, x264 threads=4 | render/src/video.ts:214-224; ffmpeg/src/encoder.ts:204,454 | mittel |
| 7 | Parallelität nur opt-in (--workers), Standard 1 Prozess | cli/src/cli.ts:406; cli/src/services.ts:171 | mittel |
| 8 | Kein Abbruch/Timeout auf Chunk-Ebene; Worker laufen nach Cancel weiter | render/src/video.ts:53,179; scheduler/src/pool.ts:184; worker/src/stdio.ts:106 | hoch |
| 9 | Frame-/Layer-Cache wächst unbegrenzt, prune nur manuell | cli/src/cli.ts:472 | mittel |
| 10 | SkSL-Effekt-Cache ohne Obergrenze | renderer-skia/src/backend.ts:96,109 | niedrig |
| 11 | Intl.Segmenter ohne feste Locale | core/src/semantics.ts:216; renderer-skia/src/text.ts:521 | mittel |
| 12 | Premultiply doppelt (png, ffmpeg) | png/src/index.ts:43; ffmpeg/src/pixels.ts:15 | niedrig |
| 13 | Große Dateien (operations.ts 909, cli.ts 649) | – | niedrig |
