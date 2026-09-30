# @agentic-video/fonts

Schriften: Laden, Validieren, Hashen, gebündelte Standardschriften.

## Gebündelte Schriften

Alle Schriften stehen unter der SIL Open Font License 1.1. Die Lizenztexte liegen neben den Dateien.

| Familie | Datei | Quelle |
|---|---|---|
| Inter | `assets/inter/InterVariable.ttf`, `InterVariable-Italic.ttf` | rsms/inter, Release v4.1 |
| JetBrains Mono | `assets/jetbrains-mono/JetBrainsMono-Variable.ttf`, `JetBrainsMono-Italic-Variable.ttf` | JetBrains/JetBrainsMono, Release v2.304 |
| Noto Color Emoji | `assets/noto-color-emoji/NotoColorEmoji.ttf` | googlefonts/noto-emoji, Tag v2026-09-24-unicode18_0 |

Systemschriften werden nie geladen. So bleibt jeder Render reproduzierbar.

## Formate

`project.fonts[]` nimmt TrueType (`.ttf`), OpenType (`.otf`), Sammlungen (`.ttc`, `.otc`), WOFF und WOFF2.
Beim Laden (und beim Asset-Import) wird jede Datei zu einer einzelnen SFNT-Schrift (`toSfnt`):

- WOFF 1.0: Tabellen mit zlib entpackt.
- WOFF 2.0: Brotli entpackt, dazu die Rücktransformation von `glyf`/`loca` und `hmtx` nach der W3C-Spezifikation.
  WOFF2-Sammlungen werden ebenfalls gelesen.
- Sammlungen: `faceIndex` (Standard 0) wählt die Schrift; ein ungültiger Index meldet `OV_FONT_FACE_INDEX`.

```json
{ "family": "Noto Sans CJK JP", "src": "fonts/NotoSansCJK.ttc", "faceIndex": 0 }
```

Der Inhalts-Hash (`hash`) gilt der umgewandelten SFNT-Schrift. So hat jedes Face einer Sammlung einen eigenen Hash.
