# @agentic-video/worker

Render-Worker: Chunk-Protokoll über stdio (Prozess, Docker) und HTTP-Pull (Kubernetes).

## Aufruf

```bash
openvideo-worker --stdio
openvideo-worker --coordinator http://coordinator:8080 [--token <token>] [--name <worker>]
```

- `--stdio`: Rahmen `[u32 Länge][JSON][Binärdaten]` über stdin und stdout. Nachrichten: `init`, `chunk`, `frame`, `result`, `error`, `log`, `shutdown`.
- `--coordinator`: Pull-Schleife `lease` → rendern → `complete`/`fail`. Das Token (Rolle `worker`) kommt aus `--token` oder `OPENVIDEO_WORKER_TOKEN`.
  Der Worker liest Projekt und Dateien aus `inputs/sha256-…` im Speicher aus `OPENVIDEO_S3_*` und prüft ihren SHA-256.
  Er rendert mit einem lokalen Cache und lädt nur die fertigen Frames nach `jobs/<jobId>/frames/<sha256>` hoch (ADR 0023).
  Mehr Rechte braucht seine S3-Identität nicht. `OPENVIDEO_ALLOW_HTML_SCRIPTS=1` erlaubt HTML-Skripte (nur mit Chromium-OS-Sandbox).
  Ergebnisse gelten nur mit gültiger Lease; eine abgelehnte Meldung zählt `summary.rejected`.
- Bei `SIGTERM` gibt der Worker den laufenden Chunk an den Koordinator zurück und endet.

## Exit-Codes

| Code | Bedeutung |
| --- | --- |
| 0 | Sauber beendet (`shutdown`, Ende der Eingabe oder `SIGTERM`). |
| 1 | Fehler, z. B. `init` gescheitert. Die Diagnose steht auf stderr. |
| 2 | Falscher Aufruf. |
