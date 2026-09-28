# Subtitle Video

Sprechervideo mit Untertiteln: Die Untertitel stehen im Code, das gesprochene Wort wird hervorgehoben.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 12s |

## Anpassen

- Untertitel: `CUES` (Start, Ende, Text).
- Stil: `style` am `SubtitleTrack` (`word-highlight`, `karaoke`, `pop` …).
- Datei statt Code: `src="./captions.srt"`.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs subtitle-video
```
