# @agentic-video/render

Render-Pipeline: Frame-Render, Compositing, Frame-Cache, Audio, Encoding, Render-Manifest.

`createNodeEnvironment` lädt die Plugins aus `settings.plugins` (Story 21.1, ADR 0012), bevor es die Assets auflöst: nur mit `trusted` oder `OPENVIDEO_ALLOW_PLUGINS=1`, Rechte nur ausdrücklich (`plugins.permissions` bzw. `OPENVIDEO_PLUGIN_PERMISSIONS`). Codecs (`codec: 'plugin:<id>'`) und Exporter (`format: 'plugin:<id>'`) wirken im Encoder, Asset Loader in der Asset-Pipeline; siehe [docs/guide/plugins.md](../../docs/guide/plugins.md).

## Manifest, Cache-Ebene `encoding` und GPU (Epic 21)

- **Render-Manifest** (Story 21.5): `renderBackend` nennt die tatsächlich genutzten Backends (aus den Frame-Plänen), nicht alle registrierten. `chromiumVersion` ist die tatsächliche Version aus `browser.version()` (lokal oder vom Worker), sonst eine Begründung. `gpu` kommt aus `probeHostGpu` (`nvidia-smi`, `/dev/dri`). `graphics` nennt Grafik-Modus, WebGL2-Renderer, WebGPU-Adapter und die gewählten Three.js-Backends; `voiceHashes` die Cache-Schlüssel erzeugter Stimmen; `cache.output` den Ausgabe-Cache.
- **Kurzmanifest** für Einzelbilder: `buildFrameManifest(env, project, frames, scale)`; `frame.render`, `frame.renderMany` und `preview.contactSheet` liefern es als `manifest`.
- **Hardware-Encoding ist Opt-in:** ohne `hardwareAcceleration` kodiert FFmpeg auf der CPU (gleiche Bytes auf jeder Maschine).
- **Cache-Ebene `encoding`** (Story 21.2, ADR 0021): Ein wiederholter identischer Render liefert die Bytes der früheren Kodierung. Abschalten mit `reuseOutput: false` oder `OPENVIDEO_OUTPUT_CACHE=0`. Kodierte Segmente werden nicht wiederverwendet: mit x264 wäre das Ergebnis nicht bitgleich. Der Schlüssel (Version `output-2`, abschließendes Review M1/M2) enthält:
  - die Frame-Schlüssel **aller** Ausgabe-Frames (reine Auswertung nach `prepare`, ohne Rendern; sie tragen die expandierte Szene samt Untertiteltext aus Transkripten, Versionen und Asset-/Font-Hashes),
  - den Hash der Tonspur,
  - die Encoder-Einstellungen inklusive Threads,
  - bei `hardware` ≠ `none` die verfügbaren Hardware-Encoder (`MediaTools.hardwareEncoders`; die Wahl bei `auto` hängt nur von Profil, Codec und diesen Encodern ab),
  - den Fingerabdruck des Runners: ohne `runChunks` `{ kind: 'local' }`, sonst der mit `describeChunkRunner(runner, fingerprint)` angehängte (abzufragen mit `chunkRunnerFingerprint`); die CLI beschreibt Worker-Prozesse und Docker (Image, GPUs, Browser-GPU, Befehl),
  - sowie Projekt-Hash, Assets, Versionen, Vertrauensmodus, Composition, Bereich, Ausgabegröße und Profil.

  Der Ausgabe-Cache ist **aus** (`cache.output: off`) für entfernte Worker (`OPENVIDEO_COORDINATOR_URL`; ihre Versionen sind erst beim Rendern bekannt, Fingerabdruck `null`), für Runner ohne Beschreibung (eigene Integrationen), bei `hardware` ≠ `none` ohne Auskunft über Hardware-Encoder (`hardwareEncoders` fehlt) und für Bildfolgen. Das Auswerten aller Frame-Schlüssel misst die Manifest-Stufe `outputKey`.
- **Telemetrie:** Jede Cache-Ebene meldet Treffer und Fehlgriffe (`cache_hits`/`cache_misses`, Attribut `tier`); `gpu_memory` wird gesetzt, wenn eine NVIDIA-GPU erkannt ist.
- **Browser-GPU** (Story 21.4, ADR 0019): `OPENVIDEO_BROWSER_GPU=1` bzw. `createNodeEnvironment({ browserGpu: true })` startet Chromium mit nativem ANGLE; der Modus steht in den Versionen (Cache-Schlüssel) und im Manifest. Projekte mit `scene3d` kennen das Ergebnis der Grafik-Probe beim Anlegen der Umgebung (`three-webgpu`, `three-max-texture` im Schlüssel); es liegt je Chromium-Version und Schaltern in der Cache-Ebene `layer`, sodass Chromium nur ohne Treffer startet (Politur P1).
- **fromAudio-Transkripte** löst `env.prepare(project)` auf – beim ersten Frame und immer, wenn sich die Deklarationen ändern; das Anlegen der Umgebung wartet nicht auf ASR.
