# @agentic-video/worker

Render-Worker: Chunk-Protokoll über stdio (Prozess, Docker) und HTTP-Pull (Kubernetes).

## Aufruf

```bash
openvideo-worker --stdio
openvideo-worker --coordinator http://coordinator:8080 [--token <token>] [--name <worker>]
```

- `--stdio`: Rahmen `[u32 Länge][JSON][Binärdaten]` über stdin und stdout. Nachrichten: `init`, `chunk`, `cancel`, `frame`, `result`, `error`, `log`, `shutdown`.
  Chunks laufen nacheinander; der Worker liest währenddessen weiter. `cancel` mit der Chunk-ID bricht den Chunk nach dem
  laufenden Frame ab (`error` mit `OV_RENDER_CANCELLED`, Story 18.8); `shutdown` wartet auf den laufenden Chunk.
- `--coordinator`: Pull-Schleife `lease` → rendern → `complete`/`fail`. Das Token (Rolle `worker`) kommt aus `--token` oder `OPENVIDEO_WORKER_TOKEN`.
  Der Worker liest Projekt und Dateien aus `inputs/sha256-…` im Speicher aus `OPENVIDEO_S3_*` und prüft ihren SHA-256.
  Er rendert mit einem lokalen Cache und lädt nur die fertigen Frames nach `jobs/<jobId>/frames/<sha256>` hoch (ADR 0023).
  Mehr Rechte braucht seine S3-Identität nicht. `OPENVIDEO_ALLOW_HTML_SCRIPTS=1` erlaubt HTML-Skripte (nur mit Chromium-OS-Sandbox).
  Ergebnisse gelten nur mit gültiger Lease; eine abgelehnte Meldung zählt `summary.rejected`.
  Antwortet der Heartbeat mit `410` (Lease abgelaufen, Job abgebrochen oder gescheitert), hört der Worker nach dem
  laufenden Frame auf und meldet nichts mehr (Story 18.8). Frames schreibt er immer neu, auch wenn der Schlüssel schon
  existiert: vorab abgelegter fremder Inhalt kann den Job so nicht blockieren (Befund M4).
- Bei `SIGTERM` gibt der Worker den laufenden Chunk an den Koordinator zurück und endet.

## Exit-Codes

| Code | Bedeutung |
| --- | --- |
| 0 | Sauber beendet (`shutdown`, Ende der Eingabe oder `SIGTERM`). |
| 1 | Fehler, z. B. `init` gescheitert. Die Diagnose steht auf stderr. |
| 2 | Falscher Aufruf. |
