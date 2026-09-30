# ADR 0026: Render-Leistung – parallel, gestreamt und bitgleich

- Status: angenommen
- Datum: 2026-09-30
- Bezug: Audit 2026-09-30 (Architektur 1–12, Analyse 22/24), Epic 18, ADR 0002, ADR 0006, ADR 0007, ADR 0023

## Kontext

Im DoD-Lauf A brauchte ein 4K-Frame rund 14,8 s Worker-Zeit. Der Compositor rechnete jede Gruppe über
das ganze Bild in Float32 (4K: 132,7 MB je Offscreen), `color-grade` legte je Pixel Closures und Arrays an,
Skia reservierte je Layer einen neuen Pixelpuffer und kopierte beim Auslesen zweimal, jeder Layer wurde mit
zlib in den Layer-Cache geschrieben, obwohl animierte Layer im Video nie wieder treffen, Frame-Hashes liefen
in JavaScript, und der Encoder startete erst nach dem letzten Frame. Standard war ein einziger Render-Prozess,
und es gab keinen Abbruch oder Timeout auf Chunk-Ebene.

Alle Optimierungen müssen die Frame-Hashes unverändert lassen (FR-9, ADR 0002).

## Entscheidung

1. **Compositor auf Inhalts-Bounds.** Jedes Zwischenbild trägt die Region, außerhalb derer es nur Nullen
   enthält. Blend, Crop (zeilenweise), Maske (transformiert je Pixel abgetastet statt als Vollbild),
   Reveal, Transform und Farbraum-Umrechnung rechnen nur darin. Offscreens kommen aus einem kleinen Pool.
   Frames aus reinen Bild-Layern komponiert ein einziger Durchlauf ohne Float-Zwischenbild; bei genau einem
   Layer ersetzen Tabellen je Frame (Alpha × Wert) die Float-Rechnung je Pixel. Jede Zwischensumme wird wie
   beim Speichern in Float32 gerundet (`Math.fround`): bitgleich zur alten Rechnung.
2. **Effekte exakt, aber allokationsfrei.** `color-grade` läuft ohne Closures, mit vorab berechneten
   Konstanten und übersprungenen Neutral-Stufen. Die Kurven bleiben exakt gerechnet: Tabellen mit
   Interpolation würden Hashes verändern. Die Vignette cached ihre Kurve (ein Bildviertel, exakt
   symmetrisch).
3. **Layer-Cache nur, wo er trifft.** Zeitinvariante Skia-Layer (Formen, Bilder, SVG, Text ohne
   `textAnimation`) haben einen Schlüssel ohne lokale Zeit und liegen zusätzlich dekodiert im Speicher
   (LRU, 136 MB je Umgebung). Im Video-Render (Layer-Historie je Chunk) werden zeitabhängige Layer weder
   gelesen noch komprimiert, und Layer, deren Schlüssel sich seit dem vorigen Frame geändert hat, nicht
   mehr geschrieben. Skia nutzt ein Zeichenziel je Größe wieder und liest mit einer Kopie aus.
4. **HTML nur im Inhaltsbereich.** Chromium nimmt nur das Rechteck der sichtbaren Container auf (`clip`);
   Container mit `filter`, `box-shadow` oder `outline` erzwingen das ganze Bild. PNGs mit 8-Bit-RGBA
   dekodiert ein schneller Pfad, vormultipliziert wird in place mit einer gemeinsamen Hilfe in `core`.
5. **Native Hashes.** `imageHash` und die Hashes im Scheduler rechnen mit `node:crypto` (gleiche Werte).
6. **Encoding parallel.** Der Encoder startet vor dem Rendern; fertige Chunks gehen in Reihenfolge an ihn,
   lokal ohne Umweg über den Frame-Cache, sonst mit Entpacken im Thread-Pool. Der Encoder nutzt
   standardmäßig fest 4 Threads (Team-Entscheidung im Review: Reproduzierbarkeit der Datei geht vor, §20).
   `OPENVIDEO_ENCODER_THREADS=<n>` setzt eine andere feste Zahl, `OPENVIDEO_ENCODER_THREADS=auto` nutzt die
   freien Kerne (Kerne minus lokale Render-Prozesse, 2–16).
7. **Parallel als Standard.** Ohne `--workers` rendern `openvideo render`, `serve`, `dev`, `studio` und `mcp`
   mit `defaultWorkerCount()` Worker-Prozessen (Kerne − 1, begrenzt durch ein Speicherbudget von 1,5 GB je
   Worker, höchstens 16). Ein einzelner Chunk rendert im eigenen Prozess; `--workers 1` erzwingt das.
8. **Abbruch und Timeout auf Chunk-Ebene.** `ChunkRunner` bekommt ein Abbruch-Signal. Pool (Prozess,
   Docker) schickt `cancel`, der Remote-Runner `DELETE /v1/jobs/<id>`; HTTP-Worker hören bei verlorener
   Lease auf. `chunkTimeoutMs` beendet hängende Worker und wiederholt den Chunk.
9. **Grenzen.** `OPENVIDEO_CACHE_MAX_BYTES` räumt nach jedem Video-Render per LRU auf. SkSL-Kompilate sind
   ein LRU mit 64 Einträgen. `Intl.Segmenter` nutzt die feste Locale `und`.

## Folgen

- Frame-Hashes der Goldens und der Benchmark-Szenen sind unverändert; Äquivalenztests vergleichen den
  Compositor Byte für Byte mit dem Stand vor Epic 18 (`packages/compositor/test/reference/`).
- Die **Bytes der Videodatei** hängen von der Encoder-Threadzahl ab (x264 teilt die Arbeit je Thread
  anders auf). Darum ist der Standard fest 4 Threads: Die Datei ist über Maschinen hinweg bitgleich.
  `auto` ist ein bewusstes Opt-in für schnelleres Encoding; dann sind nur noch die Frame-Hashes über
  Maschinen gleich. Das Manifest nennt die Threads in `encoder.args`.
- Worker-Prozesse brauchen Startzeit (Node, Skia, Chromium); kurze Renders mit einem Chunk bleiben im
  Prozess. Mehrere Worker brauchen mehr Arbeitsspeicher; das Budget begrenzt ihre Zahl.
- Ein kleiner Pool hält bis zu zwei Float-Offscreens je Prozess (4K: 265 MB) und der Speicher-LRU der
  Layer bis zu 136 MB je Umgebung.
- Die Region-Invariante ist eine neue Pflicht für Compositor-Code: Jede neue Operation muss Nullen außerhalb
  der Region erhalten oder die Region neu bestimmen (`scannedRegion`).
