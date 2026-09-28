# Product Launch

Produktankündigung in drei Szenen: Name mit Badge, drei Vorteile als Karten, Aufruf mit Browser-Fenster.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 12s |

## Anpassen

- Texte: `COPY` in `src/video.tsx`.
- Vorteile: Einträge in `COPY.features` (Karten stehen nebeneinander, 3 passen).
- Browser-Inhalt: Rechtecke im `BrowserWindow` ersetzen.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs product-launch
```
