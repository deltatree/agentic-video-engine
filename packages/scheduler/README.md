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

`startCoordinator({ port, host, store, journalDir, tokens: { submit, worker, metrics }, leaseSeconds })` startet den HTTP-Koordinator.

| Endpunkt | Rolle | Zweck |
| --- | --- | --- |
| `POST /v1/jobs` | `submit` | Job anlegen: Projekt, Dateien (Base64 oder Verweis `{ path, key: "inputs/sha256-<hex>" }`), Chunks. Projekt und Dateien landen inhaltsadressiert unter `inputs/`. |
| `GET /v1/jobs/<id>` | `submit` | Zustand eines Jobs. |
| `GET /v1/queue` | `metrics`, `submit` | JSON für KEDA metrics-api (`valueLocation: queueLength`). |
| `POST /v1/lease` | `worker` | Nächsten Chunk holen (`204`: keine Arbeit). |
| `POST /v1/heartbeat` | `worker` | Lease verlängern (`410`: Lease unbekannt oder abgelaufen). |
| `POST /v1/complete` | `worker` | Ergebnis abgeben, nur mit der `leaseId` der aktuellen Lease (`409 OV_COORDINATOR_LEASE_INVALID`). Frame-Schlüssel müssen `jobs/<jobId>/frames/<sha256>` sein (`400 OV_COORDINATOR_RESULT_INVALID`). |
| `POST /v1/fail` | `worker` | Fehler melden, nur mit gültiger Lease; `released: true` gibt den Chunk ohne Fehlversuch zurück. |
| `GET /metrics` | – | Prometheus-Text: `openvideo_queue_length`, `openvideo_leases_active`, `openvideo_chunks_failed_total`. |

Sicherheit und Grenzen (Epic 16, ADR 0023):

- Tokens je Rolle (`tokens.submit`, `tokens.worker`, `tokens.metrics`); `token` gilt als ein Token für alle Rollen (lokaler Betrieb).
  Jedes Token hat mindestens 24 Zeichen, ist kein Platzhalter `REPLACE…` und je Rolle verschieden. Ohne Token startet der Koordinator nur auf Loopback.
  Falsches Token: `401`; Token einer anderen Rolle: `403 OV_COORDINATOR_FORBIDDEN`.
- Body-Limit 64 MiB (`maxBodyBytes`), höchstens 10 000 Chunks je Job (`maxChunksPerJob`), 1000 laufende Jobs (`maxActiveJobs`, sonst `429`).
- Fertige Jobs verschwinden nach `jobTtlSeconds` (Standard 24 h) samt `jobs/<jobId>/` im Speicher; das Journal wird dabei und beim Start kompaktiert.
- Leases stehen im Journal und überstehen einen Neustart.

`createRemoteChunkRunner({ coordinatorUrl, token, store, projectDir, project })` übernimmt Frames nur nach Prüfung:
jeder Schlüssel liegt unter `jobs/<jobId>/frames/`, der Inhalt passt zum SHA-256 im Schlüssel. Geprüfte Frames landen
in der lokalen Stufe des Speichers als `frame/remote-sha256-<hex>`. Dateien über `inlineFileLimit` (Standard 4 MiB) lädt der Runner
selbst als `inputs/sha256-<hex>` hoch.

Das Journal (`journal.jsonl`) hält Jobs, Leases und Ergebnisse. Nach einem Neustart stehen offene Chunks wieder in der Warteschlange.
