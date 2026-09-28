# @agentic-video/sandbox

Container-Sandbox für nicht vertrauenswürdigen Code (Docker, ADR 0008).

- `runSandboxed({ code, input, limits, mode })` führt ein Skript aus. Der Abschlusswert ist die Ausgabe (JSON).
- Standard ist `docker`: Image `node:22-alpine` per Digest, kein Netz, schreibgeschütztes Dateisystem, keine Capabilities, keine Host-Mounts, Limits für Zeit, Speicher, CPU und Prozesse. Code und Eingabe gehen über stdin hinein.
- `trusted-host` ist nur für eigene Projekte gedacht: Node-Kindprozess mit `--permission`, leerer VM-Kontext ohne `require`, `process` und `fetch`. Das Ergebnis trägt `trusted: true`.
- Fehler: `OV_SANDBOX_TIMEOUT`, `OV_SANDBOX_MEMORY`, `OV_SANDBOX_CRASH`, `OV_SANDBOX_UNAVAILABLE`, `OV_SANDBOX_LIMITS`.
- `sandboxAvailable()` prüft Docker (für `doctor`).
