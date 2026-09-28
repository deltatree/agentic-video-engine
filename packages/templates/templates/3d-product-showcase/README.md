# 3D Product Showcase

3D-Produktvideo: Ein Lautsprecher aus Grundkörpern (Zylinder, Torus, Kugel) dreht sich auf einem Podest. Gerendert mit Three.js (`scene3d`).

| Eigenschaft | Wert |
|---|---|
| Größe | 1920 × 1080 |
| Bildrate | 30 fps |
| Dauer | 10s |

## Anpassen

- Texte: `COPY`.
- Modell: `Product` ändern oder durch `<Model src="./assets/product.glb" />` ersetzen.
- Kamera: Keyframes von `camera.position`.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs 3d-product-showcase
```
