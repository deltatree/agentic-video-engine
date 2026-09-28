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
Worker holen sich Chunks beim Koordinator ab (Pull). Die Frames legen sie im S3-Speicher ab.

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
| `openvideo-render-cpu` | `base` + FFmpeg 7.1 (Debian 13) + Chromium (Playwright). |
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
- `OPENVIDEO_CONTAINER_IMAGE` nennt das Image. Der Wert steht im Render-Manifest.
- Labels `org.opencontainers.image.*` und `io.openvideo.*` nennen die Versionen.

Reproduzierbarkeit:

- Das Basis-Image ist per Digest gepinnt.
- apt lädt nur von `snapshot.debian.org` mit festem Datum. Wichtige Pakete haben feste Versionen.
- `npm ci` installiert genau das Lockfile.
- Das Blender-Archiv wird per SHA256 geprüft.
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
- HTML-Skripte laufen nur, wenn `OPENVIDEO_CONTAINER_IMAGE` gesetzt ist. Die Images setzen die Variable.

Die Umgebung prüfen:

```bash
docker run --rm ghcr.io/deltatree/openvideo-render-cpu:0.1.0 doctor
```

## Installation in Kubernetes

### Voraussetzungen

- Kubernetes 1.30 oder neuer, mit einer Standard-StorageClass.
- Ein Netzwerk-Plugin, das NetworkPolicies durchsetzt (zum Beispiel Calico, Cilium, kindnet).
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

2. Ersetzen Sie jeden Wert in `secrets.env`. Nutzen Sie nur Buchstaben und Ziffern.
   Beispiel für einen Wert: `openssl rand -hex 32`.
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

Das Studio erwartet das API-Token in der Adresse: `http://<studio>/?token=<api-token>`.

### Overlays

| Overlay | Zweck |
|---|---|
| `overlays/local` | kind oder Laptop: kleine Ressourcen, Images mit Tag `local`, keine GPU, feste Test-Tokens. |
| `overlays/production` | Images aus ghcr.io mit fester Version, Geheimnisse aus `secrets.env`. |
| `overlays/prometheus` | `production` plus Skalierung über die Render-Dauer aus Prometheus. |

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

Weitere Variablen in den Deployments:

| Variable | Pod | Bedeutung |
|---|---|---|
| `OPENVIDEO_ALLOWED_HOSTS` | `api`, `studio` | Erlaubte Host-Header. Standard: die Service-Namen, zum Beispiel `api,api.openvideo.svc`. |
| `OPENVIDEO_CACHE_DIR` | alle | Frame-Cache, fest `/cache` (emptyDir). |
| `OPENVIDEO_WORKSPACE` | `api` | Projekte und Jobs, `/workspace` (PVC). |
| `OPENVIDEO_COORDINATOR_URL` | `api` | Video-Renders gehen als Chunks an diese Queue, Standard `http://coordinator:8080`. Ohne die Variable rendert die API selbst. |
| `OPENVIDEO_METRICS` | `api` | `prometheus` exportiert Metriken auf Port 9464 (`OPENVIDEO_METRICS_PORT`). Das Overlay `prometheus` setzt das. |

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
| `worker-token` | Token zwischen Koordinator, Workern und KEDA. |
| `s3-access-key-id` | S3-Zugang. |
| `s3-secret-access-key` | S3-Schlüssel. |

Eigenen S3-Speicher nutzen (AWS S3, MinIO):

1. Legen Sie den Bucket selbst an.
2. Setzen Sie `OPENVIDEO_S3_ENDPOINT` und `OPENVIDEO_S3_BUCKET` auf Ihre Werte.
3. Setzen Sie `OPENVIDEO_S3_CREATE_BUCKET` auf `false`.
4. Entfernen Sie `object-storage` mit einem Patch (`$patch: delete`) aus Ihrem Overlay.
5. Erlauben Sie den Workern den Weg zu Ihrem S3 in einer eigenen NetworkPolicy.

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
- TSX-Projekte brauchen die Docker-Sandbox (ADR 0008). Im Cluster gibt es sie nicht.
  Die API meldet dann eine Diagnose. JSON-Projekte rendern ohne Einschränkung.
- Die API darf keine Assets per URL aus dem Internet laden. Erlauben Sie das bei Bedarf
  mit einer zusätzlichen NetworkPolicy für `app.kubernetes.io/component: api`.

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
curl -H "Authorization: Bearer <worker-token>" http://127.0.0.1:8080/v1/queue
```

### Skalierung über Prometheus

Das Overlay `prometheus` fügt jedem ScaledObject einen Trigger `render-duration` hinzu.
Er nutzt das 90. Perzentil der Metrik `render_duration` der letzten 5 Minuten.

Voraussetzungen:

- Prometheus läuft im Namespace `monitoring` unter `prometheus-operated:9090`.
- Prometheus sammelt `render_duration` (Histogramm in Sekunden) aus dem Namespace `openvideo`.

Das Overlay setzt in der API `OPENVIDEO_METRICS=prometheus`. Die API liefert ihre Metriken dann auf Port 9464.
Die NetworkPolicy `prometheus-scrape` erlaubt Prometheus den Zugriff auf Koordinator und API.

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
| Kein Hochskalieren | `kubectl -n openvideo describe scaledobject worker-cpu` | KEDA erreicht den Koordinator nicht, oder `worker-token` ist falsch. |
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

`kind.sh` lädt `kind` und `kubectl` bei Bedarf nach `~/.local/bin` und prüft ihre Prüfsummen.
Mit `KEEP_CLUSTER=1` bleibt der Cluster für die Fehlersuche stehen.
