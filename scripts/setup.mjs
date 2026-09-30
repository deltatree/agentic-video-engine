#!/usr/bin/env node
// Richtet OpenVideo aus dem Quellcode ein (npm run setup, SETUP.md, ADR 0029).
//
// Standard ist ein Container: Docker, Podman oder Kubernetes – was nutzbar ist oder was der Nutzer mit
// --runtime (oder OPENVIDEO_RUNTIME) vorgibt. Das Image wird lokal mit der jeweiligen Technik gebaut
// (deploy/docker/Dockerfile, Ziel `local`), und der Befehl `openvideo` wird ein Wrapper, der es startet.
// Native (Node.js auf dem Host) nur als letzter Rückfall oder ausdrücklich gewählt.
//
// Aufbau: scripts/setup/options.mjs (Optionen), detect.mjs (Erkennung), image.mjs (Build-Befehle),
// wrapper.mjs (Befehl `openvideo`), kubernetes.mjs (Cluster), native.mjs, config.mjs, main.mjs (Ablauf).
// `npm run setup -- --help` nennt alle Optionen; `--dry-run` zeigt den Plan als JSON.
import { main } from './setup/main.mjs';

process.exitCode = await main(process.argv.slice(2));
