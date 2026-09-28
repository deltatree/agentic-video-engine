---
title: 'Docker-Images und Kubernetes (Stories 14.3, 14.4)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-e10-scheduler-worker.md'
  - '{project-root}/packages/cli/src/cli.ts'
  - '{project-root}/docs/adr/0008-nicht-vertrauenswuerdiger-code-nur-im-container.md'
  - '{project-root}/.github/workflows/ci.yml'
---

## Intent

**Problem:** OpenVideo braucht offizielle, reproduzierbar gebaute Images (A44) und produktionsfähige Kubernetes-Deployments mit Autoscaling (A45, FR-90, FR-91).

**Approach:** `deploy/docker/` mit einem mehrstufigen Build, `deploy/k8s/` mit Kustomize (Basis + Overlays). Test: lokaler Kubernetes-Cluster mit `kind` (Binärdateien ohne sudo nach `~/.local/bin` laden, Prüfsummen prüfen).

## Boundaries & Constraints

**Always:**
- Ordner: `deploy/`, dazu `.github/workflows/images.yml` (neue Datei; `ci.yml` nicht ändern). Pakete nicht ändern. Brauchst du etwas im Code (z. B. eine Umgebungsvariable), nenne es im Bericht.
- Registry: `ghcr.io/deltatree/openvideo-<name>` (D-Entscheidung Q9). Tags: Version aus `package.json` plus Git-SHA.
- Reproduzierbar: Basis-Images per Digest gepinnt (`node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4`), apt über `snapshot.debian.org` mit festem Datum, `SOURCE_DATE_EPOCH`, `npm ci` mit Lockfile, Blender-Archiv mit SHA256. Versionen stehen als Labels (`org.opencontainers.image.*`, `io.openvideo.*`).
- Sicherheit (A24, ADR 0008): Nicht-Root-Nutzer (UID 65532), read-only Root-FS möglich (Schreibpfade nur `/tmp`, `/cache`), keine Capabilities nötig, `OPENVIDEO_CONTAINER_IMAGE` gesetzt (erscheint im Render-Manifest).
- Der Worker-Code (`packages/worker`, Befehl `openvideo-worker`) und der Koordinator (`startCoordinator` in `packages/scheduler`) entstehen parallel in einer anderen Story. Prüfe mit `ls packages/worker/src packages/scheduler/src`. Fehlen sie, baue zuerst alles andere und warte dann (in Abständen erneut prüfen), bevor du die Worker- und Kubernetes-Tests fährst.

## Anforderungen

### Images (`deploy/docker/Dockerfile`, Ziele per `--target`)
- `base`: Node 22, Anwendung (gebaute `dist`, Produktions-`node_modules`), Schriften, Nutzer, Einstieg `openvideo`.
- `render-cpu`: `base` + FFmpeg (Debian 13, 7.1) + Chromium mit Abhängigkeiten (Playwright, Version passend zu `playwright-core`).
- `render-gpu`: wie `render-cpu`, vorbereitet für NVIDIA (`NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics`, `NVIDIA_VISIBLE_DEVICES=all`), FFmpeg mit NVENC-Unterstützung (Debian-Build lädt `libnvidia-encode` zur Laufzeit).
- `blender`: `render-cpu` + Blender 4.2.23 LTS (SHA256 geprüft), `OPENVIDEO_BLENDER` gesetzt.
- `studio`: `base` + gebautes Studio (`apps/studio/dist`, entsteht parallel; falls nicht vorhanden, baut der Build es), Befehl `openvideo serve --host 0.0.0.0`.
- `worker`: `render-cpu`, Befehl `openvideo-worker`.
- `deploy/docker/build.sh`: baut alle Ziele mit festen Tags; `docker buildx` mit `--provenance` und SBOM, wenn verfügbar.
- Test (Shell- oder Node-Skript unter `deploy/test/`): jedes Image startet, `openvideo doctor --json` im `render-cpu`-Image meldet FFmpeg und Chromium ok; `blender`-Image meldet Blender ok; ein Frame eines JSON-Projekts rendert im `render-cpu`-Image mit `--read-only --cap-drop ALL --network none`.

### Kubernetes (`deploy/k8s/`, Kustomize)
- `base/`: Namespace (Pod Security `restricted`), `api` (Deployment + Service, `openvideo serve`, Token aus Secret), `coordinator` (Scheduler/Queue mit Journal auf PVC, Service), `worker-cpu`, `worker-gpu` (Ressource `nvidia.com/gpu`, Toleration, NodeSelector), `worker-blender`, `object-storage` (SeaweedFS StatefulSet, S3-Service, gepinnt per Digest, siehe `packages/cache/test/cache.test.ts`), `studio`, ConfigMap mit `OPENVIDEO_S3_*`, Secret-Vorlage.
- Alle Pods: `securityContext` (runAsNonRoot, readOnlyRootFilesystem, drop ALL, seccomp RuntimeDefault), Requests/Limits, Liveness- und Readiness-Probes (`/v1/health` bzw. Worker-Health), `emptyDir` für `/tmp` und `/cache`.
- NetworkPolicies: Worker dürfen nur Koordinator und Object Storage erreichen; kein Zugriff auf `169.254.169.254` und andere Namespaces; API/Studio von außen nur über Service.
- Autoscaling: KEDA `ScaledObject` für jede Worker-Art mit Trigger `metrics-api` auf `GET /v1/queue` des Koordinators (Queue-Länge), zusätzlich HPA auf CPU für `worker-cpu`; GPU-Worker skalieren über eine eigene Queue-Metrik; Overlay `prometheus/` mit Prometheus-Trigger auf Render-Dauer (`render_duration`).
- `overlays/local/` (kind: kleine Ressourcen, lokale Images, keine GPU) und `overlays/production/`.
- Test `deploy/test/kind.sh` (oder Node-Skript): kind-Cluster anlegen, Images laden, KEDA installieren (offizielles Release-Manifest, Version gepinnt), `kubectl apply -k deploy/k8s/overlays/local`, warten bis alles bereit ist, über die API ein Projekt anlegen und ein kurzes Video rendern, Ergebnis prüfen; künstliche Queue-Last erzeugen und prüfen, dass `worker-cpu` hochskaliert; Cluster wieder löschen.
- `deploy/README.md`: Betrieb (Installation, Konfiguration, Skalierung, Updates und Rollback per Image-Tag, Fehlersuche). Deutsch, kurze Sätze.

### CI
- `.github/workflows/images.yml`: baut und veröffentlicht die Images bei Tags `v*` nach GHCR (Login mit `GITHUB_TOKEN`, `permissions: packages: write`).

## Verification

- `bash deploy/docker/build.sh` baut alle Images.
- Image-Tests grün.
- kind-Test grün (inklusive Hochskalieren).
