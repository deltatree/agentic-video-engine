# Presentation

Präsentation mit drei Folien: Titel, Stichpunkte, Tabelle. Fußzeile mit Titel und Fortschritt.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 15s |

## Anpassen

- Folienlänge: `SLIDE` (Sekunden je Folie).
- Stichpunkte: `BULLETS`.
- Tabelle: `TABLE.columns` und `TABLE.rows`.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs presentation
```
