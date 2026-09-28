---
title: 'Untertitel und Sprache: Formate, Caption-Layout, Voice- und ASR-Provider (Stories 5.3–5.5)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/docs/reference/node-semantics.md'
  - '{project-root}/packages/core/src/registry.ts'
  - '{project-root}/packages/schema/src/project.ts'
  - '{project-root}/packages/schema/src/nodes.ts'
  - '{project-root}/packages/cache/src/cache.ts'
---

## Intent

**Problem:** Untertitel (FR-55, FR-56), Voiceover (FR-58, FR-59) und Transkription (FR-57) sind Kernfunktionen. Stimmen dürfen nie bei jedem Build neu erzeugt werden.

**Approach:** `subtitles` (isomorph): Parser und ein `NodeExpander` für den Node-Typ `subtitles`, der Cues in Text-Nodes übersetzt. `speech` (Node): Provider-Adapter als externe Prozesse, Cache über `@agentic-video/cache`.

## Boundaries & Constraints

**Always:**
- Pakete: `packages/subtitles`, `packages/speech`. Nichts anderes ändern.
- `subtitles` hängt nur von `core` ab, keine Node-APIs.
- Provider sind lose gekoppelt (Interfaces `VoiceProvider`, `AsrProvider` aus core, Registrierung über `Registry`). Keine feste Kopplung an den Kern (FR-57).
- Lokale Open-Source-Engines: Piper (TTS), espeak-ng (TTS), whisper.cpp (ASR). Versuche, sie ohne sudo lokal nach `~/.local/opt` zu installieren (z. B. `pip install --user piper-tts` plus eine Stimme von Hugging Face `rhasspy/piper-voices`, espeak-ng nur wenn als statisches Binary verfügbar, whisper.cpp aus dem Quellcode mit cmake/g++ bauen plus Modell `ggml-tiny.en.bin`). Was nicht installierbar ist: Tests mit `it.skipIf` und benanntem Grund; berichte ehrlich.

## Anforderungen

### subtitles
- `parseSrt`, `parseVtt` (Cue-Einstellungen, `<v Sprecher>`, Zeitstempel innerhalb von Cues als Wortzeiten), `parseAss` (Styles, Events, `\k`/`\kf`-Karaoke-Tags als Wortzeiten, Override-Tags entfernen mit Diagnose), `parseSubtitles(text, format?)` mit Formaterkennung → `SubtitleCue[]` (IR-Typ, Zeiten in Sekunden als `"1.5s"`-Strings oder Frames – wähle und dokumentiere). `formatSrt`, `formatVtt` für Export.
- `estimateWordTimings(cue)` verteilt Wortzeiten proportional zur Zeichenzahl, wenn keine vorhanden sind.
- `subtitlesExpander(options)` → `NodeExpander` für Typ `subtitles`: liest den referenzierten Track aus `ctx.project` (Composition `ctx.compositionId`, Track per `track`-ID; Cues inline oder Asset-Text über eine übergebene Funktion `loadTrackText(assetId)`, synchron aus vorab geladenen Daten), wählt den aktiven Cue zur lokalen Zeit und erzeugt: `rich-text` (Wörter als Spans) mit `background` (Box: `box`-Prop), Position `bottom`/`top`/`center`/`custom` innerhalb der Safe Area (`safeArea`, Standard 0.05), `maxWidth` (Standard 80 % der Breite) mit Umbruch, Stile `plain`, `word-highlight` (aktuelles Wort in `highlightColor`), `karaoke` (gesungene Wörter in `highlightColor`), `pop` (aktuelles Wort skaliert via `textAnimation` oder Span-Stil), `fade` (Cue-Ein-/Ausblendung), `typewriter` (Wörter erscheinen nach Zeit), `speakerStyles` (Farbe/Schrift/Box je Sprecher).
- `registerSubtitles(registry, options)`.

### speech
- Adapter: `createPiperProvider({ binary?, model })`, `createEspeakProvider({ binary? })`, `createCommandVoiceProvider({ id, command: string[] mit Platzhaltern {text} {out} {voice} })`, `createWhisperCppProvider({ binary?, model })` (JSON-Ausgabe mit Wortzeiten), `createCommandAsrProvider(...)`. Alle: `available()`, `version()`, Timeouts, Fehler als `OpenVideoError` mit stderr-Auszug und Installationshinweis.
- Ausgabe-Audio wird auf WAV 48 kHz normalisiert (FFmpeg aus `@agentic-video/ffmpeg`: prüfe, ob das Paket schon `locateFfmpeg` exportiert – es entsteht parallel; sonst rufe `ffmpeg` direkt über `node:child_process` mit Suche `OPENVIDEO_FFMPEG`/`PATH` auf und nenne das im Bericht).
- `synthesizeVoices(project, { registry, cache, outDir })` → für jede `project.audio`-Quelle mit `voice`: Cache-Schlüssel = `contentHash({ provider, providerVersion, request })`; Treffer → keine Synthese (FR-59). Ergebnis: Datei-Pfad, Dauer, Wortzeiten; zusätzlich Marker-Vorschläge `voice.<id>.word.<n>` für die Synchronisation mit dem Voiceover.
- `transcribe(audioPath, { registry, provider, cache })` → `SubtitleCue[]` mit Wortzeiten (Cache wie oben).
- `registerSpeechProviders(registry, detected)` registriert verfügbare Provider.

## Tasks & Acceptance

**Acceptance Criteria:**
- Parser-Tests mit realistischen Dateien je Format inkl. Randfällen (BOM, CRLF, Stunden > 9, fehlerhafte Zeilen → Diagnose statt Absturz).
- Expander-Tests: zu gegebener Zeit richtiger Cue, richtige Hervorhebung, Position in der Safe Area, gültige IR (Schema-Validierung der erzeugten Nodes).
- Cache-Test: zweiter Aufruf von `synthesizeVoices` ruft den Provider nicht auf (Zähler über `createCommandVoiceProvider` mit einem kleinen Skript, das eine Sinus-WAV schreibt).
- Echte Engines: je verfügbarer Engine ein Integrationstest.

## Verification

- `npx tsc -b packages/subtitles packages/speech`
- `npx vitest run packages/subtitles packages/speech`
- `npx eslint packages/subtitles packages/speech --max-warnings 0`
