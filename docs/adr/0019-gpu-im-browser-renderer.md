# ADR 0019: GPU im Browser-Renderer – SwiftShader als Standard, nativer ANGLE als Opt-in

- Status: angenommen
- Datum: 2026-09-30

## Kontext

Der Browser-Renderer (`html`, `three`, `pixi`) startete Chromium fest mit `--use-angle=swiftshader`. WebGL und WebGPU liefen so immer auf der CPU. GPU-Worker beschleunigten nur NVENC (Audit 2026-09-30, §1/9/12, §22, §45). Eine ADR fehlte. Außerdem standen weder der Grafik-Modus noch die WebGPU/WebGL2-Wahl von `three` im Cache-Schlüssel oder im Manifest (§12, §20).

SwiftShader rechnet auf jeder Maschine gleich; Frames sind bitgleich und Golden-Tests stabil. Echte GPUs rastern je Treiber und Hardware anders. Ihre Ergebnisse sind nicht bitgleich zu SwiftShader und untereinander nicht garantiert gleich.

## Entscheidung

- **Standard bleibt SwiftShader.** Ohne Einstellung startet Chromium wie bisher (`--use-angle=swiftshader`, `--enable-unsafe-swiftshader` nur für WebGL-/WebGPU-Layer).
- **Opt-in `OPENVIDEO_BROWSER_GPU=1`** (Option `gpu` am Host, `browserGpu` an `createNodeEnvironment`): Chromium startet mit nativem ANGLE (`--use-angle=default --ignore-gpu-blocklist --enable-gpu`). `--enable-unsafe-swiftshader` entfällt; WebGPU bleibt hinter `--enable-unsafe-webgpu`. HTML rastert weiter auf der CPU (`--disable-gpu-rasterization`), damit HTML-Layer in beiden Modi gleich bleiben. Chromium bekommt im GPU-Modus zusätzlich die Variablen der Treiber (`NVIDIA_*`, `VK_*`, `__EGL_*`, `DISPLAY` …), nie Tokens.
- **Getrennte Cache-Schlüssel.** Im GPU-Modus steht `browser-gpu: native` in den Versionen der Browser-Backends und damit in jedem Frame- und Layer-Schlüssel. Im Standardmodus fehlt der Eintrag; bestehende Schlüssel bleiben gültig.
- **WebGPU/WebGL2-Wahl im Schlüssel.** Enthält ein Projekt `scene3d`, steht die Grafik-Probe vor dem ersten Schlüssel fest: Chromium startet mit Grafik-Schaltern und prüft auf der Render-Seite `MAX_TEXTURE_SIZE` und WebGPU per Mini-Render auf dem Pfad von Three.js (`probeWebGPU`: Gerät, Textur, Ansicht mit dem Deskriptor von Three.js, Render-Pass, Rücklesen; ein Adapter allein reicht nicht, Politur P1). Das Ergebnis liegt je Chromium-Version, Schaltern, Modus und – im GPU-Modus – Host-GPU in der Cache-Ebene `layer`; mit Treffer startet beim Anlegen der Umgebung kein Chromium. Das `three`-Backend trägt dann `three-webgpu` (`available`/`unavailable`) und `three-max-texture`. So hängt `backend: 'auto'` (WebGPU oder WebGL2) und die Texturverkleinerung (`textureDownscale`) nie still von der Maschine ab. Die Regel für `auto` ist die reine Funktion `threeBackendFor` in `@agentic-video/renderer-three`, die auch der Renderer nutzt.
- **Manifest.** `graphics.browserGpu`, `graphics.webgl2` und `graphics.webgpu` (Renderer bzw. Adapter oder Begründung) und `graphics.threeBackends` (tatsächlich gewählte Backends der gerenderten `scene3d`-Nodes). Die GPU des Hosts (`gpu`) kommt aus derselben Probe wie `openvideo doctor` (`probeHostGpu`: `nvidia-smi`, sonst `/dev/dri`).
- **Container.** Der Docker-Runner reicht `--gpus` und `OPENVIDEO_BROWSER_GPU=1` in den Worker-Container (Story 21.3); das Image `openvideo-render-gpu` setzt `NVIDIA_DRIVER_CAPABILITIES` mit `graphics`. In Kubernetes setzt die Basis `OPENVIDEO_BROWSER_GPU=1` am Deployment `worker-gpu` (nur dort, nicht in der ConfigMap): Jobs der Queue `gpu` rendern WebGL/WebGPU auf der GPU und cachen unter eigenen Schlüsseln (Politur P1, geprüft von `deploy/test/check-manifests.py`).

## Folgen

- GPU-Renders sind schneller für WebGL/WebGPU, aber nicht bitgleich zu CPU-Renders und nicht zwischen GPU-Modellen. Golden-Tests laufen weiter im Standardmodus.
- Findet Chromium im GPU-Modus keine nutzbare GPU, fällt es selbst auf SwiftShader zurück. Das Manifest zeigt das ehrlich (`graphics.webgl2` nennt dann SwiftShader); der Cache-Schlüssel bleibt der des GPU-Modus.
- Projekte mit `scene3d` zahlen einen Browserstart beim Anlegen der Umgebung nur, solange die Grafik-Probe für diese Chromium-Version und Schalter nicht im Cache liegt (Politur P1). Ihre Schlüssel bleiben ehrlich und stabil.
- Ohne eigenen Chromium-Pfad steht die zu playwright-core gehörende Version im Schlüssel (unverändert); mit `OPENVIDEO_CHROMIUM` die tatsächliche Version aus `chrome --version` (einmal je Pfad, ohne Browserstart), sonst ein Fingerabdruck der Programmdatei.
- Worker-Prozesse lesen nur `OPENVIDEO_BROWSER_GPU`; die programmatische Option gilt nur im eigenen Prozess.
