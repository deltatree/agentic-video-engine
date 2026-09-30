# Running OpenVideo: Docker and Kubernetes

[Deutsche Fassung](README.de.md)

This document is for operators. It shows how to build OpenVideo as containers,
install it in Kubernetes, scale it, update it and troubleshoot it.

Prior knowledge: Docker, `kubectl` and Kustomize (built into `kubectl`).

## Overview

| Part | Job | Image |
|---|---|---|
| `api` | Agent API (`openvideo serve`). Renders JSON projects in its own pod. | `openvideo-render-cpu` |
| `studio` | Web interface with its own API. | `openvideo-studio` |
| `coordinator` | Distributes chunks to workers. One queue per worker kind. | `openvideo-base` |
| `worker-cpu` | Renders chunks on the CPU. | `openvideo-worker` |
| `worker-gpu` | Renders chunks on an NVIDIA GPU (NVENC; WebGL/WebGPU with `OPENVIDEO_BROWSER_GPU=1`). | `openvideo-render-gpu` |
| `worker-blender` | Renders chunks with Blender nodes. | `openvideo-blender` |
| `object-storage` | Shared S3 storage (SeaweedFS) for projects and frames. | `chrislusf/seaweedfs` (digest) |

A chunk is a range of frames, for example frames 0 to 29.
Workers fetch chunks from the coordinator (pull). They store the frames in S3 under
`jobs/<jobId>/frames/<sha256>`. The API accepts only frames with this prefix and checks the
SHA-256 of every frame (ADR 0023).

The queues of the coordinator:

| Queue | Port | Worker |
|---|---|---|
| `cpu` | 8080 | `worker-cpu` |
| `gpu` | 8081 | `worker-gpu` |
| `blender` | 8082 | `worker-blender` |

## Images

All images are built from `deploy/docker/Dockerfile`. Every target is one image.

| Image | Content |
|---|---|
| `openvideo-base` | Node 22, application, fonts. Entry point `openvideo`. |
| `openvideo-render-cpu` | `base` + FFmpeg 7.1 (Debian 13) + Chromium (Chrome for Testing, the revision of playwright-core). |
| `openvideo-render-gpu` | `render-cpu`, prepared for NVIDIA (NVENC; WebGL/WebGPU with `OPENVIDEO_BROWSER_GPU=1`, ADR 0019). |
| `openvideo-blender` | `render-cpu` + Blender 4.2.23 LTS. |
| `openvideo-studio` | `base` + Studio. Command `openvideo serve --host 0.0.0.0`. |
| `openvideo-worker` | `render-cpu`. Command `openvideo-worker`. |

Registry: `ghcr.io/deltatree/openvideo-<name>`.
Tags: the version from `package.json` (for example `0.1.0`) and `<version>-<git-sha>`.

Properties of all images:

- The process runs as user 65532, never as root.
- The root file system may be read-only. The only write paths are `/tmp` and `/cache`.
- The container needs no capabilities (`--cap-drop ALL`).
- `OPENVIDEO_CONTAINER_IMAGE` names the image. The value appears in the render manifest. It does not allow HTML scripts.
- The render manifest also names the detected GPU (`nvidia-smi` or `/dev/dri`), the actual
  Chromium version and the graphics mode. Hardware encoding (NVENC) is opt-in: `hardwareAcceleration` in the render profile.
- Labels `org.opencontainers.image.*` and `io.openvideo.*` name the versions.

Reproducibility:

- The base image is pinned by digest.
- apt loads only from `snapshot.debian.org` with a fixed date. Important packages have fixed versions.
- `npm ci` installs exactly the lockfile.
- The Blender and Chromium archives are checked by SHA256 (`ADD --checksum` and `sha256sum -c`).
  When playwright-core is updated, the build fails until revision and checksums in `chromium-fetch` match.
- `SOURCE_DATE_EPOCH` is the time of the last commit.

### Build the images

```bash
bash deploy/docker/build.sh
```

Result: all six images with both tags in the local Docker.

Options (environment variables):

| Variable | Effect |
|---|---|
| `TARGETS="base worker"` | Build only these targets. |
| `SOURCE=head` | Build exactly the commit `HEAD`, not the working tree. |
| `REGISTRY=…` | Another registry. |
| `PUSH=1` | Push to the registry (with provenance and SBOM). |

With `docker buildx`, provenance attestation and SBOM are created when the store can hold them.
This always applies when publishing. Locally it applies only with the containerd image store.

CI publishes the images on every `v*` tag (`.github/workflows/images.yml`).

### Use an image directly

Render a frame without network, read-only, without capabilities:

```bash
docker run --rm --read-only --cap-drop ALL --network none \
  --tmpfs /tmp --tmpfs /cache:uid=65532,gid=65532 \
  -v "$PWD/my-project:/project:ro" -v "$PWD/out:/out" \
  ghcr.io/deltatree/openvideo-render-cpu:0.1.0 \
  render-frame /project --frame 2s --out /out/frame.png
```

The folder `out` must be writable for UID 65532.

Start the Studio (or `openvideo serve`) on a network address:

```bash
docker run --rm -p 7788:7788 -e OPENVIDEO_API_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/deltatree/openvideo-studio:0.1.0
```

Server rules:

- On `0.0.0.0` the server starts only with `OPENVIDEO_API_TOKEN`. Otherwise it aborts with `OV_API_TOKEN_REQUIRED`.
- The server checks the Host header. `localhost:<port>` and `127.0.0.1:<port>` are allowed.
  Further names go into `OPENVIDEO_ALLOWED_HOSTS` (comma-separated) or `--allowed-host`.
  Other names get 403 (`OV_API_HOST`). `/v1/health` is exempt.
- POST requests need the header `content-type: application/json`.
- HTML scripts are off. They run only with `OPENVIDEO_ALLOW_HTML_SCRIPTS=1` (or `--trusted`) **and** when
  Chromium starts with the OS sandbox. Without the sandbox (typical in a container without user namespaces)
  a render with scripts aborts with `OV_BROWSER_NO_OS_SANDBOX` instead of running unprotected.
- The Studio files come with `Content-Security-Policy` (`frame-ancestors 'none'`, scripts only from its
  own origin), `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

Check the environment:

```bash
docker run --rm ghcr.io/deltatree/openvideo-render-cpu:0.1.0 doctor
```

### Render chunks in Docker containers (without Kubernetes)

`openvideo render --isolation docker` (or `OPENVIDEO_RENDER_ISOLATION=docker` for `serve`, `mcp` and the Studio)
starts one container per worker: without network, read-only, `--cap-drop ALL`, project via stdin, frames via stdout
back into the local cache. `--workers <n>` sets the number of containers.

```bash
openvideo render my-project --isolation docker --workers 2
# with a GPU quota (NVIDIA Container Toolkit) and browser GPU in the container:
OPENVIDEO_BROWSER_GPU=1 openvideo render my-project --isolation docker --gpus device=0
```

| Setting | Default | Meaning |
|---|---|---|
| `--image` / `OPENVIDEO_WORKER_IMAGE` | `ghcr.io/deltatree/openvideo-worker:<version>`, with a GPU quota `…/openvideo-render-gpu:<version>` | Worker image. |
| `--gpus` / `OPENVIDEO_WORKER_GPUS` | no GPU | `docker run --gpus`: `all`, a count (`2`) or devices (`device=0`, `0,1`, `device=GPU-<uuid>`). Sets `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics`. |
| `OPENVIDEO_BROWSER_GPU` | off | `1` passes the GPU mode of the browser renderer into the container (native ANGLE instead of SwiftShader; not bit-identical, separate cache keys). |
| `OPENVIDEO_DOCKER` | `docker` | Program for `docker run` (for example `podman`). |

Without an own image the GPU image starts `openvideo worker --stdio` (entry point `openvideo`), the worker image
`openvideo-worker --stdio`.

## Installation in Kubernetes

### Requirements

- Kubernetes 1.30 or newer, with a default StorageClass.
- A network plugin (CNI) that enforces NetworkPolicies (for example Calico, Cilium, kindnet from
  kind 0.24). **Required:** without such a plugin Kubernetes accepts the NetworkPolicies but does not
  enforce them. Then every pod reaches the coordinator and the S3 storage. Check this after the
  installation, for example from another namespace:
  `kubectl -n default run probe --rm -it --image=busybox --restart=Never -- wget -qO- -T 3 http://coordinator.openvideo:8080/metrics`
  must fail (timeout). If the coordinator answers, your CNI does not enforce NetworkPolicies.
- KEDA 2.21 in the namespace `keda`.
- For GPU workers: the NVIDIA GPU Operator. It sets the node label `nvidia.com/gpu.present=true`.

Install KEDA:

```bash
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.21.0/keda-2.21.0.yaml
```

### Steps

1. Create the secrets:

   ```bash
   cd deploy/k8s/overlays/production
   cp secrets.env.example secrets.env
   ```

2. Replace every value in `secrets.env`. Use only letters and digits, and a separate value for every
   key. Example of a value: `openssl rand -hex 32`.
   The coordinator does not start with `REPLACE…`, with tokens shorter than 24 characters or with the same token
   for two roles (`OV_COORDINATOR_TOKEN_WEAK`, `OV_COORDINATOR_TOKEN_SHARED`).
3. Check the manifests:

   ```bash
   kubectl kustomize deploy/k8s/overlays/production | less
   ```

4. Apply the manifests:

   ```bash
   kubectl apply -k deploy/k8s/overlays/production
   ```

5. Wait until all pods are ready:

   ```bash
   kubectl -n openvideo get pods -w
   ```

Result: API and Studio answer inside the cluster on port 7788.

The file `secrets.env` never belongs in the repository. The `.gitignore` in the overlay excludes it.

### Access from outside

API and Studio are services of type `ClusterIP`. Publish them through your ingress
or gateway. For testing a port forward is enough:

```bash
kubectl -n openvideo port-forward svc/api 7788:7788
curl http://127.0.0.1:7788/v1/health
curl -H "Authorization: Bearer <api-token>" http://127.0.0.1:7788/v1/operations
```

Use the same port 7788 locally. Otherwise the host check rejects the request.

The Studio expects the API token in the fragment of the address: `http://<studio>/#token=<api-token>`.
The fragment never goes to the server, into access logs or into the referrer. The Studio puts
the token into `sessionStorage` and removes it from the address. The Studio discards a `?token=` in the query
(it would otherwise end up in logs and in the history).

### Overlays

| Overlay | Purpose |
|---|---|
| `overlays/local` | kind or laptop: small resources, images with tag `local`, no GPU, fixed test tokens. |
| `overlays/production` | Images from ghcr.io with a fixed version, secrets from `secrets.env`. |
| `overlays/prometheus` | `production` plus scaling by render duration from Prometheus. |
| `overlays/production-ha` | `prometheus` plus high availability: PodDisruptionBudgets, replicas and RollingUpdate for Studio and workers, priority for the single writers, GPU autoscaling via DCGM (see [High availability](#high-availability)). |

## Configuration

The ConfigMap `openvideo-config` applies to all pods:

| Key | Default | Meaning |
|---|---|---|
| `OPENVIDEO_S3_ENDPOINT` | `http://object-storage:8333` | S3 address. |
| `OPENVIDEO_S3_BUCKET` | `openvideo` | Bucket for projects and frames. |
| `OPENVIDEO_S3_REGION` | `us-east-1` | Region for the S3 signature. |
| `OPENVIDEO_S3_CREATE_BUCKET` | `true` | Init containers create the bucket. |
| `OPENVIDEO_COORDINATOR_QUEUES` | `cpu:8080,gpu:8081,blender:8082` | Queues and ports of the coordinator. |
| `OPENVIDEO_LEASE_SECONDS` | `120` | How long a chunk is held without a heartbeat. |

Limits of the coordinator (environment of the pod `coordinator`, optional):

| Variable | Default | Meaning |
|---|---|---|
| `OPENVIDEO_COORDINATOR_MAX_BODY_BYTES` | `67108864` (64 MiB) | Largest request. The API uploads larger project files to storage itself beforehand as `inputs/sha256-…`. |
| `OPENVIDEO_JOB_TTL_SECONDS` | `86400` | How long a finished job stays retrievable. Afterwards the coordinator deletes it together with `jobs/<jobId>/` and compacts the journal. |

Built in: at most 10 000 chunks per job and 1000 running jobs (`429 OV_COORDINATOR_BUSY`).

Further variables in the deployments:

| Variable | Pod | Meaning |
|---|---|---|
| `OPENVIDEO_ALLOWED_HOSTS` | `api`, `studio` | Allowed Host headers. Default: the service names, for example `api,api.openvideo.svc`. |
| `OPENVIDEO_CACHE_DIR` | all | Frame cache, fixed `/cache` (emptyDir). |
| `OPENVIDEO_WORKSPACE` | `api` | Projects and jobs, `/workspace` (PVC). |
| `OPENVIDEO_COORDINATOR_URL` | `api` | Video renders go as chunks to this queue, default `http://coordinator:8080`. Without the variable the API renders itself. |
| `OPENVIDEO_TRUST_PROXY` | `api`, `studio` (optional) | `1` trusts `X-Forwarded-Proto` from any peer (TLS ingress on another node), for example for the `https` origin in the CSP of plugin panels. Without it: only from loopback. Same as `--trust-proxy` of `serve`/`dev`/`studio`. |
| `OPENVIDEO_SUBMIT_TOKEN` | `api`, `coordinator` | Token of the role `submit` (submit and query jobs). |
| `OPENVIDEO_WORKER_TOKEN` | workers, `coordinator` | Token of the role `worker` (`lease`, `heartbeat`, `complete`, `fail`). |
| `OPENVIDEO_METRICS_TOKEN` | `coordinator` | Token of the role `metrics` (KEDA, only `GET /v1/queue`). |
| `OPENVIDEO_ALLOW_HTML_SCRIPTS` | – | `1` allows HTML scripts, but only with the Chromium OS sandbox. Default: off. |
| `OPENVIDEO_METRICS` | `api` | `prometheus` exports metrics on port 9464 (`OPENVIDEO_METRICS_PORT`). The overlay `prometheus` sets it. |
| `OPENVIDEO_WORKERS` | `api` | Local worker processes when the API renders itself (without `OPENVIDEO_COORDINATOR_URL`). Default: cores − 1, limited by 1.5 GB per worker (ADR 0026). Set it explicitly in pods with CPU or memory limits: Node does not see the cgroup limits. |
| `OPENVIDEO_ENCODER_THREADS` | `api` | Threads of the video encoder. Default: fixed 4, so the video file is bit-identical across machines. `auto` uses the free cores next to the render processes (faster, file no longer bit-identical across machines; ADR 0026). |
| `OPENVIDEO_CACHE_MAX_BYTES` | `api`, workers | Upper limit of the local cache; after every video render OpenVideo removes the oldest entries down to it. Without a value: no cleanup. |
| `OPENVIDEO_CHUNK_TIMEOUT_MS` | `api` | Maximum duration of a chunk on a local worker process; afterwards the worker is stopped and the chunk repeated. |
| `OPENVIDEO_BROWSER_GPU` | `worker-gpu` (set: `1`) | `1` starts Chromium with native ANGLE on the GPU instead of SwiftShader (WebGL/WebGPU of `three` and `pixi`). Not bit-identical to CPU renders; the mode is part of the cache key and the manifest (ADR 0019). The base sets it only on the deployment `worker-gpu` (not in the ConfigMap); `deploy/test/check-manifests.py` checks this. Otherwise: off. |
| `OPENVIDEO_OUTPUT_CACHE` | `api` | `0` turns off the reuse of whole output files (cache tier `encoding`, ADR 0021). Default: on. |

If you reach API or Studio through an ingress name, add it in your overlay:

```yaml
patches:
  - target: { kind: Deployment, name: studio }
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/env/2/value
        value: studio,studio.openvideo.svc,studio.openvideo.svc.cluster.local,studio.example.com
```

Check the index (`env/2`) beforehand with `kubectl kustomize`.

The secret `openvideo-secrets` contains:

| Key | Meaning |
|---|---|
| `api-token` | Bearer token of the Agent API and the Studio. |
| `submit-token` | Coordinator role `submit`: only the API. |
| `worker-token` | Coordinator role `worker`: only the workers. |
| `metrics-token` | Coordinator role `metrics`: only KEDA, only `GET /v1/queue`. |
| `s3-admin-access-key-id`, `s3-admin-secret-access-key` | S3 identity `admin`: creates the bucket. Only the init containers `s3-bucket` get it. |
| `s3-api-access-key-id`, `s3-api-secret-access-key` | S3 identity `api`: API and coordinator, read and write in the bucket. |
| `s3-worker-access-key-id`, `s3-worker-secret-access-key` | S3 identity `worker`: reads only `inputs/`, reads and writes only `jobs/`. |

`base/object-storage.yaml` sets up the identities in SeaweedFS (path rules `Action:openvideo/<prefix>*`).
With `OPENVIDEO_S3_PREFIX` you adjust the path rules. Why the separation is needed: ADR 0023.

Use your own S3 storage (AWS S3, MinIO):

1. Create the bucket yourself.
2. Set `OPENVIDEO_S3_ENDPOINT` and `OPENVIDEO_S3_BUCKET` to your values.
3. Set `OPENVIDEO_S3_CREATE_BUCKET` to `false`.
4. Remove `object-storage` from your overlay with a patch (`$patch: delete`).
5. Allow the workers to reach your S3 in a NetworkPolicy of your own.
6. Create three identities with the same rights as above. Example of an IAM policy for the worker:
   `s3:GetObject` on `arn:aws:s3:::<bucket>/inputs/*` and `arn:aws:s3:::<bucket>/jobs/*`,
   `s3:PutObject` and `s3:DeleteObject` only on `arn:aws:s3:::<bucket>/jobs/*`.
7. Delete `inputs/` with a lifecycle rule (for example after 30 days). The coordinator
   deletes `jobs/<jobId>/` itself after the TTL.

The namespace is fixed to `openvideo`. The KEDA addresses in `base/autoscaling.yaml` name it.
Change it only together with these addresses.

## Security

- The namespace enforces Pod Security `restricted`.
- Every pod runs as user 65532, with a read-only root file system, without capabilities,
  with seccomp `RuntimeDefault` and without a service account token.
- `/tmp` and `/cache` are `emptyDir` volumes. Journal and API workspace live on PVCs.
- NetworkPolicies forbid all traffic that is not allowed:
  - Workers reach only the coordinator and the object storage.
  - No pod reaches `169.254.169.254`, other namespaces or the internet.
  - API and Studio are reachable from outside only on port 7788.
- Separate tokens at the coordinator (story 16.3): the API cannot lease chunks, a worker cannot submit
  jobs, KEDA can only read the queue length. Without a token the coordinator starts only on loopback.
- `complete` and `fail` are valid only with the `leaseId` of the current lease. Result frames must lie under
  `jobs/<jobId>/frames/`; the API checks prefix and SHA-256 of every frame (ADR 0023).
- Workers lack S3 admin rights. A compromised worker cannot poison frames of other jobs in the
  shared cache; at most it can write to `jobs/`, and there every change is caught by the checksum.
- Child processes (Chromium, Blender, Piper, whisper.cpp) inherit only a minimal environment, no tokens
  and no S3 keys.
- TSX projects need the Docker sandbox (ADR 0008). It does not exist in the cluster.
  The API then reports a diagnostic. JSON projects render without restriction.
- The API must not load assets by URL from the internet. Allow it if needed
  with an additional NetworkPolicy for `app.kubernetes.io/component: api`.

### Encryption inside the cluster (mTLS)

Coordinator, workers and S3 speak plain HTTP. Tokens and frames are then readable in the pod network.
The NetworkPolicies limit who can listen, but do not encrypt. For clusters with
foreign workloads or nodes in several networks we recommend one of the following options:

- **Service mesh with mTLS**, for example Linkerd (`linkerd.io/inject: enabled` on the namespace) or
  Istio with `PeerAuthentication` in mode `STRICT`. The application stays unchanged.
- **Encryption in the CNI**, for example Cilium with WireGuard (`encryption.enabled=true`,
  `encryption.type=wireguard`) or Calico with WireGuard.
- **Own S3 storage with TLS** (`OPENVIDEO_S3_ENDPOINT=https://…`).

With a mesh, the probes and KEDA may need exceptions; check `kubectl -n openvideo get scaledobject` after the switch.

## Scaling

KEDA scales every worker kind by the queue of its coordinator (`GET /v1/queue`):

| Trigger | Value | Target per worker |
|---|---|---|
| `queue-length` | waiting chunks (`queueLength`) | 4 |
| `leases-active` | chunks in progress (`leasesActive`) | 1 |
| `cpu` (only `worker-cpu`) | CPU utilization | 75 % |

The trigger `leases-active` keeps workers alive while they render.
The CPU metric needs the `metrics-server` in the cluster.

Limits per worker kind:

| Worker | Minimum | Maximum |
|---|---|---|
| `worker-cpu` | 1 | 20 |
| `worker-gpu` | 0 | 4 |
| `worker-blender` | 0 | 4 |

Workers scale down slowly: at most one pod per minute, after 5 minutes of idleness.
A worker that is stopped returns its chunk to the coordinator.

Change the limits (example for your overlay):

```yaml
patches:
  - target: { kind: ScaledObject, name: worker-cpu }
    patch: |-
      - { op: replace, path: /spec/maxReplicaCount, value: 50 }
```

Look at the state:

```bash
kubectl -n openvideo get scaledobject,hpa
kubectl -n openvideo port-forward svc/coordinator 8080:8080
curl -H "Authorization: Bearer <metrics-token>" http://127.0.0.1:8080/v1/queue
```

### Scaling with Prometheus

The overlay `prometheus` adds a trigger `render-duration` to every ScaledObject.
It uses the 90th percentile of the metric `render_duration` over the last 5 minutes.

Requirements:

- Prometheus runs in the namespace `monitoring` as `prometheus-operated:9090`.
- Prometheus scrapes `render_duration` (histogram in seconds) from the namespace `openvideo`.

The overlay sets `OPENVIDEO_METRICS=prometheus` in the API. The API then serves its metrics on port 9464.
The NetworkPolicy `prometheus-scrape` allows Prometheus to reach coordinator and API.

### High availability

The overlay `production-ha` (ADR 0027) requires KEDA, Prometheus and the NVIDIA GPU Operator with
DCGM exporter, plus at least three nodes:

```bash
kubectl apply -k deploy/k8s/overlays/production-ha
```

| Component | Replicas | Update | Disruptions |
|---|---|---|---|
| `worker-cpu` | 2–20 (KEDA) | RollingUpdate, `maxUnavailable: 0`, spread across nodes | PDB `maxUnavailable: 1` |
| `worker-gpu`, `worker-blender` | 0–4 (KEDA) | RollingUpdate, `maxSurge: 0` (no second GPU needed) | PDB `maxUnavailable: 1` |
| `studio` | 2 | RollingUpdate, `sessionAffinity: ClientIP` | PDB `minAvailable: 1` |
| `coordinator` | 1 (single writer, journal) | Recreate | no PDB; `PriorityClass openvideo-critical` |
| `api` | 1 (single writer, workspace and job manager) | Recreate | no PDB; `PriorityClass openvideo-critical` |
| `object-storage` | 1 | – | for real HA use a managed S3 via `OPENVIDEO_S3_*` |

Coordinator and API deliberately have no leader election: the RWO PVC acts as a lock, the new pod
starts only after the old one. Workers return chunks when they stop and fetch them again after the
coordinator restarts; running jobs are in the journal. Do not scale these two
deployments up (annotation `openvideo.io/single-writer`).

**GPU autoscaling:** `worker-gpu` also scales by the mean GPU utilization
(`DCGM_FI_DEV_GPU_UTIL`, threshold 80 %) and the used GPU memory (threshold 85 %). The queries
accept both label variants of the DCGM exporter (`pod`/`namespace` or
`exported_pod`/`exported_namespace`). Check the metric beforehand:

```bash
kubectl -n monitoring port-forward svc/prometheus-operated 9090
curl -s 'http://127.0.0.1:9090/api/v1/query?query=DCGM_FI_DEV_GPU_UTIL' | head -c 400
```

**Check without a cluster:** `python3 deploy/test/check-manifests.py` builds all overlays with a
small Kustomize re-implementation and checks patch targets, PDB selectors, single writers and the HA properties.
With kubectl additionally: `kubectl kustomize deploy/k8s/overlays/production-ha`.

## Updates and rollback

Every version has its own image tag. An update is a new tag. A rollback is the old tag.

1. In `overlays/production/kustomization.yaml` change `newTag` for all images,
   for example from `0.1.0` to `0.2.0`.
2. Apply the overlay:

   ```bash
   kubectl apply -k deploy/k8s/overlays/production
   ```

3. Follow the update:

   ```bash
   kubectl -n openvideo rollout status deployment/api
   kubectl -n openvideo rollout status deployment/worker-cpu
   ```

For a rollback set `newTag` back to the old version and apply the overlay.
For an exact state use the tag `<version>-<git-sha>`.

Good to know:

- `api` and `coordinator` use the strategy `Recreate`. They are briefly unreachable.
- The coordinator journal is kept. Open chunks continue after the restart.
- Workers return running chunks when they stop. No chunk is lost.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Pod does not start, `CreateContainerConfigError` | `kubectl -n openvideo describe pod <pod>` | Secret `openvideo-secrets` is missing or has a wrong key. |
| Pod is rejected: "violates PodSecurity" | `kubectl -n openvideo get events` | Own patches must follow the rules of `restricted`. |
| Init container `s3-bucket` waits | `kubectl -n openvideo logs <pod> -c s3-bucket` | Object storage is not ready, or the S3 credentials are wrong. |
| Workers stay "not ready" | `kubectl -n openvideo logs deploy/worker-cpu` | The coordinator is not reachable. Check service and NetworkPolicy. |
| Workers report `OV_WORKER_STORE_MISSING` | Worker logs | Coordinator and workers use different S3 settings. |
| No scale-up | `kubectl -n openvideo describe scaledobject worker-cpu` | KEDA does not reach the coordinator, or `metrics-token` is wrong. |
| Coordinator does not start: `OV_COORDINATOR_TOKEN_WEAK` / `_SHARED` / `_REQUIRED` | `kubectl -n openvideo logs deploy/coordinator` | Replace the tokens in `secrets.env`: a separate value per role, at least 24 characters. |
| Workers report `409 OV_COORDINATOR_LEASE_INVALID` | Worker logs | The lease expired (heartbeat missing). The chunk runs again on another worker. |
| Render fails with `OV_SCHEDULER_CONTENT_MISMATCH` or `OV_SCHEDULER_FRAME_FOREIGN` | API logs | A frame in storage does not match its checksum. Check who may write to `jobs/`. |
| Workers report `AccessDenied` from S3 | Worker logs | Workers use the identity `worker`; they may only read `inputs/` and write `jobs/`. |
| Render with HTML scripts fails: `OV_BROWSER_NO_OS_SANDBOX` | Diagnostic of the render | Chromium has no OS sandbox. Remove the scripts or use a render host with user namespaces. |
| GPU worker stays `Pending` | `kubectl -n openvideo describe pod <pod>` | No node with `nvidia.com/gpu.present=true` or a free GPU. |
| API answers 403 with `OV_API_HOST` | Host header of the request | Add the name to `OPENVIDEO_ALLOWED_HOSTS`. |
| API pod does not start: `OV_API_TOKEN_REQUIRED` | `kubectl -n openvideo logs deploy/api` | `api-token` in the secret is missing or empty. |
| Render reports a missing browser or FFmpeg | `kubectl -n openvideo exec deploy/api -- openvideo doctor` | Wrong image. The API needs `openvideo-render-cpu`. |

Logs are JSON lines with `trace_id`. This finds all lines of a render across pods:

```bash
kubectl -n openvideo logs -l app.kubernetes.io/component=worker --prefix | grep <trace_id>
```

## Tests

| Command | Checks |
|---|---|
| `bash deploy/docker/build.sh` | Build all images. |
| `bash deploy/test/images.sh` | Every image starts. `doctor` reports FFmpeg, Chromium and Blender. A frame and a video render without network and read-only. |
| `bash deploy/test/kind.sh` | kind cluster, KEDA, overlay `local`. A video through the API. Scale-up under queue load. Afterwards the cluster is deleted. |
| `python3 deploy/test/check-manifests.py` | Build all overlays (including `production-ha`) statically: valid YAML, every patch target hits, PDB selectors, single writers, HA properties. Needs only Python 3 with PyYAML. |

`kind.sh` downloads `kind` and `kubectl` to `~/.local/bin` if needed and checks their checksums.
With `KEEP_CLUSTER=1` the cluster stays up for troubleshooting.
