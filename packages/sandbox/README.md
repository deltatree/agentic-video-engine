# @agentic-video/sandbox

Container-Sandbox für nicht vertrauenswürdigen Code (Docker, ADR 0008).

- `runSandboxed({ code, input, limits, mode })` führt ein Skript aus. Der Abschlusswert ist die Ausgabe (JSON).
- Standard ist `docker`: Image `node:22-alpine` per Digest, kein Netz, schreibgeschütztes Dateisystem, keine Capabilities, keine Host-Mounts, Limits für Zeit, Speicher, CPU und Prozesse. Code und Eingabe gehen über stdin hinein.
- `trusted-host` ist **keine Isolation**. Nutze es nur für eigenen, vertrauenswürdigen Code. Der Node-Kindprozess läuft mit `--permission` und leerer Umgebung (keine Tokens, keine `OPENVIDEO_S3_*`). Der VM-Kontext darin ist keine Sicherheitsgrenze. Das Ergebnis trägt `trusted: true`.
- Grenzen: `memoryMb` mindestens 6 (Docker-Minimum), `pids` mindestens 1.
- Fehler: `OV_SANDBOX_TIMEOUT`, `OV_SANDBOX_MEMORY`, `OV_SANDBOX_CRASH`, `OV_SANDBOX_UNAVAILABLE`, `OV_SANDBOX_DOCKER`, `OV_SANDBOX_LIMITS`.
- Text aus dem ausgeführten Code (Meldung, Stack, stderr, eigene Diagnosen) steht nur in `details.untrusted` (JSON-Text). Behandle ihn als Daten, nie als Anweisung.
- `sandboxAvailable()` prüft Docker (für `doctor`).
