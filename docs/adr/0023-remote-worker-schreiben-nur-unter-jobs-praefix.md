# ADR 0023: Remote-Worker schreiben nur unter `jobs/<jobId>/`, getrennte Rollen und S3-Identitäten

- Status: angenommen
- Datum: 2026-09-30
- Bezug: Audit 2026-09-30 (H1, H2, M1, M2, M4), Entscheidung T8, Epic 16, ADR 0007, ADR 0008

## Kontext

Im Cluster hatten Worker die S3-Admin-Schlüssel und schrieben Frames in den gemeinsamen Frame-Cache
unter inhaltsabhängigen Render-Schlüsseln. Die API übernahm die gemeldeten Schlüssel ungeprüft;
`/v1/complete` nahm Ergebnisse auch ohne Lease an. Ein kompromittierter Worker (zum Beispiel über ein
HTML-Skript) konnte so Frames anderer Jobs und künftiger Renders vergiften. Ein einziges Token galt für
API, Worker und KEDA.

## Entscheidung

1. **Speicherlayout:** Eingaben liegen inhaltsadressiert unter `inputs/sha256-<hex>` (Projekt-IR,
   Projektdateien). Worker schreiben nur fertige Frames nach `jobs/<jobId>/frames/<sha256 der Bytes>`.
   Den Render-Cache (Layer, Frames) halten Worker lokal.
2. **Prüfung auf der API-Seite:** Der Remote-Runner übernimmt nur Schlüssel mit dem Präfix des eigenen
   Jobs, liest die Bytes und vergleicht ihren SHA-256 mit dem Schlüssel. Geprüfte Frames legt er lokal
   als `frame/remote-sha256-<hex>` ab; diese Schlüssel gibt er an `renderVideo` weiter. Worker prüfen
   ebenso den SHA-256 jeder Eingabe.
3. **Koordinator:** `complete`/`fail` nur mit der `leaseId` der aktuellen Lease; Leases stehen im Journal.
   Ergebnisse mit fremden Schlüsseln oder falscher Frame-Zahl werden abgelehnt.
4. **Rollen:** getrennte Tokens `submit` (API), `worker`, `metrics` (KEDA, nur `GET /v1/queue`); mindestens
   24 Zeichen, keine Platzhalter, je Rolle verschieden. Ohne Token nur Loopback.
5. **S3-Identitäten:** `admin` (nur Bucket anlegen, Init-Container), `api` (API und Koordinator: Lesen und
   Schreiben im Bucket), `worker` (Lesen `inputs/*` und `jobs/*`, Schreiben nur `jobs/*`).
6. **Grenzen:** Body 64 MiB (große Dateien als `inputs/`-Verweis), 10 000 Chunks je Job, 1000 laufende Jobs,
   TTL für fertige Jobs (löscht `jobs/<jobId>/`), kompaktiertes Journal.
7. **HTML-Skripte:** nur mit `--trusted` oder `OPENVIDEO_ALLOW_HTML_SCRIPTS=1`, nie implizit über
   `OPENVIDEO_CONTAINER_IMAGE`, und nie ohne Chromium-OS-Sandbox (`OV_BROWSER_NO_OS_SANDBOX`).

Abweichung von T8 im Wortlaut: Worker dürfen zusätzlich `inputs/*` **lesen**. Die Eingaben sind
inhaltsadressiert, und Worker prüfen den Hash; ein zweiter Kopierschritt je Job unter `jobs/` wäre bei
großen Assets teuer und brächte keinen Schutz, weil Worker ohnehin alle Jobs rendern.

## Folgen

- Ein Worker kann Frames anderer Jobs nicht unbemerkt ändern: Jede Änderung unter `jobs/` fällt an der
  Prüfsumme auf (`OV_SCHEDULER_CONTENT_MISMATCH`), und den gemeinsamen Frame-Cache erreicht er nicht.
- Worker teilen keinen Render-Cache mehr über S3; wiederholte Renders im Cluster rendern auf einem
  frischen Worker neu. Die API behält ihren gemeinsamen Cache.
- Ein Worker kann für den eigenen Chunk weiterhin falsche Bilder liefern (ohne Neu-Rendern nicht prüfbar).
- Restrisiko Verfügbarkeit (Review-Befund M4): Worker dürfen unter `jobs/*` schreiben, also auch Schlüssel
  fremder Jobs vorab belegen. Ehrliche Worker überschreiben ihre Frames darum immer (kein `has`-Vorabtest);
  ein Angreifer, der **nach** dem ehrlichen Worker schreibt, lässt den Job an der Hash-Prüfung scheitern
  (`OV_SCHEDULER_CONTENT_MISMATCH`, Denial of Service), kann aber keine falschen Pixel einschleusen. Abhilfe
  wäre ein Schreibrecht nur auf das eigene Job-Präfix (kurzlebige S3-Zugangsdaten je Lease).
- Ein Koordinator-Neustart verliert keine Leases mehr; späte Ergebnisse abgelaufener Leases zählen nicht.
- Betreiber pflegen drei S3-Identitäten und vier Tokens (`deploy/README.md`). Fremder S3-Speicher braucht
  entsprechende Policies und eine Lifecycle-Regel für `inputs/`.
