# SaaS Explainer

Erklärvideo: Problem, Produkt im Laptop mit Mauszeiger und Hinweis, drei Schritte mit Pfeilen.

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 15s |

## Anpassen

- Texte: `COPY` in `src/video.tsx`.
- Dashboard: Rechtecke in `Dashboard`.
- Mauszeiger: Wegpunkte `points` und Klickzeit `clicks` am `Cursor`.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs saas-explainer
```
