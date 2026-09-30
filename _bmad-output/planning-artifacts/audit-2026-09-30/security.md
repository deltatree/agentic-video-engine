# Audit Security – 2026-09-30

Fixes vom 28.09. greifen stichprobenartig (SSRF/DNS-Pinning, safeRealPath, Token/Loopback, Sandbox, PSS restricted, NetworkPolicy, Digests).

| # | Befund | Beleg | Schwere |
|---|---|---|---|
| H1 | HTML-Skripte laufen im API-Pod: htmlScriptsAllowed = true sobald OPENVIDEO_CONTAINER_IMAGE gesetzt (immer im Image); Chromium fällt still auf chromiumSandbox:false zurück; Regex-Guard nur Hinweis | cli/src/services.ts:54-57,92; renderer-browser/src/host.ts:250-266,31-32; agent/src/guards.ts:14; deploy/docker/Dockerfile:109,147 | hoch |
| H2 | Worker mit S3-Admin-Schlüsseln, Ergebnis-Keys ungeprüft übernommen, /v1/complete ohne Lease → Frame-Vergiftung | deploy/k8s/base/object-storage.yaml:36; workers.yaml; render/src/video.ts:194-228; scheduler/src/coordinator.ts:421-434 | hoch |
| M1 | Ein Token für API, Worker und KEDA; keine Rollen | coordinator.ts:372-398; autoscaling.yaml:15 | mittel |
| M2 | Koordinator-DoS: Body bis 512 MiB gepuffert, jobs-Map/Journal unbegrenzt | coordinator.ts:148-162,192; coordinator.yaml:92 | mittel |
| M3 | ffmpeg ohne -protocol_whitelist in decodeAudio, normalizeWav, Encoder-Audio-Input | audio/src/decode.ts:82-90; speech/src/wav.ts:76; ffmpeg/src/encoder.ts:338 | mittel |
| M4 | Koordinator ohne Token offen auf 0.0.0.0; Platzhalter-Tokens akzeptiert | deploy/docker/coordinator.mjs:38-46; coordinator.ts:467; deploy/k8s/base/secret.yaml | mittel |
| M5 | Actions nicht per SHA gepinnt; Downloads ohne Prüfsumme | .github/workflows/ci.yml:24-48; images.yml:23-35 | mittel |
| N1 | Blender/FFmpeg/Chromium erben ganze Umgebung | renderer-blender/src/backend.ts:177 | niedrig |
| N2 | Studio-Manifest empfiehlt ?token= | deploy/k8s/base/studio.yaml:2 | niedrig |
| N3 | Studio ohne CSP/frame-ancestors | cli/src/cli.ts:147 | niedrig |
| N4 | Chromium-Download im Image ohne Prüfsumme | Dockerfile:141 | niedrig |
| N5 | Koordinator Klartext-HTTP; CNI-Voraussetzung für NetworkPolicy undokumentiert | workers.yaml:35; deploy/README.md | niedrig |
| N6 | Regex-Guard umgehbar (Entities) | agent/src/guards.ts:14 | niedrig (mit H1 relevant) |
