#!/usr/bin/env bash
# Baut alle OpenVideo-Images aus deploy/docker/Dockerfile mit festen Tags.
#
# Tags je Image: <registry>/openvideo-<ziel>:<version> und :<version>-<git-sha>.
# Die Version kommt aus package.json im Root, der Git-SHA aus HEAD.
#
# Umgebung:
#   REGISTRY   Ziel-Registry (Standard ghcr.io/deltatree)
#   TARGETS    Liste der Ziele (Standard: base render-cpu render-gpu blender studio worker)
#   PUSH=1     Images in die Registry schieben statt lokal laden (CI)
#   PLATFORM   Zielplattform (Standard linux/amd64; Blender und Chromium gibt es hier nur für amd64)
#   SOURCE     "worktree" (Standard): Arbeitsbaum bauen. "head": genau den Commit HEAD bauen
#              (git archive); nur deploy/docker kommt aus dem Arbeitsbaum.
#
# Mit docker buildx entstehen Provenance-Attestierung und SBOM, wenn der Speicher sie
# unterstützt (Registry oder containerd-Image-Store).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

REGISTRY="${REGISTRY:-ghcr.io/deltatree}"
TARGETS="${TARGETS:-base render-cpu render-gpu blender studio worker}"
PLATFORM="${PLATFORM:-linux/amd64}"
PUSH="${PUSH:-0}"

VERSION="$(node -p "require('./package.json').version")"
REVISION="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=12 HEAD)"
SOURCE="${SOURCE:-worktree}"
context="$root"
case "$SOURCE" in
  worktree) dirty_paths=(. ':!deploy/k8s' ':!deploy/test' ':!deploy/README.md') ;;
  head)
    context="$(mktemp -d)"
    trap 'rm -rf "$context"' EXIT
    git archive HEAD | tar -x -C "$context"
    rm -rf "$context/deploy/docker"
    mkdir -p "$context/deploy"
    cp -a deploy/docker "$context/deploy/docker"
    dirty_paths=(deploy/docker)
    ;;
  *) echo "build.sh: SOURCE must be 'worktree' or 'head'." >&2; exit 2 ;;
esac
# Ein Build aus geänderten Dateien bekommt ".dirty", damit kein Tag lügt.
if [ -n "$(git status --porcelain --untracked-files=normal -- "${dirty_paths[@]}" 2>/dev/null)" ]; then
  SHORT="${SHORT}.dirty"
fi
IMAGE_TAG="${VERSION}-${SHORT}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
CREATED="$(date -u -d "@${SOURCE_DATE_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"

common=(
  --file "$context/deploy/docker/Dockerfile"
  --platform "$PLATFORM"
  --build-arg "VERSION=${VERSION}"
  --build-arg "REVISION=${REVISION}"
  --build-arg "IMAGE_REGISTRY=${REGISTRY}"
  --build-arg "IMAGE_TAG=${IMAGE_TAG}"
  --build-arg "CREATED=${CREATED}"
  --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
)

use_buildx=0
if docker buildx version >/dev/null 2>&1; then use_buildx=1; fi

attest=()
output=()
if [ "$use_buildx" = 1 ]; then
  if [ "$PUSH" = 1 ]; then
    attest=(--provenance=mode=max --sbom=true)
    output=(--output "type=registry,rewrite-timestamp=true")
  else
    # Der klassische Docker-Speicher kann keine Attestierungen halten, der containerd-Speicher schon.
    if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter'; then
      attest=(--provenance=mode=max --sbom=true)
    else
      echo "build.sh: Docker image store without attestation support; building without provenance/SBOM." >&2
    fi
    output=(--output "type=docker,rewrite-timestamp=true")
  fi
elif [ "$PUSH" = 1 ]; then
  echo "build.sh: PUSH=1 needs docker buildx." >&2
  exit 2
fi

for target in $TARGETS; do
  image="${REGISTRY}/openvideo-${target}"
  tags=(--tag "${image}:${VERSION}" --tag "${image}:${IMAGE_TAG}")
  echo "==> ${image} (${VERSION}, ${IMAGE_TAG})"
  if [ "$use_buildx" = 1 ]; then
    docker buildx build "${common[@]}" "${attest[@]}" "${output[@]}" --target "$target" "${tags[@]}" "$context"
  else
    DOCKER_BUILDKIT=1 docker build "${common[@]}" --target "$target" "${tags[@]}" "$context"
  fi
done

echo "Built: ${TARGETS} (tags ${VERSION}, ${IMAGE_TAG})"
