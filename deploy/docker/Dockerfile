# syntax=docker/dockerfile:1.7
#
# Offizielle OpenVideo-Images (A44). Ein Dockerfile, mehrere Ziele (`--target`):
#
#   base        Node 22, Anwendung (dist + Produktions-node_modules), Schriften, Nutzer, Einstieg `openvideo`
#   render-cpu  base + FFmpeg 7.1 (Debian 13) + Chromium (Playwright, passend zu playwright-core)
#   render-gpu  render-cpu, vorbereitet für NVIDIA (NVENC lädt libnvidia-encode zur Laufzeit)
#   blender     render-cpu + Blender 4.2 LTS (SHA256 geprüft)
#   studio      base + gebautes Studio, Befehl `openvideo serve --host 0.0.0.0`
#   worker      render-cpu, Befehl `openvideo-worker`
#
# Bauen: `bash deploy/docker/build.sh` (Kontext ist die Wurzel des Repositorys).
#
# Reproduzierbarkeit: Basis-Image per Digest, apt nur über snapshot.debian.org mit festem Datum,
# feste Paketversionen, `npm ci` mit Lockfile, Blender-Archiv mit SHA256, SOURCE_DATE_EPOCH.
#
# Sicherheit (A24, ADR 0008): Nutzer 65532, keine Capabilities nötig, Root-FS darf read-only sein.
# Schreibpfade: nur /tmp und /cache.

ARG NODE_IMAGE=node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4

# ---------------------------------------------------------------------------------------------
# os: Basis mit apt über snapshot.debian.org (festes Datum = Datum des Basis-Images)
# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS os
ARG DEBIAN_SNAPSHOT=20260918T000000Z
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN rm -f /etc/apt/sources.list.d/* /etc/apt/sources.list \
 && printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: trixie trixie-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: trixie-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\n' \
      "${DEBIAN_SNAPSHOT}" "${DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/debian.sources \
 && printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\nAPT::Install-Suggests "false";\n' > /etc/apt/apt.conf.d/80openvideo \
 # Hilfsbefehl: installiert Pakete und entfernt Listen, Logs und Caches mit Zeitstempeln.
 && printf '#!/bin/sh\nset -eu\napt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"\nrm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/cache/apt/archives/*.deb /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache /var/cache/debconf/*-old\n' > /usr/local/sbin/ov-apt \
 && chmod 0755 /usr/local/sbin/ov-apt

# ---------------------------------------------------------------------------------------------
# compile: npm ci (Lockfile) und Build aller Pakete
# ---------------------------------------------------------------------------------------------
FROM os AS compile
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund
# Alle TypeScript-Pakete (auch die, die tsconfig.json im Root noch nicht referenziert) und
# danach die Zusatzschritte der Pakete ("build:extra"). Das Studio baut ein eigenes Ziel.
RUN node node_modules/typescript/bin/tsc -b tsconfig.json packages/*/tsconfig.json \
 && for dir in packages/*; do \
      if node -e "process.exit(require('./${dir}/package.json').scripts?.['build:extra'] ? 0 : 1)"; then \
        (cd "${dir}" && npm run build:extra --silent); \
      fi; \
    done

# ---------------------------------------------------------------------------------------------
# studio-build: gebautes Studio (apps/studio/dist)
# ---------------------------------------------------------------------------------------------
FROM compile AS studio-build
RUN cd apps/studio && npm run build:extra --silent && test -f dist/index.html

# ---------------------------------------------------------------------------------------------
# app: nur Laufzeit-Dateien (Produktions-node_modules, dist und die "files" jedes Pakets)
# ---------------------------------------------------------------------------------------------
# Frische Installation ohne Entwicklungswerkzeuge, nur für die Pakete unter packages/ (das Studio
# ist ein fertiges Bundle und braucht zur Laufzeit keine node_modules).
FROM compile AS app
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    rm -rf node_modules packages/*/node_modules apps/*/node_modules \
 && npm ci --omit=dev --no-audit --no-fund $(for d in packages/*; do printf -- '--workspace=%s ' "$d"; done) \
 && node deploy/docker/stage.mjs /src /app

# ---------------------------------------------------------------------------------------------
# blender-fetch: Blender 4.2 LTS, Archiv per SHA256 geprüft
# ---------------------------------------------------------------------------------------------
FROM os AS blender-fetch
ARG BLENDER_VERSION=4.2.23
ARG BLENDER_SHA256=bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404
RUN ov-apt xz-utils
ADD --checksum=sha256:${BLENDER_SHA256} https://download.blender.org/release/Blender4.2/blender-${BLENDER_VERSION}-linux-x64.tar.xz /tmp/blender.tar.xz
RUN echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/blender \
 && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 --no-same-owner \
 && rm /tmp/blender.tar.xz

# ---------------------------------------------------------------------------------------------
# base
# ---------------------------------------------------------------------------------------------
FROM os AS base
ARG NODE_IMAGE
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG IMAGE_REGISTRY=ghcr.io/deltatree
ARG IMAGE_TAG=dev
ARG CREATED=1970-01-01T00:00:00Z
ARG DEBIAN_SNAPSHOT=20260918T000000Z
ARG TINI_VERSION=0.19.0-3+b8
ARG FONTCONFIG_VERSION=2.15.0-2.3
RUN ov-apt tini=${TINI_VERSION} fontconfig=${FONTCONFIG_VERSION} fonts-dejavu-core ca-certificates \
 # Nutzer ohne Login, UID/GID 65532. Direkt geschrieben, damit /etc/shadow kein Datum enthält.
 && echo 'openvideo:x:65532:65532:OpenVideo:/tmp:/usr/sbin/nologin' >> /etc/passwd \
 && echo 'openvideo:x:65532:' >> /etc/group \
 && mkdir -p /cache /app \
 && chown 65532:65532 /cache && chmod 0775 /cache
COPY --from=app /app /app
COPY --chmod=0755 deploy/docker/bin/openvideo deploy/docker/bin/openvideo-worker /usr/local/bin/
COPY deploy/docker/coordinator.mjs deploy/docker/s3-bucket.mjs deploy/docker/healthcheck.mjs /app/deploy/
ENV NODE_ENV=production \
    HOME=/tmp \
    OPENVIDEO_CACHE_DIR=/cache \
    OPENVIDEO_WORKSPACE=/cache/workspace \
    OPENVIDEO_CONTAINER_IMAGE=${IMAGE_REGISTRY}/openvideo-base:${IMAGE_TAG}
LABEL org.opencontainers.image.title="openvideo-base" \
      org.opencontainers.image.description="OpenVideo – Video-as-Code for coding agents (base image)" \
      org.opencontainers.image.source="https://github.com/deltatree/agentic-video-engine" \
      org.opencontainers.image.url="https://github.com/deltatree/agentic-video-engine" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="deltatree" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="docker.io/library/${NODE_IMAGE}" \
      io.openvideo.version="${VERSION}" \
      io.openvideo.node="22" \
      io.openvideo.debian-snapshot="${DEBIAN_SNAPSHOT}"
USER 65532:65532
WORKDIR /cache
VOLUME ["/cache"]
ENTRYPOINT ["/usr/bin/tini", "--", "openvideo"]
CMD ["--help"]

# ---------------------------------------------------------------------------------------------
# render-cpu: FFmpeg 7.1 (Debian 13) und Chromium (Playwright)
# ---------------------------------------------------------------------------------------------
FROM base AS render-cpu
ARG IMAGE_REGISTRY=ghcr.io/deltatree
ARG IMAGE_TAG=dev
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
USER 0:0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# Playwright installiert genau die Chromium-Revision, die zu playwright-core passt, samt
# Systembibliotheken (über dieselben Snapshot-Quellen).
RUN ov-apt ffmpeg=${FFMPEG_VERSION} \
 && node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache /tmp/* \
 && chmod -R a+rX /opt/ms-playwright \
 && ffmpeg -hide_banner -version | head -1
ENV OPENVIDEO_FFMPEG=/usr/bin/ffmpeg \
    OPENVIDEO_FFPROBE=/usr/bin/ffprobe \
    OPENVIDEO_CONTAINER_IMAGE=${IMAGE_REGISTRY}/openvideo-render-cpu:${IMAGE_TAG}
LABEL org.opencontainers.image.title="openvideo-render-cpu" \
      org.opencontainers.image.description="OpenVideo render image: FFmpeg and Chromium (CPU)" \
      io.openvideo.ffmpeg="${FFMPEG_VERSION}" \
      io.openvideo.playwright-core="1.63.0" \
      io.openvideo.chromium="153.0.8010.12"
USER 65532:65532

# ---------------------------------------------------------------------------------------------
# render-gpu: wie render-cpu, vorbereitet für NVIDIA
# ---------------------------------------------------------------------------------------------
# Debians FFmpeg enthält NVENC (h264_nvenc, hevc_nvenc, av1_nvenc) und lädt libnvidia-encode zur
# Laufzeit. Den Treiber bindet das NVIDIA Container Toolkit beim Start ein.
FROM render-cpu AS render-gpu
ARG IMAGE_REGISTRY=ghcr.io/deltatree
ARG IMAGE_TAG=dev
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics \
    NVIDIA_VISIBLE_DEVICES=all \
    OPENVIDEO_CONTAINER_IMAGE=${IMAGE_REGISTRY}/openvideo-render-gpu:${IMAGE_TAG}
LABEL org.opencontainers.image.title="openvideo-render-gpu" \
      org.opencontainers.image.description="OpenVideo render image prepared for NVIDIA GPUs (NVENC)"

# ---------------------------------------------------------------------------------------------
# blender: render-cpu + Blender 4.2 LTS
# ---------------------------------------------------------------------------------------------
FROM render-cpu AS blender
ARG IMAGE_REGISTRY=ghcr.io/deltatree
ARG IMAGE_TAG=dev
ARG BLENDER_VERSION=4.2.23
ARG BLENDER_SHA256=bea0eb3146be13eae6225409a117b215184f41b7f79e799f97cb3abb8f6dc404
USER 0:0
# Bibliotheken für Blender im Hintergrundmodus (-b); Eevee braucht libEGL (Mesa).
RUN ov-apt libegl1 libegl-mesa0 libglx-mesa0 libgl1 libxi6 libxkbcommon0 libsm6 libice6 libxxf86vm1 libxfixes3 libxrender1 libx11-6 libxext6
COPY --from=blender-fetch /opt/blender /opt/blender
ENV OPENVIDEO_BLENDER=/opt/blender/blender \
    OPENVIDEO_CONTAINER_IMAGE=${IMAGE_REGISTRY}/openvideo-blender:${IMAGE_TAG}
LABEL org.opencontainers.image.title="openvideo-blender" \
      org.opencontainers.image.description="OpenVideo render image with Blender LTS" \
      io.openvideo.blender="${BLENDER_VERSION}" \
      io.openvideo.blender-sha256="${BLENDER_SHA256}"
USER 65532:65532

# ---------------------------------------------------------------------------------------------
# studio: base + gebautes Studio
# ---------------------------------------------------------------------------------------------
# Auf 0.0.0.0 startet der Server nur mit OPENVIDEO_API_TOKEN. Weitere Host-Namen (Service,
# Ingress) stehen in OPENVIDEO_ALLOWED_HOSTS. Beides setzt der Betreiber beim Start.
FROM base AS studio
ARG IMAGE_REGISTRY=ghcr.io/deltatree
ARG IMAGE_TAG=dev
COPY --from=studio-build /src/apps/studio/dist /app/apps/studio/dist
ENV OPENVIDEO_STUDIO_DIR=/app/apps/studio/dist \
    OPENVIDEO_CONTAINER_IMAGE=${IMAGE_REGISTRY}/openvideo-studio:${IMAGE_TAG}
LABEL org.opencontainers.image.title="openvideo-studio" \
      org.opencontainers.image.description="OpenVideo Studio with Agent API"
EXPOSE 7788
CMD ["serve", "--host", "0.0.0.0", "--port", "7788"]

# ---------------------------------------------------------------------------------------------
# worker: render-cpu, Befehl openvideo-worker
# ---------------------------------------------------------------------------------------------
# `docker run … openvideo-worker-image --stdio` (Docker-Runner) oder
# `--coordinator http://coordinator:8080` (Kubernetes).
FROM render-cpu AS worker
ARG IMAGE_REGISTRY=ghcr.io/deltatree
ARG IMAGE_TAG=dev
ENV OPENVIDEO_CONTAINER_IMAGE=${IMAGE_REGISTRY}/openvideo-worker:${IMAGE_TAG}
LABEL org.opencontainers.image.title="openvideo-worker" \
      org.opencontainers.image.description="OpenVideo render worker"
ENTRYPOINT ["/usr/bin/tini", "--", "openvideo-worker"]
CMD ["--stdio"]
