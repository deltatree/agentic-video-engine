#!/usr/bin/env node
// Startet den Render-Koordinator (`startCoordinator` aus @agentic-video/scheduler) im Container.
//
// Jede Warteschlange ist ein eigener Koordinator mit eigenem Port und eigenem Journal. So
// skaliert jede Worker-Art über ihre eigene Queue-Länge (`GET /v1/queue`).
//
// Umgebung:
//   OPENVIDEO_COORDINATOR_QUEUES  Liste "name:port", Standard "cpu:8080" (z. B. "cpu:8080,gpu:8081")
//   OPENVIDEO_JOURNAL_DIR         Ordner für die Journale, Standard "/data/journal"
//   OPENVIDEO_WORKER_TOKEN        Bearer-Token für alle /v1-Endpunkte (empfohlen)
//   OPENVIDEO_LEASE_SECONDS       Dauer einer Lease ohne Heartbeat, Standard 120
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
const token = env.OPENVIDEO_WORKER_TOKEN !== undefined && env.OPENVIDEO_WORKER_TOKEN !== '' ? env.OPENVIDEO_WORKER_TOKEN : undefined;
const journalRoot = env.OPENVIDEO_JOURNAL_DIR ?? '/data/journal';
const store = storeFromEnv(env, env.OPENVIDEO_CACHE_DIR ?? '/cache');

const running = [];
for (const q of queues) {
  const coordinator = await startCoordinator({ port: q.port, host: '0.0.0.0', store, journalDir: join(journalRoot, q.name), leaseSeconds, ...(token !== undefined ? { token } : {}) });
  running.push(coordinator);
  log('coordinator listening', { queue: q.name, port: coordinator.port, store: store.name, auth: token !== undefined });
}

const stop = async () => {
  log('coordinator stopping');
  await Promise.all(running.map((c) => c.close()));
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
