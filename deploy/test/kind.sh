#!/usr/bin/env bash
# Ende-zu-Ende-Test der Kubernetes-Manifeste in einem lokalen kind-Cluster.
#
# Ablauf:
#  1. kind und kubectl ohne sudo nach ~/.local/bin laden (Prüfsummen geprüft), falls sie fehlen.
#  2. Cluster anlegen, Images laden (vorher: bash deploy/docker/build.sh).
#  3. KEDA installieren (offizielles Release-Manifest, Version und SHA256 gepinnt).
#  4. kubectl apply -k deploy/k8s/overlays/local und warten, bis alles bereit ist.
#  5. Über die Agent API ein Projekt anlegen, ein kurzes Video rendern, das MP4 prüfen.
#  6. Künstliche Queue-Last am Koordinator erzeugen: worker-cpu muss hochskalieren, und die
#     Worker müssen den Job fertig rendern (Frames im Object Storage).
#  7. Cluster löschen (KEEP_CLUSTER=1 lässt ihn stehen).
#
# Umgebung: REGISTRY (Standard ghcr.io/deltatree), TAG (Standard: Version aus package.json),
#           CLUSTER (Standard openvideo-test), KEEP_CLUSTER=1.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY="${REGISTRY:-ghcr.io/deltatree}"
TAG="${TAG:-$(node -p "require('${root}/package.json').version")}"
CLUSTER="${CLUSTER:-openvideo-test}"
NS=openvideo
API_TOKEN=local-api-token-0123456789        # aus deploy/k8s/overlays/local/secret.yaml
# Rolle "submit" am Koordinator (Jobs einreichen und abfragen, Story 16.3).
SUBMIT_TOKEN=local-submit-token-0123456789

KIND_VERSION=v0.33.0
KIND_SHA256=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
KUBECTL_VERSION=v1.37.1
KUBECTL_SHA256=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
KEDA_VERSION=2.21.0
KEDA_SHA256=b43c89ffeef81722d7e2dd2c079d74789767a0f89cae1336cff784994814f6d7
SEAWEEDFS_IMAGE=chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882

bin="$HOME/.local/bin"
mkdir -p "$bin"
export PATH="$bin:$PATH"
work="$(mktemp -d)"
pids=()

log() { echo "==> $*"; }
fail() {
  echo "FAIL: $*" >&2
  echo "--- pods ---" >&2
  kubectl -n "$NS" get pods -o wide >&2 || true
  kubectl -n "$NS" get scaledobject,hpa >&2 || true
  exit 1
}
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ "${KEEP_CLUSTER:-0}" != 1 ]; then kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

# --- 1. Werkzeuge ---------------------------------------------------------------------------
fetch() { # $1 = Ziel, $2 = URL, $3 = SHA256
  curl -fsSL -o "$work/download" "$2"
  echo "$3  $work/download" | sha256sum -c --quiet - || { echo "Checksum mismatch for $2" >&2; exit 1; }
  install -m 0755 "$work/download" "$1"
}
if ! kind version 2>/dev/null | grep -q "$KIND_VERSION"; then
  log "kind $KIND_VERSION nach $bin"
  fetch "$bin/kind" "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-amd64" "$KIND_SHA256"
fi
if ! kubectl version --client 2>/dev/null | grep -q "$KUBECTL_VERSION"; then
  log "kubectl $KUBECTL_VERSION nach $bin"
  fetch "$bin/kubectl" "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" "$KUBECTL_SHA256"
fi

# --- 2. Cluster und Images ------------------------------------------------------------------
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
log "kind-Cluster $CLUSTER"
kind create cluster --name "$CLUSTER" --wait 180s
kubectl config use-context "kind-${CLUSTER}" >/dev/null

log "Images laden (Tag local)"
for name in base render-cpu blender studio worker; do
  src="${REGISTRY}/openvideo-${name}:${TAG}"
  docker image inspect "$src" >/dev/null 2>&1 || fail "$src is missing; run deploy/docker/build.sh first"
  docker tag "$src" "${REGISTRY}/openvideo-${name}:local"
  kind load docker-image --name "$CLUSTER" "${REGISTRY}/openvideo-${name}:local"
done
docker image inspect "$SEAWEEDFS_IMAGE" >/dev/null 2>&1 || docker pull -q "$SEAWEEDFS_IMAGE"
kind load docker-image --name "$CLUSTER" "$SEAWEEDFS_IMAGE" || log "SeaweedFS wird aus der Registry geladen"

# --- 3. KEDA --------------------------------------------------------------------------------
log "KEDA $KEDA_VERSION"
curl -fsSL -o "$work/keda.yaml" "https://github.com/kedacore/keda/releases/download/v${KEDA_VERSION}/keda-${KEDA_VERSION}.yaml"
echo "$KEDA_SHA256  $work/keda.yaml" | sha256sum -c --quiet - || fail "KEDA manifest checksum mismatch"
kubectl apply --server-side -f "$work/keda.yaml" >/dev/null
kubectl -n keda wait --for=condition=Available deployment --all --timeout=300s
kubectl wait --for=condition=Established crd/scaledobjects.keda.sh --timeout=60s

# --- 4. OpenVideo ---------------------------------------------------------------------------
log "kubectl apply -k deploy/k8s/overlays/local"
kubectl apply -k "${root}/deploy/k8s/overlays/local"
kubectl -n "$NS" rollout status statefulset/object-storage --timeout=300s
for d in coordinator api studio worker-cpu; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s || fail "deployment $d not ready"
done
kubectl -n "$NS" wait --for=condition=Ready scaledobject/worker-cpu --timeout=180s || fail "ScaledObject worker-cpu not ready"
kubectl -n "$NS" get pods -o wide

port_forward() { # $1 = Service, $2 = lokaler Port, $3 = Service-Port
  kubectl -n "$NS" port-forward "svc/$1" "$2:$3" >"$work/pf-$1.log" 2>&1 &
  pids+=($!)
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null "http://127.0.0.1:$2/"; then return 0; fi
    sleep 0.2
  done
  fail "port-forward to $1 failed: $(cat "$work/pf-$1.log")"
}
port_forward api 17788 7788
port_forward coordinator 18080 8080
api() { # $1 = Operation, $2 = JSON
  curl -fsS -H "Host: api" -H "Authorization: Bearer ${API_TOKEN}" -H 'content-type: application/json' -d "$2" "http://127.0.0.1:17788/v1/$1"
}
json() { node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const v=new Function("r",`return (${process.argv[1]})`)(JSON.parse(s));process.stdout.write(typeof v==="string"?v:JSON.stringify(v));})' "$1"; }

# Host-Allowlist: ein fremder Host-Header wird abgelehnt (403 OV_API_HOST).
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.example" -H "Authorization: Bearer ${API_TOKEN}" http://127.0.0.1:17788/v1/operations)"
[ "$code" = 403 ] || fail "api accepted a foreign Host header (HTTP $code)"

# --- 5. Projekt anlegen und Video über die API rendern ---------------------------------------
log "API: project.create und video.render"
project="$(cat "${root}/deploy/test/fixtures/hello/project.json")"
project_id="$(api project.create "{\"name\":\"kind test\",\"project\":${project}}" | json 'r.projectId')"
[ -n "$project_id" ] || fail "project.create returned no projectId"
job_id="$(api video.render "{\"projectId\":\"${project_id}\",\"profile\":{\"format\":\"mp4\",\"codec\":\"h264\"}}" | json 'r.jobId')"
[ -n "$job_id" ] || fail "video.render returned no jobId"
state=""
for _ in $(seq 1 180); do
  status="$(curl -fsS -H "Host: api" -H "Authorization: Bearer ${API_TOKEN}" "http://127.0.0.1:17788/v1/jobs/${job_id}")"
  state="$(json 'r.state' <<<"$status")"
  case "$state" in done | succeeded | failed | cancelled | canceled) break ;; esac
  sleep 1
done
[ "$state" = done ] || [ "$state" = succeeded ] || fail "render job ended as '$state': $status"
url="$(json '(JSON.stringify(r).match(/\/v1\/files\/[^"]*\.mp4/) || [""])[0]' <<<"$status")"
[ -n "$url" ] || fail "render job names no mp4 url: $status"
curl -fsS -H "Host: api" -H "Authorization: Bearer ${API_TOKEN}" -o "$work/video.mp4" "http://127.0.0.1:17788${url}" || fail "could not download ${url}"
[ "$(head -c 8 "$work/video.mp4" | tail -c 4)" = ftyp ] || fail "downloaded file is not an MP4: $(head -c 200 "$work/video.mp4")"
log "ok: video rendered through the API (${url##*/}, $(wc -c <"$work/video.mp4") bytes)"

# --- 6. Queue-Last am Koordinator: worker-cpu skaliert hoch ---------------------------------
log "Koordinator: künstliche Queue-Last (60 Chunks à 20 Frames, 1280x720)"
before="$(kubectl -n "$NS" get deployment worker-cpu -o jsonpath='{.status.replicas}')"
node - "$work/load.json" <<'EOF'
const out = process.argv[2];
const frames = 1200;
const project = {
  schemaVersion: '1.0.0',
  metadata: { title: 'queue load' },
  compositions: [{
    id: 'main', width: 1280, height: 720, fps: 30, duration: frames,
    background: '#101820',
    nodes: Array.from({ length: 24 }, (_, i) => ({
      id: `r${i}`, type: 'rect', x: (i % 6) * 200 + 40, y: Math.floor(i / 6) * 170 + 30, width: 160, height: 140, fill: i % 2 ? '#FF5A1F' : '#2F80ED',
      rotation: { $keyframes: [{ t: 0, v: 0 }, { t: frames, v: 360 * (i + 1) }] },
    })),
  }],
};
const chunks = [];
for (let s = 0; s < frames; s += 20) chunks.push({ compositionId: 'main', start: s, end: s + 20, scale: 1, step: 1, offset: 0 });
require('node:fs').writeFileSync(out, JSON.stringify({ project, files: [], chunks }));
EOF
load_job="$(curl -fsS -H "Authorization: Bearer ${SUBMIT_TOKEN}" -H 'content-type: application/json' --data-binary "@$work/load.json" http://127.0.0.1:18080/v1/jobs | json 'r.jobId')"
[ -n "$load_job" ] || fail "coordinator did not accept the job"
curl -fsS -H "Authorization: Bearer ${SUBMIT_TOKEN}" http://127.0.0.1:18080/v1/queue; echo
max=0
for _ in $(seq 1 90); do
  replicas="$(kubectl -n "$NS" get deployment worker-cpu -o jsonpath='{.spec.replicas}')"
  [ "${replicas:-0}" -gt "$max" ] && max="$replicas"
  [ "$max" -ge 2 ] && break
  sleep 2
done
[ "$max" -ge 2 ] || fail "worker-cpu did not scale up (replicas stayed at ${before})"
log "ok: worker-cpu scaled from ${before} to ${max} replicas"
kubectl -n "$NS" get hpa

log "Warten, bis die Worker den Job fertig gerendert haben"
jstate=""
for _ in $(seq 1 300); do
  jstatus="$(curl -fsS -H "Authorization: Bearer ${SUBMIT_TOKEN}" "http://127.0.0.1:18080/v1/jobs/${load_job}")"
  jstate="$(json 'r.state' <<<"$jstatus")"
  [ "$jstate" = running ] || break
  sleep 2
done
[ "$jstate" = done ] || fail "queue job ended as '$jstate': $(head -c 1000 <<<"$jstatus")"
workers="$(json '[...new Set(r.chunks.map((c) => c.result && c.result.worker))].filter(Boolean).length' <<<"$jstatus")"
log "ok: 60 chunks rendered by ${workers} worker(s)"
[ "$workers" -ge 2 ] || fail "only one worker rendered chunks"

echo "kind test passed."
