# @agentic-video/worker

Render-Worker: Chunk-Protokoll über stdio (Prozess, Docker) und HTTP-Pull (Kubernetes).

## Aufruf

```bash
openvideo-worker --stdio
openvideo-worker --coordinator http://coordinator:8080 [--token <token>] [--name <worker>]
```

- `--stdio`: Rahmen `[u32 Länge][JSON][Binärdaten]` über stdin und stdout. Nachrichten: `init`, `chunk`, `frame`, `result`, `error`, `log`, `shutdown`.
- `--coordinator`: Pull-Schleife `lease` → rendern → `complete`/`fail`. Das Token kommt aus `--token` oder `OPENVIDEO_WORKER_TOKEN`. Frames gehen in den Speicher aus `OPENVIDEO_S3_*`.
- Bei `SIGTERM` gibt der Worker den laufenden Chunk an den Koordinator zurück und endet.

## Exit-Codes

| Code | Bedeutung |
| --- | --- |
| 0 | Sauber beendet (`shutdown`, Ende der Eingabe oder `SIGTERM`). |
| 1 | Fehler, z. B. `init` gescheitert. Die Diagnose steht auf stderr. |
| 2 | Falscher Aufruf. |
