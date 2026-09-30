# ADR 0021: Genutzte Cache-Ebenen – `compiled` und `encoding` statt `font`, `geometry`, `shader`

- Status: angenommen
- Datum: 2026-09-30

## Kontext

`@agentic-video/cache` führte die Ebenen `asset`, `font`, `composition`, `frame`, `layer`, `geometry`, `shader`, `audio` und `encoding`. Genutzt wurden nur `asset`, `frame`, `layer` und `audio`; an die Telemetrie meldeten nur `frame` und `layer` Treffer (Audit 2026-09-30, §23, §46). Entscheidung T7 im Epic-Plan: `compiled` und `encoding` werden genutzt, `font`, `geometry` und `shader` entfallen.

Zur Ebene `encoding` war zu prüfen, ob kodierte Segmente (Chunks) wiederverwendet und per Concat zu einer Datei zusammengesetzt werden können, die **bitgleich** zur Direktkodierung ist. Versuch mit FFmpeg 6.1/libx264 (60 Frames, `-g 30 -sc_threshold 0`, zwei Segmente à 30 Frames, Concat per Bytestrom):

- Standardeinstellungen: Direktkodierung und Concat unterscheiden sich (anderer SHA-256, andere Größe). Rate-Control (CRF mit MB-Tree und Lookahead) sieht bei der Direktkodierung über die Segmentgrenze hinweg; jedes Segment beginnt außerdem mit eigenem SPS/PPS und SEI.
- Auch mit `rc-lookahead=0:mbtree=0:bframes=0:open-gop=0:scenecut=0` bleiben die Bytes verschieden: Der Zustand der Rate-Control läuft bei der Direktkodierung über die Grenze weiter.

Bitgleiche Segment-Wiederverwendung ist mit x264 also nicht möglich, ohne die Direktkodierung selbst zu ändern (und damit alle bisherigen Ausgaben).

## Entscheidung

- **Ebenen:** `asset`, `compiled`, `frame`, `layer`, `audio`, `encoding`. `font` (Fonts sind Assets und liegen in `asset`), `geometry` und `shader` (leben im Browser-Prozess, billig) sowie die nie genutzte Ebene `composition` entfallen.
- **`compiled`:** Compiler-Output (IR und SDK-Diagnosen) von `compileTsx`. Schlüssel: SHA-256 über die Compiler-Version (`@agentic-video/compiler`, esbuild, Eintragsformat) und den Code des Bündels, das alle importierten Quellen samt SDK enthält. Ein Treffer spart die Auswertung in der Sandbox; die Validierung läuft immer neu. Beschädigte Einträge gelten als Fehlgriff.
- **`encoding`:** **keine** Segment-Wiederverwendung (nicht bitgleich, siehe oben). Die Ebene speichert die **ganze Ausgabe** eines Renders: Schlüssel über Projekt-Hash, Composition, Asset-Hashes, alle Versionen (Renderer, Grafik-Modus, FFmpeg …), Bereich, Ausgabegröße, Profil, Encoder-Einstellungen (inklusive Threads und Hardware) und den Hash der Tonspur. Ein Treffer liefert die Bytes der früheren Kodierung, ohne zu rendern oder zu kodieren; Frame-Hashes, Chunks, genutzte Backends und Diagnosen kommen aus dem Eintrag. Die Bytes werden beim Lesen gegen ihren SHA-256 geprüft. Nur für Formate mit genau einer Datei; abschaltbar mit `reuseOutput: false` bzw. `OPENVIDEO_OUTPUT_CACHE=0`. Das Manifest nennt `cache.output` (`hit`, `miss`, `off`).
- **Telemetrie:** `Cache.observe` meldet jeden Treffer und Fehlgriff einer Ebene; `createNodeEnvironment` leitet sie an `cache_hits`/`cache_misses` (Attribut `tier`) weiter. `frame` und `layer` meldet `renderFrame` selbst (auch Treffer im Arbeitsspeicher), darum zählt der Beobachter sie nicht doppelt.

## Folgen

- Ein wiederholter identischer Render kostet nur Audio-Mischung (selbst im Cache) und das Kopieren der Datei. Die Datei ist bitgleich zur Direktkodierung, weil sie genau diese ist.
- Ändert sich irgendeine Eingabe (auch nur ein Frame), wird die ganze Ausgabe neu kodiert; die Frames selbst kommen weiter aus dem Frame-Cache.
- Der Schlüssel der Ausgabe hängt wie die Frame-Schlüssel an den gemeldeten Versionen. Was dort fehlt (z. B. die Freigabe von HTML-Skripten), unterscheidet auch die Ausgabe nicht.
- Alte Einträge unter `font/`, `geometry/`, `shader/` und `composition/` räumt `openvideo cache clear` ohne `--tier` mit auf (Politur P1); `--tier shader` usw. löscht gezielt eine alte Ebene. `stats` und `prune` kennen nur die genutzten Ebenen.
- Die Ebene `compiled` der CLI-Quellen meldet an die Telemetrie der Dienste (`serve`, `dev`, `studio`, `mcp`), wie alle übrigen Ebenen (Politur P1).
- Das Ergebnis der Grafik-Probe des Browser-Renderers (WebGL2, WebGPU, Texturgrenze) liegt in der Ebene `layer`: Es gehört zum Browser-Backend, ist klein und wird neu geprüft, wenn es fehlt (ADR 0019, Politur P1).

## Nachtrag 2026-09-30 (abschließendes Review, M1/M2/m2/m3/m4)

Der Schlüssel der Ebene `encoding` enthielt weder Transkripte (fromAudio-Untertitel, ASR-Modell) noch den Runner, der die Frames rendert, noch die tatsächliche Encoder-Wahl bei Hardware-Encoding. Ein wiederholter Render konnte so veraltete Untertitel oder Bytes einer anderen Maschine liefern.

- **Schlüssel `output-2`:** Hash über (a) die Frame-Schlüssel **aller** Ausgabe-Frames – reine Auswertung nach `prepare`, ohne Rendern; sie enthalten die expandierte Szene (auch Untertiteltext aus Transkripten), Versionen und Asset-/Font-Hashes –, (b) den Hash der Tonspur, (c) die Encoder-Einstellungen inklusive Threads und bei `hardware` ≠ `none` die verfügbaren Hardware-Encoder (`MediaTools.hardwareEncoders`, aus derselben FFmpeg-Probe wie der Encoder), (d) den Fingerabdruck des Runners sowie wie bisher Projekt-Hash, Composition, Bereich, Ausgabegröße und Profil.
- **Hardware:** Die Wahl bei `auto` (und der Rückfall einer ausdrücklichen Familie auf die CPU) ist eine reine Funktion von Profil, Codec und verfügbaren Encodern. Darum stehen die verfügbaren Encoder im Schlüssel statt eines erst beim Kodieren bekannten Namens. Eine Umgebung ohne `hardwareEncoders` nutzt bei `hardware` ≠ `none` keinen Ausgabe-Cache (`cache.output: off`).
- **Runner:** `describeChunkRunner(runner, fingerprint)` hängt einem Runner seinen Fingerabdruck an; ohne Runner gilt `{ kind: 'local' }`. Die CLI beschreibt Worker-Prozesse (`{ kind: 'process' }`) und Docker (`image`, `gpus`, `browserGpu`, Befehl). Entfernte Worker (`OPENVIDEO_COORDINATOR_URL`) melden ihre Versionen erst beim Rendern: Für sie ist der Ausgabe-Cache **aus** (`null`). Unbeschriebene Runner (eigene Integrationen) nutzen ihn ebenfalls nicht. Grenze: Ein veränderliches Image-Tag (`:latest`) steht als Text im Schlüssel, nicht als Digest.
- **Versionen:** `plugin-code:<name>` ist der SHA-256 der tatsächlich geladenen Plugin-Moduldatei (Stand beim ersten Import im Prozess; gehasht wird die Einstiegsdatei, weitere Module eines Plugins nur über dessen Version). `html-scripts: allowed` steht nur mit `allowHtmlScripts`. Beide gehen über `env.versions` in jeden Frame-Schlüssel und über `hostCodeVersions` in jeden Layer-Schlüssel. Ohne Plugins und Skripte fehlen die Einträge: Frame- und Layer-Schlüssel bleiben unverändert. Der Satz „Was dort fehlt (z. B. die Freigabe von HTML-Skripten), unterscheidet auch die Ausgabe nicht“ unter „Folgen“ ist damit erledigt.
- **Transkripte:** `createNodeEnvironment` hält je Stand der `fromAudio`-Deklarationen einen eigenen Satz (höchstens 8, LRU); jede Auswertung liest den Satz ihres eigenen Projekts (Review m1).
- **Paralleles Aufräumen:** Fehlt die Datei eines Eintrags beim Kopieren (`ENOENT`, z. B. nach `prune`), ist das ein Fehlgriff; der Render kodiert frisch (Review m4).

Folge: Alle bisherigen Einträge der Ebene `encoding` sind Fehlgriffe (neuer Schlüssel). Die Auswertung aller Frames vor dem Rendern kostet bei aktivem Ausgabe-Cache eine zusätzliche Szenen-Auswertung je Frame (ohne Rendern, gemessen in der Stufe `outputKey` des Manifests).
