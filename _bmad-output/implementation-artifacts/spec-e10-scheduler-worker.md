---
title: 'Paralleles und verteiltes Rendering: Scheduler, Worker, Koordinator (Epic 10)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/packages/render/src/video.ts'
  - '{project-root}/packages/render/src/node-env.ts'
  - '{project-root}/packages/render/src/environment.ts'
  - '{project-root}/packages/cache/src/cache.ts'
  - '{project-root}/packages/telemetry/src/index.ts'
  - '{project-root}/docs/adr/0008-nicht-vertrauenswuerdiger-code-nur-im-container.md'
---

## Intent

**Problem:** Frames sind unabhängig renderbar (ADR 0002). Lange Videos sollen parallel auf mehreren Prozessen, in Docker-Containern und in Kubernetes rendern (FR-66, FR-67), mit einer Trace-ID über alle Teile (FR-92).

**Approach:** `scheduler` liefert `ChunkRunner`-Implementierungen (Typ aus `@agentic-video/render`), `worker` den Worker-Prozess. Chunks werden dynamisch verteilt (freier Worker holt den nächsten Chunk). Fehlgeschlagene Chunks laufen einzeln erneut.

## Boundaries & Constraints

**Always:**
- Pakete: `packages/scheduler`, `packages/worker` (beide existieren als Gerüst). Nichts anderes ändern. Brauchst du ein `bin` in `packages/worker/package.json`, lege es dort an.
- `renderVideo` (render) nimmt `runChunks: ChunkRunner`. Deine Runner erfüllen genau diesen Typ.
- Jobs sind idempotent: ein Chunk erzeugt immer dieselben Frames (Frame-Schlüssel, Cache). Doppelte Ausführung ist erlaubt und harmlos.
- Trace-Kontext (`traceparent` aus `telemetry.traceparent()`) reist mit jedem Chunk; Worker setzen ihn mit `withRemoteParent` fort.
- Container-Worker haben **kein Netz und keine Host-Mounts** (ADR 0008): Projekt, Assets und Schriften gehen über stdin in den Container; Frames kommen über stdout zurück.

## Anforderungen

### Protokoll (`worker/src/protocol.ts`)
- Längenpräfix-Rahmen über stdio: `[u32 Länge][JSON]`, optional gefolgt von Binärdaten, deren Länge im JSON steht. Nachrichten: `init` (Projekt-IR, Projektdateien als Bytes für den Stream-Modus, Optionen), `chunk` (ChunkRequest + traceparent), `frame` (Frame-Schlüssel + OVRF-Bytes aus `@agentic-video/png`), `result` (ChunkResult), `error` (Diagnose), `log`, `shutdown`.

### Worker (`worker`)
- `runWorkerStdio()`: liest `init`, baut `createNodeEnvironment` (render) für ein temporäres Projektverzeichnis (Stream-Modus: Dateien aus `init` schreiben) oder ein vorhandenes (Shared-Modus: Pfad + gemeinsamer Cache), rendert Chunks mit `renderChunk` (render). Im Stream-Modus schickt er jeden neuen Frame (`frame`) an den Koordinator und hält selbst nur einen Speicher-Cache.
- `runWorkerHttp({ coordinatorUrl, token, store })`: Pull-Schleife für Remote/Kubernetes: `lease` → rendern (Frames in den gemeinsamen S3-Speicher über `storeFromEnv`) → `complete`/`fail`, Heartbeat während des Renderns, sauberes Ende bei SIGTERM (laufenden Chunk abgeben).
- `bin`: `openvideo-worker --stdio` bzw. `openvideo-worker --coordinator <url>`.

### Scheduler (`scheduler`)
- `createProcessChunkRunner({ concurrency, projectDir, cache, telemetry, maxAttempts = 3 })`: startet N Node-Prozesse mit dem Worker (Shared-Modus, gleicher `FileStore` wie der Aufrufer). Dynamische Verteilung, Neustart abgestürzter Worker, Wiederholung auf einem anderen Worker, Metriken `queue_wait` und `worker_failures`, `worker`-Feld im ChunkResult.
- `createDockerChunkRunner({ image, concurrency, limits, cache, telemetry })`: startet Worker in Containern (`docker run -i --rm --network none --read-only --tmpfs /tmp:rw,size=2g --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 --memory <M> --cpus <C> --user 65534:65534`), Stream-Modus; empfangene Frames schreibt der Runner in den Frame-Cache des Aufrufers. Ein Test baut dafür ein Image aus dem Repository: lege `deploy/docker/Dockerfile.worker` **nicht** an (andere Story); nutze im Test ein Image, das du im Test aus `node:22-bookworm-slim` + den gebauten `dist`-Ordnern und `node_modules` per `docker build` mit temporärem Kontext erzeugst (Tag mit Inhalts-Hash, einmal gebaut, danach wiederverwendet). FFmpeg ist für Worker nicht nötig (nur Frames); Chromium nur für HTML/3D – der Test nutzt 2D.
- `startCoordinator({ port, store, journalDir, token?, leaseSeconds = 120 })`: HTTP-Koordinator für Remote-Worker: `POST /v1/jobs` (Projekt, Assets werden in den Speicher gelegt, Chunks), `POST /v1/lease`, `POST /v1/heartbeat`, `POST /v1/complete`, `POST /v1/fail`, `GET /v1/jobs/<id>`, `GET /metrics` (Prometheus-Text: `openvideo_queue_length`, `openvideo_leases_active`, `openvideo_chunks_failed_total`) und `GET /v1/queue` (JSON, für KEDA metrics-api). Journal (JSON Lines) auf der Platte; nach Neustart werden offene Chunks wieder vergeben. Abgelaufene Leases werden neu vergeben.
- `createRemoteChunkRunner({ coordinatorUrl, token })`: reicht einen Render an den Koordinator, wartet auf alle Chunks.

## Tasks & Acceptance

**Acceptance Criteria:**
- Given 90 Frames und 3 Prozess-Worker, when gerendert, then sind die Frame-Hashes gleich wie beim lokalen Render in einem Prozess (Reproduzierbarkeit auf mehreren Workern, FR-9).
- Given ein Worker stirbt mitten im Chunk (Test tötet ihn), then wird nur dieser Chunk erneut gerendert und das Video ist vollständig.
- Given Docker-Worker, when gerendert, then gleiche Hashes; der Container hat kein Netz (Test: Worker meldet `fetch` scheitert, falls du einen Prüfbefehl einbaust, oder prüfe per `docker inspect` die NetworkMode `none`).
- Given Koordinator mit zwei HTTP-Workern und einem Neustart des Koordinators, then werden alle Chunks fertig; `GET /v1/queue` liefert die Warteschlangenlänge.
- Given ein Job, then tragen alle Spans (Aufrufer, Worker) dieselbe Trace-ID (Test mit `exporter: 'memory'` im Aufrufer und Log-Zeilen der Worker mit `trace_id`).

## Verification

- `npx tsc -b packages/scheduler packages/worker`
- `npx vitest run packages/scheduler/ packages/worker/`
- `npx eslint packages/scheduler packages/worker --max-warnings 0` (falls ESLint die Dateien nicht im Projekt findet: `tsconfig.eslint.json` im Root enthält sie noch nicht – prüfe dann mit einer Kopie der Datei im Temp-Ordner und nenne es im Bericht)
