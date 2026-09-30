#!/usr/bin/env node
// Startet den Render-Koordinator (`startCoordinator` aus @agentic-video/scheduler) im Container.
//
// Jede Warteschlange ist ein eigener Koordinator mit eigenem Port und eigenem Journal. So
// skaliert jede Worker-Art über ihre eigene Queue-Länge (`GET /v1/queue`).
//
// Umgebung:
//   OPENVIDEO_COORDINATOR_QUEUES  Liste "name:port", Standard "cpu:8080" (z. B. "cpu:8080,gpu:8081")
//   OPENVIDEO_JOURNAL_DIR         Ordner für die Journale, Standard "/data/journal"
//   OPENVIDEO_SUBMIT_TOKEN        Token der Rolle "submit" (Agent API: Jobs einreichen und abfragen)
//   OPENVIDEO_WORKER_TOKEN        Token der Rolle "worker" (lease, heartbeat, complete, fail)
//   OPENVIDEO_METRICS_TOKEN       Token der Rolle "metrics" (KEDA, nur GET /v1/queue)
//                                 Pflicht: je mindestens 24 Zeichen, verschieden, kein "REPLACE…" (Epic 16).
//   OPENVIDEO_LEASE_SECONDS       Dauer einer Lease ohne Heartbeat, Standard 120
//   OPENVIDEO_COORDINATOR_MAX_BODY_BYTES  Größte Anfrage, Standard 67108864 (64 MiB)
//   OPENVIDEO_JOB_TTL_SECONDS     Fertige Jobs bleiben so lange abrufbar, Standard 86400
//   OPENVIDEO_S3_*                Gemeinsamer Speicher (siehe @agentic-video/cache)
import { join } from 'node:path';
import { storeFromEnv } from '@agentic-video/cache';
import { startCoordinator } from '@agentic-video/scheduler';

const env = process.env;
const log = (msg, fields = {}) => process.stdout.write(`${JSON.stringify({ level: 'info', msg, service: 'openvideo-coordinator', ...fields })}\n`);

const queues = (env.OPENVIDEO_COORDINATOR_QUEUES ?? 'cpu:8080')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '')
  .map((entry) => {
    const match = /^([a-z0-9-]+):([0-9]{1,5})$/u.exec(entry);
    if (match === null) {
      process.stderr.write(`OPENVIDEO_COORDINATOR_QUEUES: "${entry}" is not "name:port" (example: "cpu:8080,gpu:8081").\n`);
      process.exit(2);
    }
    return { name: match[1], port: Number(match[2]) };
  });

const leaseSeconds = Number(env.OPENVIDEO_LEASE_SECONDS ?? '120');
if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
  process.stderr.write('OPENVIDEO_LEASE_SECONDS must be a positive number.\n');
  process.exit(2);
}
const positive = (name, fallback) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    process.stderr.write(`${name} must be a positive integer.\n`);
    process.exit(2);
  }
  return value;
};
const nonEmpty = (value) => (value !== undefined && value !== '' ? value : undefined);
const tokens = {
  ...(nonEmpty(env.OPENVIDEO_SUBMIT_TOKEN) !== undefined ? { submit: env.OPENVIDEO_SUBMIT_TOKEN } : {}),
  ...(nonEmpty(env.OPENVIDEO_WORKER_TOKEN) !== undefined ? { worker: env.OPENVIDEO_WORKER_TOKEN } : {}),
  ...(nonEmpty(env.OPENVIDEO_METRICS_TOKEN) !== undefined ? { metrics: env.OPENVIDEO_METRICS_TOKEN } : {}),
};
const maxBodyBytes = positive('OPENVIDEO_COORDINATOR_MAX_BODY_BYTES', undefined);
const jobTtlSeconds = positive('OPENVIDEO_JOB_TTL_SECONDS', undefined);
const limits = { ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}), ...(jobTtlSeconds !== undefined ? { jobTtlSeconds } : {}) };
const journalRoot = env.OPENVIDEO_JOURNAL_DIR ?? '/data/journal';
const store = storeFromEnv(env, env.OPENVIDEO_CACHE_DIR ?? '/cache');

const running = [];
for (const q of queues) {
  // startCoordinator bricht ohne Token, mit schwachen oder mit gleichen Tokens ab (Epic 16).
  const coordinator = await startCoordinator({ port: q.port, host: '0.0.0.0', store, journalDir: join(journalRoot, q.name), leaseSeconds, tokens, ...limits });
  running.push(coordinator);
  log('coordinator listening', { queue: q.name, port: coordinator.port, store: store.name, roles: Object.keys(tokens) });
}

const stop = async () => {
  log('coordinator stopping');
  await Promise.all(running.map((c) => c.close()));
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
