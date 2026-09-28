#!/usr/bin/env node
// Einfache HTTP-Prüfung für Probes und HEALTHCHECK: Exit 0, wenn GET <url> mit 2xx antwortet.
//
// Aufruf: node /app/deploy/healthcheck.mjs <url> [zeitgrenze-ms]
// Beispiel (Worker-Readiness): node /app/deploy/healthcheck.mjs http://coordinator:8080/metrics
const [url, timeout = '3000'] = process.argv.slice(2);
if (url === undefined) {
  process.stderr.write('Usage: node healthcheck.mjs <url> [timeout-ms]\n');
  process.exit(2);
}
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(Number(timeout)) });
  await res.arrayBuffer();
  process.exit(res.ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`healthcheck: ${url}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
