# Podcast Clip

Quadratisches Audiogramm: Die Balken folgen den Amplituden eines Test-Tons als Keyframes. Dazu Zitat, Host und Gast, Fortschritt.

| Eigenschaft | Wert |
|---|---|
| Größe | 1080 × 1080 |
| Bildrate | 30 fps |
| Dauer | 12s |

## Anpassen

- Texte: `COPY`.
- Eigene Amplituden: in `src/waveform.ts` die Liste ersetzen (RMS je Frame, 0..1) und die erste Kommentarzeile löschen. Sonst erzeugt der Build die Datei neu.
- Audio: `<AudioTrack><AudioClip src="./episode.mp3" /></AudioTrack>` ergänzen.
- Farben: `settings.theme` austauschen, z. B. `THEMES.light` aus `@agentic-video/components`. Die Farben lesen Theme-Tokens (Ausnahmen stehen im Code als feste Farbe, z. B. weiße Schrift auf `primary`).

## Dateien

- `src/video.tsx`: Quellcode (SDK und Komponenten).
- `project.json`: daraus kompilierte IR. Für Nutzer ohne Compiler.
- `template.json`: Titel, Beschreibung, Schlagworte.

## Neu bauen

Nach jeder Änderung an `src/` die IR neu erzeugen:

```bash
node packages/templates/scripts/build-templates.mjs podcast-clip
```
