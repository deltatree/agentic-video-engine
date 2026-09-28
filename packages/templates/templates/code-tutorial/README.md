# Code Tutorial

Programmier-Tutorial: Code tippt sich im Editor, ein Hinweis erklärt eine Zeile, das Terminal zeigt Befehle und Ausgabe.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 15s |

## Anpassen

- Code: `CODE`; markierte Zeilen: `HIGHLIGHT`.
- Terminal: `COMMANDS` (Befehl und Ausgabe).
- Tippgeschwindigkeit: `typing` (Zeichen pro Sekunde).
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs code-tutorial
```
