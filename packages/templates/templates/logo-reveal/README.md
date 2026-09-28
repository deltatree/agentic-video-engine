# Logo Reveal

Logo-Animation: Das Zeichen zeichnet seine Kontur, füllt sich, rückt nach links; die Wortmarke erscheint Zeichen für Zeichen.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 6s |

## Anpassen

- Eigenes Zeichen: `MARK` (SVG-Pfad im 200×200-Raster, `evenodd` für Aussparungen).
- Name und Unterzeile: `COPY`.
- Endlage: `END_X` so wählen, dass Zeichen und Wortmarke mittig stehen.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs logo-reveal
```
