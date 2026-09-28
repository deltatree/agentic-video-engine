# @agentic-video/scheduler

Chunk-Scheduler: dynamische Verteilung auf Prozess-, Docker- und Remote-Worker, Wiederholung, Koordinator.

Alle Runner erfüllen den Typ `ChunkRunner` aus `@agentic-video/render`. Übergib sie an `renderVideo` als `runChunks`.

## Runner

| Runner | Worker | Frames |
| --- | --- | --- |
| `createProcessChunkRunner` | N lokale Node-Prozesse (Shared-Modus) | gemeinsamer `FileStore` des Aufrufers |
| `createDockerChunkRunner` | N Container ohne Netz und ohne Host-Mounts (Stream-Modus) | über stdout zurück in den Cache des Aufrufers |
| `createRemoteChunkRunner` | Pull-Worker am Koordinator | gemeinsamer S3-Speicher |

Beispiel:

```ts
const runChunks = createProcessChunkRunner({ concurrency: 4, projectDir, project, cache: env.cache, telemetry: env.telemetry });
await renderVideo(env, project, { outPath: 'out/video.mp4', profile, runChunks });
```

Ein freier Worker holt den nächsten Chunk. Ein fehlgeschlagener Chunk läuft erneut, bevorzugt auf einem anderen Worker (Standard: höchstens 3 Versuche). Ein abgestürzter Worker wird neu gestartet. Metriken: `queue_wait`, `worker_failures`. Jeder Chunk trägt den `traceparent` des Aufrufers.

## Koordinator

`startCoordinator({ port, store, journalDir, token, leaseSeconds })` startet den HTTP-Koordinator.

| Endpunkt | Zweck |
| --- | --- |
| `POST /v1/jobs` | Job anlegen: Projekt, Dateien (Base64), Chunks. Dateien landen im Speicher. |
| `POST /v1/lease` | Nächsten Chunk holen (`204`: keine Arbeit). |
| `POST /v1/heartbeat` | Lease verlängern (`410`: Lease unbekannt). |
| `POST /v1/complete` | Ergebnis abgeben. |
| `POST /v1/fail` | Fehler melden; `released: true` gibt den Chunk ohne Fehlversuch zurück. |
| `GET /v1/jobs/<id>` | Zustand eines Jobs. |
| `GET /v1/queue` | JSON für KEDA metrics-api (`valueLocation: queueLength`). |
| `GET /metrics` | Prometheus-Text: `openvideo_queue_length`, `openvideo_leases_active`, `openvideo_chunks_failed_total`. |

Alle `/v1`-Endpunkte verlangen `Authorization: Bearer <token>`, wenn ein Token gesetzt ist. Das Journal (`journal.jsonl`) hält Jobs und Ergebnisse. Nach einem Neustart stehen offene Chunks wieder in der Warteschlange. Abgelaufene Leases werden neu vergeben.
