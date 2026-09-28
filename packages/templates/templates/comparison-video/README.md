# Comparison Video

Vergleich: Vorher und Nachher nebeneinander, dann das Ergebnis als großer Zähler.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 12s |

## Anpassen

- Spalten: `BEFORE` und `AFTER` (gleich viele Zeilen).
- Ergebnis: `RESULT`.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs comparison-video
```
