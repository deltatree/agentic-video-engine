# OpenVideo betreiben: Docker und Kubernetes

Dieses Dokument richtet sich an Betreiber. Es zeigt, wie Sie OpenVideo als Container
bauen, in Kubernetes installieren, skalieren, aktualisieren und Fehler finden.

Vorwissen: Docker, `kubectl` und Kustomize (in `kubectl` eingebaut).

## Überblick

| Teil | Aufgabe | Image |
|---|---|---|
| `api` | Agent API (`openvideo serve`). Rendert JSON-Projekte im eigenen Pod. | `openvideo-render-cpu` |
| `studio` | Web-Oberfläche mit eigener API. | `openvideo-studio` |
| `coordinator` | Verteilt Chunks an Worker. Eine Queue je Worker-Art. | `openvideo-base` |
| `worker-cpu` | Rendert Chunks auf der CPU. | `openvideo-worker` |
| `worker-gpu` | Rendert Chunks auf einer NVIDIA-GPU. | `openvideo-render-gpu` |
| `worker-blender` | Rendert Chunks mit Blender-Nodes. | `openvideo-blender` |
| `object-storage` | Gemeinsamer S3-Speicher (SeaweedFS) für Projekte und Frames. | `chrislusf/seaweedfs` (Digest) |

Ein Chunk ist ein Bereich von Frames, zum Beispiel die Frames 0 bis 29.
Worker holen sich Chunks beim Koordinator ab (Pull). Die Frames legen sie im S3-Speicher unter
`jobs/<jobId>/frames/<sha256>` ab. Die API übernimmt nur Frames mit diesem Präfix und prüft den
SHA-256 jedes Frames (ADR 0023).

Die Queues des Koordinators:

| Queue | Port | Worker |
|---|---|---|
| `cpu` | 8080 | `worker-cpu` |
| `gpu` | 8081 | `worker-gpu` |
| `blender` | 8082 | `worker-blender` |

## Images

Alle Images entstehen aus `deploy/docker/Dockerfile`. Jedes Ziel ist ein Image.

| Image | Inhalt |
|---|---|
| `openvideo-base` | Node 22, Anwendung, Schriften. Einstieg `openvideo`. |
| `openvideo-render-cpu` | `base` + FFmpeg 7.1 (Debian 13) + Chromium (Chrome for Testing, Revision von playwright-core). |
| `openvideo-render-gpu` | `render-cpu`, vorbereitet für NVIDIA (NVENC). |
| `openvideo-blender` | `render-cpu` + Blender 4.2.23 LTS. |
| `openvideo-studio` | `base` + Studio. Befehl `openvideo serve --host 0.0.0.0`. |
| `openvideo-worker` | `render-cpu`. Befehl `openvideo-worker`. |

Registry: `ghcr.io/deltatree/openvideo-<name>`.
Tags: die Version aus `package.json` (zum Beispiel `0.1.0`) und `<version>-<git-sha>`.

Eigenschaften aller Images:

- Der Prozess läuft als Nutzer 65532, nie als root.
- Das Root-Dateisystem darf read-only sein. Schreibpfade sind nur `/tmp` und `/cache`.
- Der Container braucht keine Capabilities (`--cap-drop ALL`).
- `OPENVIDEO_CONTAINER_IMAGE` nennt das Image. Der Wert steht im Render-Manifest. Er erlaubt keine HTML-Skripte.
- Labels `org.opencontainers.image.*` und `io.openvideo.*` nennen die Versionen.

Reproduzierbarkeit:

- Das Basis-Image ist per Digest gepinnt.
- apt lädt nur von `snapshot.debian.org` mit festem Datum. Wichtige Pakete haben feste Versionen.
- `npm ci` installiert genau das Lockfile.
- Die Archive von Blender und Chromium werden per SHA256 geprüft (`ADD --checksum` und `sha256sum -c`).
  Beim Update von playwright-core bricht der Build ab, bis Revision und Prüfsummen in `chromium-fetch` passen.
- `SOURCE_DATE_EPOCH` ist die Zeit des letzten Commits.

### Images bauen

```bash
bash deploy/docker/build.sh
```

Ergebnis: alle sechs Images mit beiden Tags im lokalen Docker.

Optionen (Umgebungsvariablen):

| Variable | Wirkung |
|---|---|
| `TARGETS="base worker"` | Nur diese Ziele bauen. |
| `SOURCE=head` | Genau den Commit `HEAD` bauen, nicht den Arbeitsbaum. |
| `REGISTRY=…` | Andere Registry. |
| `PUSH=1` | In die Registry schieben (mit Provenance und SBOM). |

Mit `docker buildx` entstehen Provenance-Attestierung und SBOM, wenn der Speicher sie hält.
Beim Veröffentlichen gilt das immer. Lokal gilt es nur mit dem containerd-Image-Store.

Die CI veröffentlicht die Images bei jedem Tag `v*` (`.github/workflows/images.yml`).

### Ein Image direkt nutzen

Ein Frame rendern, ohne Netz, read-only, ohne Capabilities:

```bash
docker run --rm --read-only --cap-drop ALL --network none \
  --tmpfs /tmp --tmpfs /cache:uid=65532,gid=65532 \
  -v "$PWD/my-project:/project:ro" -v "$PWD/out:/out" \
  ghcr.io/deltatree/openvideo-render-cpu:0.1.0 \
  render-frame /project --frame 2s --out /out/frame.png
```

Der Ordner `out` muss für UID 65532 beschreibbar sein.

Das Studio (oder `openvideo serve`) auf einer Netzwerkadresse starten:

```bash
docker run --rm -p 7788:7788 -e OPENVIDEO_API_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/deltatree/openvideo-studio:0.1.0
```

Regeln des Servers:

- Auf `0.0.0.0` startet der Server nur mit `OPENVIDEO_API_TOKEN`. Sonst bricht er mit `OV_API_TOKEN_REQUIRED` ab.
- Der Server prüft den Host-Header. Erlaubt sind `localhost:<port>` und `127.0.0.1:<port>`.
  Weitere Namen stehen in `OPENVIDEO_ALLOWED_HOSTS` (kommagetrennt) oder in `--allowed-host`.
  Andere Namen bekommen 403 (`OV_API_HOST`). `/v1/health` ist davon ausgenommen.
- POST-Anfragen brauchen den Header `content-type: application/json`.
- HTML-Skripte sind aus. Sie laufen nur mit `OPENVIDEO_ALLOW_HTML_SCRIPTS=1` (oder `--trusted`) **und** wenn
  Chromium mit der OS-Sandbox startet. Fehlt die Sandbox (typisch im Container ohne User Namespaces),
  bricht ein Render mit Skripten mit `OV_BROWSER_NO_OS_SANDBOX` ab, statt ungeschützt zu laufen.
- Die Studio-Dateien kommen mit `Content-Security-Policy` (`frame-ancestors 'none'`, Skripte nur von der
  eigenen Origin), `Referrer-Policy: no-referrer` und `X-Frame-Options: DENY`.

Die Umgebung prüfen:

```bash
docker run --rm ghcr.io/deltatree/openvideo-render-cpu:0.1.0 doctor
```

## Installation in Kubernetes

### Voraussetzungen

- Kubernetes 1.30 oder neuer, mit einer Standard-StorageClass.
- Ein Netzwerk-Plugin (CNI), das NetworkPolicies durchsetzt (zum Beispiel Calico, Cilium, kindnet ab
  kind 0.24). **Pflicht:** Ohne ein solches Plugin nimmt Kubernetes die NetworkPolicies an, setzt sie aber
  nicht durch. Dann erreicht jeder Pod den Koordinator und den S3-Speicher. Prüfen Sie das nach der
  Installation, zum Beispiel aus einem anderen Namespace:
  `kubectl -n default run probe --rm -it --image=busybox --restart=Never -- wget -qO- -T 3 http://coordinator.openvideo:8080/metrics`
  muss scheitern (Zeitüberschreitung). Antwortet der Koordinator, setzt Ihr CNI keine NetworkPolicies durch.
- KEDA 2.21 im Namespace `keda`.
- Für GPU-Worker: der NVIDIA GPU Operator. Er setzt das Knoten-Label `nvidia.com/gpu.present=true`.

KEDA installieren:

```bash
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.21.0/keda-2.21.0.yaml
```

### Schritte

1. Legen Sie die Geheimnisse an:

   ```bash
   cd deploy/k8s/overlays/production
   cp secrets.env.example secrets.env
   ```

2. Ersetzen Sie jeden Wert in `secrets.env`. Nutzen Sie nur Buchstaben und Ziffern und für jeden
   Schlüssel einen eigenen Wert. Beispiel für einen Wert: `openssl rand -hex 32`.
   Der Koordinator startet nicht mit `REPLACE…`, mit Tokens unter 24 Zeichen oder mit gleichen Tokens
   für zwei Rollen (`OV_COORDINATOR_TOKEN_WEAK`, `OV_COORDINATOR_TOKEN_SHARED`).
3. Prüfen Sie die Manifeste:

   ```bash
   kubectl kustomize deploy/k8s/overlays/production | less
   ```

4. Wenden Sie die Manifeste an:

   ```bash
   kubectl apply -k deploy/k8s/overlays/production
   ```

5. Warten Sie, bis alle Pods bereit sind:

   ```bash
   kubectl -n openvideo get pods -w
   ```

Ergebnis: API und Studio antworten im Cluster auf Port 7788.

Die Datei `secrets.env` gehört nie ins Repository. Die `.gitignore` im Overlay schließt sie aus.

### Von außen zugreifen

API und Studio sind Services vom Typ `ClusterIP`. Veröffentlichen Sie sie über Ihren Ingress
oder Ihr Gateway. Zum Testen reicht eine Weiterleitung:

```bash
kubectl -n openvideo port-forward svc/api 7788:7788
curl http://127.0.0.1:7788/v1/health
curl -H "Authorization: Bearer <api-token>" http://127.0.0.1:7788/v1/operations
```

Nutzen Sie lokal denselben Port 7788. Sonst lehnt die Host-Prüfung die Anfrage ab.

Das Studio erwartet das API-Token im Fragment der Adresse: `http://<studio>/#token=<api-token>`.
Das Fragment geht nie an den Server, nicht in Zugriffs-Logs und nicht in den Referer. Das Studio legt
das Token in `sessionStorage` und entfernt es aus der Adresse. Ein `?token=` in der Query verwirft das
Studio (es landet sonst in Logs und im Verlauf).

### Overlays

| Overlay | Zweck |
|---|---|
| `overlays/local` | kind oder Laptop: kleine Ressourcen, Images mit Tag `local`, keine GPU, feste Test-Tokens. |
| `overlays/production` | Images aus ghcr.io mit fester Version, Geheimnisse aus `secrets.env`. |
| `overlays/prometheus` | `production` plus Skalierung über die Render-Dauer aus Prometheus. |
| `overlays/production-ha` | `prometheus` plus Hochverfügbarkeit: PodDisruptionBudgets, Replikate und RollingUpdate für Studio und Worker, Priorität für die Single-Writer, GPU-Autoscaling über DCGM (siehe [Hochverfügbarkeit](#hochverfügbarkeit)). |

## Konfiguration

Die ConfigMap `openvideo-config` gilt für alle Pods:

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `OPENVIDEO_S3_ENDPOINT` | `http://object-storage:8333` | S3-Adresse. |
| `OPENVIDEO_S3_BUCKET` | `openvideo` | Bucket für Projekte und Frames. |
| `OPENVIDEO_S3_REGION` | `us-east-1` | Region für die S3-Signatur. |
| `OPENVIDEO_S3_CREATE_BUCKET` | `true` | Init-Container legen den Bucket an. |
| `OPENVIDEO_COORDINATOR_QUEUES` | `cpu:8080,gpu:8081,blender:8082` | Queues und Ports des Koordinators. |
| `OPENVIDEO_LEASE_SECONDS` | `120` | So lange hält ein Chunk ohne Heartbeat. |

Grenzen des Koordinators (Umgebung des Pods `coordinator`, optional):

| Variable | Standard | Bedeutung |
|---|---|---|
| `OPENVIDEO_COORDINATOR_MAX_BODY_BYTES` | `67108864` (64 MiB) | Größte Anfrage. Größere Projektdateien lädt die API vorher selbst als `inputs/sha256-…` in den Speicher. |
| `OPENVIDEO_JOB_TTL_SECONDS` | `86400` | So lange bleibt ein fertiger Job abrufbar. Danach löscht der Koordinator ihn samt `jobs/<jobId>/` und kompaktiert das Journal. |

Fest eingebaut: höchstens 10 000 Chunks je Job und 1000 laufende Jobs (`429 OV_COORDINATOR_BUSY`).

Weitere Variablen in den Deployments:

| Variable | Pod | Bedeutung |
|---|---|---|
| `OPENVIDEO_ALLOWED_HOSTS` | `api`, `studio` | Erlaubte Host-Header. Standard: die Service-Namen, zum Beispiel `api,api.openvideo.svc`. |
| `OPENVIDEO_CACHE_DIR` | alle | Frame-Cache, fest `/cache` (emptyDir). |
| `OPENVIDEO_WORKSPACE` | `api` | Projekte und Jobs, `/workspace` (PVC). |
| `OPENVIDEO_COORDINATOR_URL` | `api` | Video-Renders gehen als Chunks an diese Queue, Standard `http://coordinator:8080`. Ohne die Variable rendert die API selbst. |
| `OPENVIDEO_SUBMIT_TOKEN` | `api`, `coordinator` | Token der Rolle `submit` (Jobs einreichen und abfragen). |
| `OPENVIDEO_WORKER_TOKEN` | Worker, `coordinator` | Token der Rolle `worker` (`lease`, `heartbeat`, `complete`, `fail`). |
| `OPENVIDEO_METRICS_TOKEN` | `coordinator` | Token der Rolle `metrics` (KEDA, nur `GET /v1/queue`). |
| `OPENVIDEO_ALLOW_HTML_SCRIPTS` | – | `1` erlaubt HTML-Skripte, aber nur mit Chromium-OS-Sandbox. Standard: aus. |
| `OPENVIDEO_METRICS` | `api` | `prometheus` exportiert Metriken auf Port 9464 (`OPENVIDEO_METRICS_PORT`). Das Overlay `prometheus` setzt das. |
| `OPENVIDEO_WORKERS` | `api` | Lokale Worker-Prozesse, wenn die API selbst rendert (ohne `OPENVIDEO_COORDINATOR_URL`). Standard: Kerne − 1, begrenzt durch 1,5 GB je Worker (ADR 0026). In Pods mit CPU- oder Speichergrenze fest setzen: Node sieht die cgroup-Grenzen nicht. |
| `OPENVIDEO_ENCODER_THREADS` | `api` | Threads des Video-Encoders. Standard: fest 4, damit die Videodatei über Maschinen hinweg bitgleich ist. `auto` nutzt die freien Kerne neben den Render-Prozessen (schneller, Datei nicht mehr maschinenübergreifend bitgleich; ADR 0026). |
| `OPENVIDEO_CACHE_MAX_BYTES` | `api`, Worker | Obergrenze des lokalen Caches; nach jedem Video-Render räumt OpenVideo die ältesten Einträge bis dahin auf. Ohne Wert: kein Aufräumen. |
| `OPENVIDEO_CHUNK_TIMEOUT_MS` | `api` | Höchstdauer eines Chunks auf einem lokalen Worker-Prozess; danach wird der Worker beendet und der Chunk wiederholt. |

Erreichen Sie API oder Studio über einen Ingress-Namen, ergänzen Sie ihn in Ihrem Overlay:

```yaml
patches:
  - target: { kind: Deployment, name: studio }
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/env/2/value
        value: studio,studio.openvideo.svc,studio.openvideo.svc.cluster.local,studio.example.com
```

Prüfen Sie den Index (`env/2`) vorher mit `kubectl kustomize`.

Das Secret `openvideo-secrets` enthält:

| Schlüssel | Bedeutung |
|---|---|
| `api-token` | Bearer-Token der Agent API und des Studios. |
| `submit-token` | Koordinator-Rolle `submit`: nur die API. |
| `worker-token` | Koordinator-Rolle `worker`: nur die Worker. |
| `metrics-token` | Koordinator-Rolle `metrics`: nur KEDA, nur `GET /v1/queue`. |
| `s3-admin-access-key-id`, `s3-admin-secret-access-key` | S3-Identität `admin`: legt den Bucket an. Nur die Init-Container `s3-bucket` bekommen sie. |
| `s3-api-access-key-id`, `s3-api-secret-access-key` | S3-Identität `api`: API und Koordinator, Lesen und Schreiben im Bucket. |
| `s3-worker-access-key-id`, `s3-worker-secret-access-key` | S3-Identität `worker`: liest nur `inputs/`, liest und schreibt nur `jobs/`. |

Die Identitäten richtet `base/object-storage.yaml` in SeaweedFS ein (Pfadregeln `Aktion:openvideo/<präfix>*`).
Mit `OPENVIDEO_S3_PREFIX` passen Sie die Pfadregeln an. Warum die Trennung nötig ist: ADR 0023.

Eigenen S3-Speicher nutzen (AWS S3, MinIO):

1. Legen Sie den Bucket selbst an.
2. Setzen Sie `OPENVIDEO_S3_ENDPOINT` und `OPENVIDEO_S3_BUCKET` auf Ihre Werte.
3. Setzen Sie `OPENVIDEO_S3_CREATE_BUCKET` auf `false`.
4. Entfernen Sie `object-storage` mit einem Patch (`$patch: delete`) aus Ihrem Overlay.
5. Erlauben Sie den Workern den Weg zu Ihrem S3 in einer eigenen NetworkPolicy.
6. Legen Sie drei Identitäten mit denselben Rechten wie oben an. Beispiel einer IAM-Policy für den Worker:
   `s3:GetObject` auf `arn:aws:s3:::<bucket>/inputs/*` und `arn:aws:s3:::<bucket>/jobs/*`,
   `s3:PutObject` und `s3:DeleteObject` nur auf `arn:aws:s3:::<bucket>/jobs/*`.
7. Löschen Sie `inputs/` mit einer Lifecycle-Regel (zum Beispiel nach 30 Tagen). Der Koordinator
   löscht `jobs/<jobId>/` selbst nach der TTL.

Der Namespace heißt fest `openvideo`. Die KEDA-Adressen in `base/autoscaling.yaml` nennen ihn.
Ändern Sie ihn nur zusammen mit diesen Adressen.

## Sicherheit

- Der Namespace erzwingt Pod Security `restricted`.
- Jeder Pod läuft als Nutzer 65532, mit read-only Root-Dateisystem, ohne Capabilities,
  mit seccomp `RuntimeDefault` und ohne Service-Account-Token.
- `/tmp` und `/cache` sind `emptyDir`-Volumes. Journal und API-Workspace liegen auf PVCs.
- NetworkPolicies verbieten jeden Verkehr, der nicht erlaubt ist:
  - Worker erreichen nur den Koordinator und den Object Storage.
  - Kein Pod erreicht `169.254.169.254`, andere Namespaces oder das Internet.
  - API und Studio sind von außen nur über Port 7788 erreichbar.
- Getrennte Tokens am Koordinator (Story 16.3): Die API kann keine Chunks leasen, ein Worker keine Jobs
  einreichen, KEDA nur die Queue-Länge lesen. Ohne Token startet der Koordinator nur auf Loopback.
- `complete` und `fail` gelten nur mit der `leaseId` der aktuellen Lease. Ergebnis-Frames müssen unter
  `jobs/<jobId>/frames/` liegen; die API prüft Präfix und SHA-256 jedes Frames (ADR 0023).
- Workern fehlen S3-Admin-Rechte. Ein kompromittierter Worker kann keine Frames anderer Jobs im
  gemeinsamen Cache vergiften; er kann höchstens `jobs/` beschreiben, und dort fällt jede Änderung
  an der Prüfsumme auf.
- Kindprozesse (Chromium, Blender, Piper, whisper.cpp) erben nur eine minimale Umgebung, keine Tokens
  und keine S3-Schlüssel.
- TSX-Projekte brauchen die Docker-Sandbox (ADR 0008). Im Cluster gibt es sie nicht.
  Die API meldet dann eine Diagnose. JSON-Projekte rendern ohne Einschränkung.
- Die API darf keine Assets per URL aus dem Internet laden. Erlauben Sie das bei Bedarf
  mit einer zusätzlichen NetworkPolicy für `app.kubernetes.io/component: api`.

### Verschlüsselung im Cluster (mTLS)

Koordinator, Worker und S3 sprechen Klartext-HTTP. Die Tokens und Frames sind dann im Pod-Netz
lesbar. Die NetworkPolicies begrenzen, wer mitlesen kann, verschlüsseln aber nicht. Für Cluster mit
fremden Workloads oder Knoten in mehreren Netzen empfehlen wir eine der folgenden Optionen:

- **Service Mesh mit mTLS**, zum Beispiel Linkerd (`linkerd.io/inject: enabled` am Namespace) oder
  Istio mit `PeerAuthentication` im Modus `STRICT`. Die Anwendung bleibt unverändert.
- **Verschlüsselung im CNI**, zum Beispiel Cilium mit WireGuard (`encryption.enabled=true`,
  `encryption.type=wireguard`) oder Calico mit WireGuard.
- **Eigener S3-Speicher mit TLS** (`OPENVIDEO_S3_ENDPOINT=https://…`).

Mit einem Mesh brauchen die Probes und KEDA ggf. Ausnahmen; prüfen Sie `kubectl -n openvideo get scaledobject` nach der Umstellung.

## Skalierung

KEDA skaliert jede Worker-Art über die Queue ihres Koordinators (`GET /v1/queue`):

| Trigger | Wert | Ziel je Worker |
|---|---|---|
| `queue-length` | wartende Chunks (`queueLength`) | 4 |
| `leases-active` | Chunks in Arbeit (`leasesActive`) | 1 |
| `cpu` (nur `worker-cpu`) | CPU-Auslastung | 75 % |

Der Trigger `leases-active` hält Worker am Leben, solange sie rendern.
Die CPU-Metrik braucht den `metrics-server` im Cluster.

Grenzen je Worker-Art:

| Worker | Minimum | Maximum |
|---|---|---|
| `worker-cpu` | 1 | 20 |
| `worker-gpu` | 0 | 4 |
| `worker-blender` | 0 | 4 |

Worker verkleinern sich langsam: höchstens ein Pod je Minute, nach 5 Minuten Ruhe.
Ein Worker, der beendet wird, gibt seinen Chunk an den Koordinator zurück.

Grenzen ändern (Beispiel für Ihr Overlay):

```yaml
patches:
  - target: { kind: ScaledObject, name: worker-cpu }
    patch: |-
      - { op: replace, path: /spec/maxReplicaCount, value: 50 }
```

Den Zustand ansehen:

```bash
kubectl -n openvideo get scaledobject,hpa
kubectl -n openvideo port-forward svc/coordinator 8080:8080
curl -H "Authorization: Bearer <metrics-token>" http://127.0.0.1:8080/v1/queue
```

### Skalierung über Prometheus

Das Overlay `prometheus` fügt jedem ScaledObject einen Trigger `render-duration` hinzu.
Er nutzt das 90. Perzentil der Metrik `render_duration` der letzten 5 Minuten.

Voraussetzungen:

- Prometheus läuft im Namespace `monitoring` unter `prometheus-operated:9090`.
- Prometheus sammelt `render_duration` (Histogramm in Sekunden) aus dem Namespace `openvideo`.

Das Overlay setzt in der API `OPENVIDEO_METRICS=prometheus`. Die API liefert ihre Metriken dann auf Port 9464.
Die NetworkPolicy `prometheus-scrape` erlaubt Prometheus den Zugriff auf Koordinator und API.

### Hochverfügbarkeit

Das Overlay `production-ha` (ADR 0027) setzt KEDA, Prometheus und den NVIDIA GPU Operator mit
DCGM-Exporter voraus, dazu mindestens drei Knoten:

```bash
kubectl apply -k deploy/k8s/overlays/production-ha
```

| Komponente | Replikate | Update | Unterbrechungen |
|---|---|---|---|
| `worker-cpu` | 2–20 (KEDA) | RollingUpdate, `maxUnavailable: 0`, über Knoten verteilt | PDB `maxUnavailable: 1` |
| `worker-gpu`, `worker-blender` | 0–4 (KEDA) | RollingUpdate, `maxSurge: 0` (keine zweite GPU nötig) | PDB `maxUnavailable: 1` |
| `studio` | 2 | RollingUpdate, `sessionAffinity: ClientIP` | PDB `minAvailable: 1` |
| `coordinator` | 1 (Single-Writer, Journal) | Recreate | kein PDB; `PriorityClass openvideo-critical` |
| `api` | 1 (Single-Writer, Workspace und Job-Manager) | Recreate | kein PDB; `PriorityClass openvideo-critical` |
| `object-storage` | 1 | – | für echte HA ein verwaltetes S3 über `OPENVIDEO_S3_*` nutzen |

Koordinator und API haben bewusst keine Leader-Wahl: Das RWO-PVC wirkt als Sperre, der neue Pod
startet erst nach dem alten. Worker geben Chunks beim Beenden zurück und holen sie nach dem
Neustart des Koordinators wieder; laufende Jobs stehen im Journal. Skalieren Sie diese beiden
Deployments nicht hoch (Annotation `openvideo.io/single-writer`).

**GPU-Autoscaling:** `worker-gpu` skaliert zusätzlich über die mittlere GPU-Auslastung
(`DCGM_FI_DEV_GPU_UTIL`, Schwelle 80 %) und den belegten GPU-Speicher (Schwelle 85 %). Die Abfragen
akzeptieren beide Label-Varianten des DCGM-Exporters (`pod`/`namespace` oder
`exported_pod`/`exported_namespace`). Prüfen Sie die Metrik vorab:

```bash
kubectl -n monitoring port-forward svc/prometheus-operated 9090
curl -s 'http://127.0.0.1:9090/api/v1/query?query=DCGM_FI_DEV_GPU_UTIL' | head -c 400
```

**Prüfen ohne Cluster:** `python3 deploy/test/check-manifests.py` baut alle Overlays mit einem
kleinen Kustomize-Nachbau und prüft Patch-Ziele, PDB-Selektoren, Single-Writer und die HA-Eigenschaften.
Mit kubectl zusätzlich: `kubectl kustomize deploy/k8s/overlays/production-ha`.

## Updates und Rollback

Jede Version hat ein eigenes Image-Tag. Ein Update ist ein neues Tag. Ein Rollback ist das alte Tag.

1. Ändern Sie in `overlays/production/kustomization.yaml` bei allen Images `newTag`,
   zum Beispiel von `0.1.0` auf `0.2.0`.
2. Wenden Sie das Overlay an:

   ```bash
   kubectl apply -k deploy/k8s/overlays/production
   ```

3. Verfolgen Sie das Update:

   ```bash
   kubectl -n openvideo rollout status deployment/api
   kubectl -n openvideo rollout status deployment/worker-cpu
   ```

Für einen Rollback setzen Sie `newTag` wieder auf die alte Version und wenden das Overlay an.
Für einen genauen Stand nutzen Sie das Tag `<version>-<git-sha>`.

Gut zu wissen:

- `api` und `coordinator` nutzen die Strategie `Recreate`. Sie sind kurz nicht erreichbar.
- Das Journal des Koordinators bleibt erhalten. Offene Chunks laufen nach dem Neustart weiter.
- Worker geben laufende Chunks beim Beenden zurück. Kein Chunk geht verloren.

## Fehlersuche

| Symptom | Prüfen | Lösung |
|---|---|---|
| Pod startet nicht, `CreateContainerConfigError` | `kubectl -n openvideo describe pod <pod>` | Secret `openvideo-secrets` fehlt oder hat einen falschen Schlüssel. |
| Pod wird abgelehnt: „violates PodSecurity“ | `kubectl -n openvideo get events` | Eigene Patches müssen die Regeln von `restricted` einhalten. |
| Init-Container `s3-bucket` wartet | `kubectl -n openvideo logs <pod> -c s3-bucket` | Object Storage ist nicht bereit, oder die S3-Zugangsdaten stimmen nicht. |
| Worker bleiben „nicht bereit“ | `kubectl -n openvideo logs deploy/worker-cpu` | Der Koordinator ist nicht erreichbar. Prüfen Sie Service und NetworkPolicy. |
| Worker melden `OV_WORKER_STORE_MISSING` | Logs des Workers | Koordinator und Worker nutzen verschiedene S3-Einstellungen. |
| Kein Hochskalieren | `kubectl -n openvideo describe scaledobject worker-cpu` | KEDA erreicht den Koordinator nicht, oder `metrics-token` ist falsch. |
| Koordinator startet nicht: `OV_COORDINATOR_TOKEN_WEAK` / `_SHARED` / `_REQUIRED` | `kubectl -n openvideo logs deploy/coordinator` | Tokens in `secrets.env` ersetzen: je Rolle ein eigener Wert, mindestens 24 Zeichen. |
| Worker melden `409 OV_COORDINATOR_LEASE_INVALID` | Logs des Workers | Die Lease ist abgelaufen (Heartbeat fehlte). Der Chunk läuft auf einem anderen Worker erneut. |
| Render scheitert mit `OV_SCHEDULER_CONTENT_MISMATCH` oder `OV_SCHEDULER_FRAME_FOREIGN` | Logs der API | Ein Frame im Speicher passt nicht zu seiner Prüfsumme. Prüfen Sie, wer auf `jobs/` schreiben darf. |
| Worker melden `AccessDenied` von S3 | Logs des Workers | Worker nutzen die Identität `worker`; sie dürfen nur `inputs/` lesen und `jobs/` schreiben. |
| Render mit HTML-Skripten scheitert: `OV_BROWSER_NO_OS_SANDBOX` | Diagnose des Renders | Chromium hat keine OS-Sandbox. Skripte entfernen oder einen Render-Host mit User Namespaces nutzen. |
| GPU-Worker bleibt `Pending` | `kubectl -n openvideo describe pod <pod>` | Kein Knoten mit `nvidia.com/gpu.present=true` oder freier GPU. |
| API antwortet 403 mit `OV_API_HOST` | Host-Header der Anfrage | Den Namen in `OPENVIDEO_ALLOWED_HOSTS` ergänzen. |
| API-Pod startet nicht: `OV_API_TOKEN_REQUIRED` | `kubectl -n openvideo logs deploy/api` | `api-token` im Secret fehlt oder ist leer. |
| Render meldet fehlenden Browser oder FFmpeg | `kubectl -n openvideo exec deploy/api -- openvideo doctor` | Falsches Image. Die API braucht `openvideo-render-cpu`. |

Logs sind JSON-Zeilen mit `trace_id`. So finden Sie alle Zeilen eines Renders über Pods hinweg:

```bash
kubectl -n openvideo logs -l app.kubernetes.io/component=worker --prefix | grep <trace_id>
```

## Tests

| Befehl | Prüft |
|---|---|
| `bash deploy/docker/build.sh` | Alle Images bauen. |
| `bash deploy/test/images.sh` | Jedes Image startet. `doctor` meldet FFmpeg, Chromium und Blender. Ein Frame und ein Video rendern ohne Netz und read-only. |
| `bash deploy/test/kind.sh` | kind-Cluster, KEDA, Overlay `local`. Ein Video über die API. Hochskalieren unter Queue-Last. Danach wird der Cluster gelöscht. |
| `python3 deploy/test/check-manifests.py` | Alle Overlays (auch `production-ha`) statisch bauen: gültiges YAML, jedes Patch-Ziel trifft, PDB-Selektoren, Single-Writer, HA-Eigenschaften. Braucht nur Python 3 mit PyYAML. |

`kind.sh` lädt `kind` und `kubectl` bei Bedarf nach `~/.local/bin` und prüft ihre Prüfsummen.
Mit `KEEP_CLUSTER=1` bleibt der Cluster für die Fehlersuche stehen.
