/**
 * Test-Worker für Pool-Tests (Story 18.8): spricht das stdio-Protokoll, rendert aber nichts.
 *
 * Aufruf: `node fake-worker.ts <modus> <protokolldatei>`; der Pool hängt `--stdio` an.
 * - `hang`: beantwortet keinen Chunk (bis `cancel` kommt).
 * - `hang-once`: hängt beim ersten Chunk (Marker-Datei `<protokolldatei>.once`), antwortet danach.
 * - `ignore-cancel`: beantwortet keinen Chunk und ignoriert auch `cancel` (Review Q6).
 * Jede empfangene Nachricht wird als Zeile `<typ>` an die Protokolldatei angehängt.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { MessageDecoder, encodeMessage } from '@agentic-video/scheduler';

const mode = process.argv[2] ?? 'hang';
const log = process.argv[3] ?? '';
const decoder = new MessageDecoder();

process.stdin.on('data', (chunk: Buffer) => {
  for (const m of decoder.push(chunk)) {
    if (log !== '') appendFileSync(log, `${m.type}\n`);
    if (m.type === 'shutdown') process.exit(0);
    if (m.type === 'cancel' && mode === 'ignore-cancel') continue;
    if (m.type === 'cancel') {
      process.stdout.write(encodeMessage({ type: 'error', id: m.id, diagnostic: { code: 'OV_RENDER_CANCELLED', severity: 'error', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] } }));
      continue;
    }
    if (m.type !== 'chunk') continue;
    const marker = `${log}.once`;
    if (mode === 'hang' || mode === 'ignore-cancel' || (mode === 'hang-once' && !existsSync(marker))) {
      if (mode === 'hang-once') writeFileSync(marker, '1');
      continue;
    }
    const n = m.request.end - m.request.start;
    const result = { start: m.request.start, end: m.request.end, frameHashes: Array.from({ length: n }, () => 'sha256:0'), keys: Array.from({ length: n }, (_, i) => `k${String(m.request.start + i)}`), rendered: n, fromCache: 0, diagnostics: [] };
    process.stdout.write(encodeMessage({ type: 'result', id: m.id, result }));
  }
});
process.stdin.on('end', () => process.exit(0));
