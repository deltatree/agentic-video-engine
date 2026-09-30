# Abschließendes Review (Quinn) – e4bb4cd..HEAD

Kein Blocker. trustProxy, Docker --gpus, Codec-Allowlist, Panel-CSP, Hostdienste: ohne Befund.

| # | Schwere | Befund |
|---|---|---|
| M1 | major | Output-Cache (encoding) ohne Transkripte/ASR-Modell im Schlüssel → veraltete Untertitel (render/src/video.ts:301) |
| M2 | major | Output-Schlüssel ohne Runner-Fingerabdruck (Docker-Image, --gpus, browserGpu, Koordinator) (video.ts:416-419) |
| M3 | major | Gecachte Grafik-Probe vs. Live-Entscheidung auf der Render-Seite (renderer-three/src/renderer.ts:117); Fehl-Probe dauerhaft gespeichert (lazy.ts:200-251, webgpu-probe.ts:76); gleiches Muster three-max-texture |
| M4 | major | Studio: Endlosschleife ohne Backoff, wenn Nachlesen der Datei scheitert (apps/studio/src/store.ts:454-466, 779-790) – PoC 316 Anfragen/500 ms |
| m1 | minor | fromAudio-prepare: ein gemeinsamer Transkript-Zustand für alle Revisionen (node-env.ts:399-419) |
| m2 | minor | Plugin-Code-Hash und allowHtmlScripts fehlen in versions/Schlüsseln |
| m3 | minor | hardware:auto – gewählter Encoder nicht im Output-Schlüssel |
| m4 | minor | restoreOutput: ENOENT nach parallelem Prune bricht ab statt Fehlgriff |
| m5 | minor | Schwache Tests: encoding-Negativtests; Backoff-Test ohne Anfangs-Revision |
