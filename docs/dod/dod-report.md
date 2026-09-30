# Definition-of-Done-Bericht (full)

Ergebnis: **bestanden**

- Video: 3840×2160, 60 s, 30 fps, Stimme espeak-ng
- Rechner: 16 × Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz, 63 GiB, Node v22.23.3, linux x64, keine GPU
- Gesamtlaufzeit: 16112.382 s

## Die 21 Bestandteile

| # | Bestandteil | Fundstelle | Umsetzung |
|---|---|---|---|
| 1 | animiertes Intro | node grade › scene-intro (type group)<br>node grade › scene-intro › intro-logo .scale (type svg) | Szene 0–15 %: Logo mit Feder-Animation, Titel Zeichen für Zeichen |
| 2 | professionelle Typografie | node grade › scene-intro › intro-title .textAnimation (type text)<br>node grade › scene-intro › intro-tagline .letterSpacing (type text) | Inter 800/500, Tracking, OpenType-Features, JetBrains Mono |
| 3 | SVG Logo | node grade › scene-intro › intro-logo .asset (type svg)<br>node grade › scene-outro › outro-logo (type svg) | Asset logo (image/svg+xml) |
| 4 | 2D Motion Graphics | node grade › scene-motion › motion-wave .trimEnd (type path)<br>node grade › scene-motion › motion-hexagon (type polygon)<br>node grade › scene-motion › motion-orbit .motionPath (type ellipse) | Pfad mit Trim, Polygon mit Expression, Bewegungspfad, Federn |
| 5 | Datenvisualisierung | node grade › scene-data › data-bars .component (type component)<br>node grade › scene-data › data-line (type component) | BarChart und LineChart |
| 6 | HTML/CSS UI Animation | node grade › scene-motion › ui-card .css (type html) | html-Node, CSS-@keyframes auf virtueller Zeit |
| 7 | Three.js 3D Szene | node grade › scene-3d › stage (type scene3d) | scene3d (Three.js, WebGL2/SwiftShader) |
| 8 | glTF Modell | node grade › scene-3d › stage › gem .asset (type model3d) | model3d mit Clip "spin" aus product.glb |
| 9 | Kameraanimation | node grade › scene-3d › stage › cam .position (type camera3d) | camera3d mit Keyframes |
| 10 | Licht | node grade › scene-3d › stage › light-key (type light3d)<br>node grade › scene-3d › stage › light-rim (type light3d)<br>node grade › scene-3d › stage › light-ambient (type light3d) | directional, point, ambient |
| 11 | Partikel | node grade › scene-3d › stage › sparks (type particles3d)<br>node grade › scene-intro › intro-particles (type particles) | particles3d und particles (2D) |
| 12 | Shader/Postprocessing | node grade › scene-intro › intro-shader .sksl (type shader)<br>node grade › scene-3d › stage .postprocessing (type scene3d) | SkSL-Hintergrund, Bloom und Vignette in 3D |
| 13 | eingebettetes Video | node grade › scene-media › media-video .asset (type video) | video-Node mit clip.mp4 |
| 14 | Bilder | node grade › scene-media › media-photo .asset (type image) | image-Node mit photo.png, Ken-Burns-Zoom |
| 15 | Voiceover | track voice (audio/voiceover, 6 Einträge)<br>audio vo-intro (voice espeak-ng) | Sprachsynthese (voice-Quelle) auf Spur voice |
| 16 | Musik | track music-track (audio/music, 1 Einträge) | music.wav mit Ducking unter der Stimme |
| 17 | Soundeffekte | track sfx (audio/sfx, 5 Einträge) | whoosh.wav an jedem Szenenwechsel |
| 18 | animierte Untertitel | node captions .style (type subtitles)<br>track subs (subtitle, 6 Einträge) | subtitles-Node, Stil word-highlight |
| 19 | Übergänge | node grade › scene-motion .transition (type group)<br>node grade › scene-data .transition (type group) | slide, wipe, iris, zoom, blur, fade |
| 20 | Color Grading | node grade .effects (type layer) | layer mit color-grade und vignette über allen Szenen |
| 21 | Outro | node grade › scene-outro (type group) | Szene 85–100 % mit Logo, Titel, URL, Ausblendung |

## Ablauf

| Schritt | Operation | Laufzeit (s) |
|---|---|---|
| 1 | assets.generate | 0 |
| 2 | project.create | 0.667 |
| 3 | asset.import | 0.668 |
| 4 | composition.patch (build) | 0.841 |
| 5 | composition.validate | 0.038 |
| 6 | frame.render + frame.inspect | 81.558 |
| 7 | composition.patch (targeted) | 0.014 |
| 8 | frame.render (after patch) | 25.134 |
| 9 | video.render (A) | 4878.545 |
| 10 | project.create (B) | 0.593 |
| 11 | asset.import (B) | 0.688 |
| 12 | project.update (B) | 0.795 |
| 13 | video.render (B) | 11115.368 |

## Gezielte Änderung

Patch: `setProperty intro-title.fill = #FFD23F`. Danach wurden dieselben Frames neu gerendert.

| Szene | Frame | geändert | erwartet | aus Cache |
|---|---|---|---|---|
| intro | 135 | ja | ja | nein |
| motion | 441 | nein | nein | ja |
| data | 765 | nein | nein | ja |
| media | 1035 | nein | nein | ja |
| three | 1350 | nein | nein | ja |
| outro | 1665 | nein | nein | ja |

## Reproduktion auf einem zweiten Worker

Server B hat einen eigenen, leeren Workspace und Cache und rendert mit 2 Worker-Prozessen. Er bekam dieselbe IR und dieselben Assets.

- Frames: A 1800, B 1800
- Frame-Hashes gleich: **ja**
- Hash der Frame-Hash-Liste: A `sha256:2715a98cc13dff960cffc843f2a12833f96728b8f25c07ff66712a72f3aaedb1`, B `sha256:2715a98cc13dff960cffc843f2a12833f96728b8f25c07ff66712a72f3aaedb1`
- Chunks A: 0–60 (process-1.0), 60–120 (process-2.0), 120–180 (process-3.0), 180–240 (process-4.0), 240–300 (process-5.0), 300–360 (process-6.0), 360–420 (process-6.0), 420–480 (process-5.0), 480–540 (process-6.0), 540–600 (process-3.0), 600–660 (process-4.0), 660–720 (process-2.0), 720–780 (process-5.0), 780–840 (process-1.0), 840–900 (process-6.0), 900–960 (process-1.0), 960–1020 (process-6.0), 1020–1080 (process-4.0), 1080–1140 (process-3.0), 1140–1200 (process-2.0), 1200–1260 (process-5.0), 1260–1320 (process-1.0), 1320–1380 (process-6.0), 1380–1440 (process-4.0), 1440–1500 (process-3.0), 1500–1560 (process-5.0), 1560–1620 (process-2.0), 1620–1680 (process-2.0), 1680–1740 (process-1.0), 1740–1800 (process-6.0)
- Chunks B: 0–60 (process-1.0), 60–120 (process-2.0), 120–180 (process-2.0), 180–240 (process-1.0), 240–300 (process-2.0), 300–360 (process-1.0), 360–420 (process-1.0), 420–480 (process-2.0), 480–540 (process-1.0), 540–600 (process-2.0), 600–660 (process-1.0), 660–720 (process-2.0), 720–780 (process-1.0), 780–840 (process-2.0), 840–900 (process-2.0), 900–960 (process-2.0), 960–1020 (process-1.0), 1020–1080 (process-2.0), 1080–1140 (process-1.0), 1140–1200 (process-2.0), 1200–1260 (process-1.0), 1260–1320 (process-1.0), 1320–1380 (process-2.0), 1380–1440 (process-1.0), 1440–1500 (process-2.0), 1500–1560 (process-1.0), 1560–1620 (process-2.0), 1620–1680 (process-2.0), 1680–1740 (process-1.0), 1740–1800 (process-2.0)
- Video-Datei byte-gleich: ja (A `sha256:8c4e572d6b3b6a039eebde31dbacdea599224706efad732bd7ddafc4b8c32f18`, B `sha256:8c4e572d6b3b6a039eebde31dbacdea599224706efad732bd7ddafc4b8c32f18`)
- Backends: skia, browser, three, pixi, blender

