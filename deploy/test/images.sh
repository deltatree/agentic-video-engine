#!/usr/bin/env bash
# Prüft die gebauten OpenVideo-Images (vorher: bash deploy/docker/build.sh).
#
# 1. Jedes Image startet, läuft als UID 65532 und trägt Versions-Labels.
# 2. `openvideo doctor --json` im render-cpu-Image meldet FFmpeg und Chromium "ok".
# 3. `openvideo doctor --json` im blender-Image meldet Blender "ok".
# 4. Ein Frame und ein kurzes Video eines JSON-Projekts rendern im render-cpu-Image mit
#    --read-only --cap-drop ALL --network none; das Render-Manifest nennt das Image.
# 5. Das Studio-Image liefert die Oberfläche und /v1/health.
#
# Umgebung: REGISTRY (Standard ghcr.io/deltatree), TAG (Standard: Version aus package.json).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY="${REGISTRY:-ghcr.io/deltatree}"
TAG="${TAG:-$(node -p "require('${root}/package.json').version")}"
fixture="${root}/deploy/test/fixtures/hello"
work="$(mktemp -d)"
studio_container="openvideo-images-test-$$"
cleanup() {
  docker rm -f "$studio_container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

passed=0
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() {
  echo "ok   $*"
  passed=$((passed + 1))
}
img() { echo "${REGISTRY}/openvideo-$1:${TAG}"; }

# Sichere Laufzeitoptionen wie in ADR 0008 (Schreibpfade nur /tmp und /cache).
secure=(--rm --read-only --cap-drop ALL --security-opt no-new-privileges
  --tmpfs /tmp:rw,exec,size=1g --tmpfs /cache:rw,size=1g,uid=65532,gid=65532)

# --- 1. Jedes Image startet --------------------------------------------------------------
for name in base render-cpu render-gpu blender studio; do
  image="$(img "$name")"
  docker image inspect "$image" >/dev/null 2>&1 || fail "$image is missing; run deploy/docker/build.sh first"
  version="$(docker run "${secure[@]}" --network none "$image" --version)"
  [ "$version" = "$TAG" ] || [ -n "$version" ] || fail "$image: --version printed nothing"
  uid="$(docker run "${secure[@]}" --network none --entrypoint id "$image" -u)"
  [ "$uid" = "65532" ] || fail "$image runs as UID $uid, expected 65532"
  label="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
  [ -n "$label" ] || fail "$image has no org.opencontainers.image.version label"
  cimg="$(docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^OPENVIDEO_CONTAINER_IMAGE=//p')"
  [[ "$cimg" == "${REGISTRY}/openvideo-${name}:"* ]] || fail "$image: OPENVIDEO_CONTAINER_IMAGE is '$cimg'"
  ok "$name starts (openvideo $version, UID $uid, label $label)"
done

# Der Worker liest das Protokoll über stdin; ohne Eingabe endet er sofort und sauber.
worker="$(img worker)"
docker image inspect "$worker" >/dev/null 2>&1 || fail "$worker is missing"
set +e
docker run "${secure[@]}" --network none -i "$worker" --stdio </dev/null >/dev/null 2>"$work/worker.err"
code=$?
docker run "${secure[@]}" --network none "$worker" --name probe >/dev/null 2>"$work/usage.err"
usage=$?
set -e
[ "$code" -le 1 ] || fail "worker --stdio exited with $code: $(cat "$work/worker.err")"
[ "$usage" = 2 ] && grep -q 'openvideo-worker' "$work/usage.err" || fail "worker without --stdio/--coordinator should print usage (exit 2), got $usage"
ok "worker starts (openvideo-worker --stdio, usage without a mode)"

gpu_encoders="$(docker run "${secure[@]}" --network none --entrypoint ffmpeg "$(img render-gpu)" -hide_banner -encoders)"
grep -q h264_nvenc <<<"$gpu_encoders" || fail "render-gpu: FFmpeg has no h264_nvenc"
[ "$(docker image inspect "$(img render-gpu)" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^NVIDIA_')" = 2 ] || fail "render-gpu: NVIDIA_* variables missing"
ok "render-gpu has NVENC encoders and NVIDIA variables"

# --- 2. doctor im render-cpu-Image ---------------------------------------------------------
check_status() { # $1 = JSON, $2 = Name der Prüfung
  node -e 'const r = JSON.parse(process.argv[1]); const c = r.checks.find((x) => x.name === process.argv[2]); process.stdout.write(c ? `${c.status} ${c.detail}` : "missing");' "$1" "$2"
}
doctor="$(docker run "${secure[@]}" --network none "$(img render-cpu)" doctor --json || true)"
for check in ffmpeg browser; do
  status="$(check_status "$doctor" "$check")"
  [[ "$status" == ok* ]] || fail "render-cpu doctor: $check is '$status'"
  ok "render-cpu doctor: $check $status"
done

# --- 3. doctor im blender-Image -------------------------------------------------------------
doctor="$(docker run "${secure[@]}" --network none "$(img blender)" doctor --json || true)"
status="$(check_status "$doctor" blender)"
[[ "$status" == ok* ]] || fail "blender doctor: blender is '$status'"
ok "blender doctor: blender $status"

# --- 4. Frame und Video im render-cpu-Image, ohne Netz, read-only, ohne Capabilities ------
# Die CLI schreibt Arbeitsdateien in den Projektordner (.openvideo/). Das Projekt kommt daher
# read-only nach /src und wird im Container nach /tmp kopiert.
in_container() { # $1 = Befehl im Container (sh)
  docker run "${secure[@]}" --network none -v "${fixture}:/src:ro" --entrypoint sh "$(img render-cpu)" \
    -c "cp -r /src /tmp/project && $1"
}
in_container 'openvideo render-frame /tmp/project --frame 15 --out /tmp/frame.png --json' >"$work/frame.json" 2>"$work/frame.err" \
  || fail "render-frame failed: $(cat "$work/frame.err")"
node -e 'const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (r.width !== 320 || r.height !== 180) throw new Error(JSON.stringify(r));' "$work/frame.json" \
  || fail "render-frame output: $(cat "$work/frame.json")"
# Das PNG selbst prüfen: über stdout aus dem Container holen.
in_container 'openvideo render-frame /tmp/project --frame 15 --out /tmp/frame.png >/dev/null && cat /tmp/frame.png' >"$work/frame.png"
[ "$(head -c 8 "$work/frame.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || fail "render-frame did not produce a PNG"
ok "render-cpu renders a frame (320x180 PNG, $(wc -c <"$work/frame.png") bytes) with --read-only --cap-drop ALL --network none"

in_container 'openvideo render /tmp/project --out /tmp/video.mp4 --json >/tmp/r.json && node -e "const r=require(\"/tmp/r.json\"); process.stdout.write(require(\"node:fs\").readFileSync(r.manifest, \"utf8\"))"' \
  >"$work/manifest.json" 2>"$work/render.err" || fail "render failed: $(cat "$work/render.err")"
image_ref="$(grep -o '"containerImage": *"[^"]*"' "$work/manifest.json" | head -1 | sed 's/.*: *"//; s/"$//')"
[[ "$image_ref" == "${REGISTRY}/openvideo-render-cpu:"* ]] \
  || fail "render manifest does not name the container image: $(head -c 600 "$work/manifest.json")"
ok "render-cpu renders a video; manifest names ${image_ref}"

# --- 5. Studio -----------------------------------------------------------------------------
# Auf 0.0.0.0 startet der Server nur mit Token (OV_API_TOKEN_REQUIRED).
docker run -d --name "$studio_container" "${secure[@]:1}" -e OPENVIDEO_API_TOKEN=images-test-token -p 127.0.0.1::7788 "$(img studio)" >/dev/null
port="$(docker port "$studio_container" 7788 | head -1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${port}/v1/health" | grep -q true || fail "studio: /v1/health does not answer"
# Der Server prüft den Host-Header; "localhost:7788" ist immer erlaubt.
curl -fsS -H 'Host: localhost:7788' "http://127.0.0.1:${port}/" | grep -qi '<html' || fail "studio: / does not serve the Studio"
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: localhost:7788' "http://127.0.0.1:${port}/v1/operations")"
[ "$code" = 401 ] || fail "studio: /v1/operations without token should be 401, got $code"
curl -fsS -H 'Host: localhost:7788' -H 'Authorization: Bearer images-test-token' "http://127.0.0.1:${port}/v1/operations" | grep -q project.create \
  || fail "studio: /v1/operations with token failed"
ok "studio serves the UI, /v1/health, and the API only with token"

echo "All image tests passed (${passed} checks)."
