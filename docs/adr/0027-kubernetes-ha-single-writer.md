# ADR 0027: Hochverfügbarkeit auf Kubernetes – zustandslose Teile repliziert, Single-Writer bleiben einzeln

- Status: angenommen
- Datum: 2026-09-30

## Kontext

Die Basis-Manifeste (`deploy/k8s/base`) starten API, Koordinator, Studio und Object Storage mit je einer Replik und `Recreate`; es gab keine PodDisruptionBudgets und keinen Autoscaling-Trigger für die GPU-Auslastung (Audit 2026-09-30, §45). Drei Komponenten halten Zustand, den genau ein Prozess schreibt:

- **Koordinator:** Journal der Jobs, Chunks und Leases auf dem PVC `coordinator-journal` (RWO); Leases und Fristen leben im Prozess.
- **API:** Workspace auf dem PVC `api-workspace` (RWO) und ein Job-Manager im Prozess.
- **Object Storage (SeaweedFS):** ein Knoten mit Daten-PVC.

Eine Leader-Wahl mit mehreren Replikaten brächte für diese Teile keine höhere Verfügbarkeit ohne gemeinsames Journal (Datenbank, RWX-Volume), würde aber doppelte Schreiber möglich machen.

## Entscheidung

- Neues Overlay `deploy/k8s/overlays/production-ha` (auf `overlays/prometheus`).
- **Zustandslos und repliziert:** `worker-cpu` (mindestens 2 Replikate über KEDA, RollingUpdate mit `maxUnavailable: 0`, über Knoten verteilt), `studio` (2 Replikate, RollingUpdate, `sessionAffinity: ClientIP`, weil jede Replik ihren eigenen Workspace im `emptyDir` hat). GPU- und Blender-Worker: RollingUpdate mit `maxSurge: 0` (keine zweite GPU nötig).
- **PodDisruptionBudgets** für Studio und alle Worker-Klassen; keine PDBs für Einzel-Replikate (sie würden jeden Drain blockieren).
- **Single-Writer bleiben einzeln:** Koordinator und API behalten `replicas: 1` und `Recreate` – das RWO-PVC wirkt als Sperre, der neue Pod startet erst nach dem alten. Sie bekommen die `PriorityClass` `openvideo-critical` und eine Annotation `openvideo.io/single-writer`, damit niemand sie hochskaliert. Keine Leader-Wahl.
- **Wiederanlauf statt Replikat:** Worker geben Chunks bei SIGTERM zurück und wiederholen Aufrufe; der Koordinator stellt Jobs aus dem Journal wieder her. Ein Ausfall kostet damit Sekunden bis Minuten, keine Daten.
- **Object Storage:** Für echte HA ein verwaltetes S3 (oder SeaweedFS im verteilten Modus) über `OPENVIDEO_S3_*` nutzen; das eingebaute Ein-Knoten-SeaweedFS bleibt für kleine Installationen.
- **GPU-Autoscaling:** `worker-gpu` skaliert zusätzlich über die mittlere GPU-Auslastung (`DCGM_FI_DEV_GPU_UTIL`, Schwelle 80 %) und den belegten GPU-Speicher (`DCGM_FI_DEV_FB_USED/FREE`, Schwelle 85 %) aus dem DCGM-Exporter des NVIDIA GPU Operators (KEDA-Trigger `prometheus`).
- `deploy/test/check-manifests.py` prüft alle Overlays statisch (Patch-Ziele, PDB-Selektoren, Single-Writer, HA-Eigenschaften).

## Folgen

Knoten-Drains und Upgrades unterbrechen Worker und Studio nicht mehr vollständig. Koordinator und API bleiben kurze, bekannte Ausfallpunkte mit schnellem Neustart; wer mehr braucht, muss Journal und Workspace auf gemeinsamen Speicher mit Sperre verlagern (künftige Entscheidung). Das Overlay setzt KEDA, Prometheus und den DCGM-Exporter voraus.
