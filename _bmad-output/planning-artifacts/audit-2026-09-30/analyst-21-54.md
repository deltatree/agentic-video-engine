# Audit Auftrag §21–54 ohne §25–27 (Mary, Analyst) – 2026-09-30

Belastbar umgesetzt: CLI (12 Befehle, --json), 15 Templates, 29 Komponenten, Themes, Color Management, Doctor, Lizenz/SBOM, Docker, K8s-Basis, OTel, Sandbox, Benchmarks.

| § | Befund | Beleg | Schwere |
|---|---|---|---|
| 32 | registerCodec/Exporter/StudioPanel/AgentTool/AssetLoader füllen Maps, die niemand liest | core/src/registry.ts:170-176,250-257 | hoch |
| 32 | settings.plugins im Schema, nie ausgewertet; registry.use() nie aufgerufen; keine Plugin-Doku | schema/src/project.ts:307; core/src/registry.ts:241 | hoch |
| 33 | importers/anime/motion-canvas-adapter ohne Einstieg über CLI/API/MCP/Studio; undokumentiert | – | mittel |
| 23 | Cache-Ebenen font/compiled/geometry/shader/encoding nie beschrieben | cache/src/cache.ts:9 | mittel |
| 22 | Docker-Runner nicht über CLI/Services erreichbar | cli/src/services.ts:12,170; scheduler/src/docker-runner.ts:88 | mittel |
| 22/24 | Kein Chunk-Timeout im Pool/Docker-Runner | scheduler/src/pool.ts:198; docker-runner.ts:48-80 | mittel |
| 24 | Keine GPU-Quota im Docker-Runner | docker-runner.ts:48-80 | niedrig |
| 45/22 | Chromium immer SwiftShader; GPU-Worker beschleunigen nur NVENC; keine ADR | renderer-browser/src/host.ts:30; Dockerfile:160-168 | mittel |
| 45 | Kein GPU-Autoscaling-Trigger | deploy/k8s/base/autoscaling.yaml | mittel |
| 45 | API/Koordinator/Studio/S3 replicas 1, Recreate; kein HA-Overlay | deploy/k8s/base/*.yaml | mittel |
| 46 | gpu_memory nie gesetzt; Cache-Hits nur frame/layer | telemetry/src/index.ts:59,165,201 | mittel |
| 38 | Baseline-Vergleich nur fps, nicht in CI | benchmarks/src/baseline.ts:65,88-111 | mittel |
| 36/37 | Docker-Worker-Test in CI immer übersprungen | scheduler/test/docker.test.ts:14,83 | mittel |
| 36 | Keine Performance-Tests im Gate | ci.yml | niedrig |
| 40 | Texturgröße gegen GPU-Maximum wird nicht geprüft, kein Downscaling (Beispiel aus Auftrag) | renderer-three/src | mittel |
| 40 | Rohe new Error(...) in Pixi/Three-Assets/Audio-Engine | renderer-pixi/src/renderer.ts:14; renderer-three/src/assets.ts:101; render/src/audio-engine.ts:118 | niedrig |
| 47 | `dev` ohne Datei-Watcher und Live-Update; --open wird ignoriert | cli/src/cli.ts:241,541-549 | hoch |
| 42 | licenses --check prüft nicht Aktualität der Inventare; Blender im Image als „not bundled“ | scripts/licenses.mjs; licenses.json:1032 | mittel |
| 48 | Kein Root-AGENTS.md; docs/api nicht eingecheckt | – | niedrig |
| 34 | apps/playground, apps/docs fehlen (Auftrag: „beispielsweise“) | – | niedrig |
| 21 | Keine explizite Dependency-Graph-Stufe | core/src/frame-key.ts | niedrig |
| 49 | Modul-Singletons (Telemetrie, ffmpeg-Capabilities) | telemetry/src/index.ts:106; ffmpeg/src/capabilities.ts:146 | niedrig |
| 37 | Branch Protection nicht als Code nachweisbar | – | niedrig |
