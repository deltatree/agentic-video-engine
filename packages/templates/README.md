# @agentic-video/templates

15 Templates als lesbarer TSX-Quellcode mit Katalog (FR-81).
Jedes Template ist ein Startpunkt: kopieren, Texte ändern, rendern.

## Aufbau eines Templates

```
templates/<name>/
  src/video.tsx    Quellcode mit SDK und Komponenten
  project.json     daraus kompilierte IR (für Nutzer ohne Compiler)
  template.json    Titel, Beschreibung, Schlagworte
  README.md        Anleitung zum Anpassen
```

Alle Farben lesen Theme-Tokens (`ref('theme.colors.primary')`, Komponenten-Standards).
Ein anderes Theme in `settings.theme` färbt das ganze Video um, z. B. `THEMES.light`.

## Die Templates

| Name | Format | Dauer |
|---|---|---|
| `product-launch` | 1920×1080 | 12 s |
| `saas-explainer` | 1920×1080 | 15 s |
| `logo-reveal` | 1920×1080 | 6 s |
| `social-video` | 1080×1920 | 10 s |
| `youtube-intro` | 1920×1080 | 6 s |
| `presentation` | 1920×1080 | 15 s |
| `data-visualization` | 1920×1080 | 14 s |
| `code-tutorial` | 1920×1080 | 15 s |
| `architecture-diagram` | 1920×1080 | 14 s |
| `3d-product-showcase` | 1920×1080 | 10 s (Three.js) |
| `lower-third` | 1920×1080, transparent | 6 s |
| `subtitle-video` | 1920×1080 | 12 s |
| `podcast-clip` | 1080×1080 | 12 s |
| `cinematic-title` | 1920×1080 (2,39:1) | 10 s |
| `comparison-video` | 1920×1080 | 12 s |

## Katalog

```ts
import { createTemplateCatalog } from '@agentic-video/templates';
const catalog = createTemplateCatalog();
catalog.list(); // 15 Einträge mit Maßen, fps und Dauer
const { project, files } = await catalog.get('logo-reveal');
```

`get` liefert die IR (`project.json`) und den Inhalt aller übrigen Dateien.
Der Katalog passt strukturell zu `TemplateCatalog` aus `@agentic-video/agent`.

## Bauen

`project.json` entsteht aus `src/video.tsx`. Nach jeder Änderung neu bauen:

```bash
npm run build:extra -w @agentic-video/templates        # alle
node packages/templates/scripts/build-templates.mjs logo-reveal   # eines
```

Das Skript:

1. erzeugt die Amplituden des Test-Tons für `podcast-clip` (`src/waveform.ts`);
2. prüft alle TSX-Quellen mit TypeScript (`tsconfig.templates.json`);
3. kompiliert jede `src/video.tsx` im Modus `trusted-host` (eigener Code) zur IR.

Es braucht ein gebautes `@agentic-video/compiler` (`npm run build` baut zuerst `dist/`).
Ein Test prüft, dass jedes `project.json` aktuell ist.

## Tests und Goldens

Die Tests rendern Frame 0, Mitte und Ende jedes Templates als Kontaktbogen.
Neue Goldens: `UPDATE_GOLDENS=1 npx vitest run packages/templates`, danach jedes Bild ansehen.
`3d-product-showcase` rendert über Chromium (SwiftShader); dafür gilt eine größere Toleranz.
