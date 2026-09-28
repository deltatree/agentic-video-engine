# Social Video

Hochformat für Reels, Shorts und TikTok: Aufhänger mit Zähler, drei Tipps, Aufruf zum Folgen, Fortschrittsleiste oben.

| Eigenschaft | Wert |
|---|---|
| Größe | 1080 × 1920 |
| Bildrate | 30 fps |
| Dauer | 10s |

## Anpassen

- Texte: `COPY` in `src/video.tsx`.
- Tipps: 2–4 Einträge in `COPY.tips`.
- Sichere Zone: oben 200 px und unten 320 px frei lassen.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs social-video
```
