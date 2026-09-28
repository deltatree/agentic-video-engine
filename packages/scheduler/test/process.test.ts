import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { renderVideo, type NodeEnvironment } from '@agentic-video/render';
import { createProcessChunkRunner, type SchedulerEvent } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { makeEnv, project, tempProjectDir } from './fixture.js';

const profile = { format: 'mp4', codec: 'h264' };
let reference: readonly string[];
const envs: NodeEnvironment[] = [];

async function freshEnv(prefix: string, telemetry?: Parameters<typeof makeEnv>[1]): Promise<{ dir: string; env: NodeEnvironment }> {
  const dir = tempProjectDir(prefix);
  const env = await makeEnv(dir, telemetry);
  envs.push(env);
  return { dir, env };
}

beforeAll(async () => {
  // Referenz: lokaler Render in einem Prozess.
  const { dir, env } = await freshEnv('ov-sched-ref-');
  const r = await renderVideo(env, project, { outPath: join(dir, 'out', 'ref.mp4'), profile, chunkSize: 10, noAudio: true });
  reference = r.manifest.frameHashes;
  expect(reference).toHaveLength(90);
});

afterAll(async () => {
  for (const env of envs) await env.dispose();
});

describe('Prozess-Worker (Story 10.1)', () => {
  it('90 Frames auf 3 Prozessen ergeben dieselben Frame-Hashes wie lokal (FR-9)', async () => {
    const { dir, env } = await freshEnv('ov-sched-proc-');
    const runChunks = createProcessChunkRunner({ concurrency: 3, projectDir: dir, project, cache: env.cache, telemetry: env.telemetry });
    const r = await renderVideo(env, project, { outPath: join(dir, 'out', 'p.mp4'), profile, chunkSize: 10, noAudio: true, runChunks });
    expect(r.manifest.frameHashes).toEqual(reference);
    const workers = new Set(r.manifest.chunks.map((c) => c.worker));
    expect(workers.size).toBeGreaterThanOrEqual(2);
    expect([...workers].every((w) => typeof w === 'string' && w.startsWith('process-'))).toBe(true);
    expect(r.manifest.cache.framesRendered).toBe(90);
  });

  it('rendert nach einem getöteten Worker nur dessen Chunk neu; das Video ist vollständig', async () => {
    const { dir, env } = await freshEnv('ov-sched-kill-');
    const events: SchedulerEvent[] = [];
    let killed: string | undefined;
    const runChunks = createProcessChunkRunner({
      concurrency: 3,
      projectDir: dir,
      project,
      cache: env.cache,
      telemetry: env.telemetry,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'chunk-started' && e.start === 30 && killed === undefined && e.pid !== undefined) {
          killed = e.worker;
          process.kill(e.pid, 'SIGKILL');
        }
      },
    });
    const r = await renderVideo(env, project, { outPath: join(dir, 'out', 'k.mp4'), profile, chunkSize: 10, noAudio: true, runChunks });
    expect(r.manifest.frameHashes).toEqual(reference);
    const retries = events.flatMap((e) => (e.type === 'chunk-retry' ? [e] : []));
    expect(retries.map((e) => e.start)).toEqual([30]);
    const starts = events.flatMap((e) => (e.type === 'chunk-started' ? [e] : []));
    // Jeder andere Chunk lief genau einmal; nur Chunk 30 zweimal, auf einem anderen Worker.
    expect(starts).toHaveLength(10);
    const again = starts.filter((e) => e.start === 30);
    expect(again.map((e) => e.attempt)).toEqual([1, 2]);
    expect(again[1]?.worker).not.toBe(killed);
    expect(r.manifest.chunks.find((c) => c.start === 30)?.worker).not.toBe(killed);
    expect(events.some((e) => e.type === 'worker-exited' && e.worker === killed && e.signal === 'SIGKILL')).toBe(true);
    // Ersatz-Worker wurde gestartet.
    expect(events.filter((e) => e.type === 'worker-started').length).toBe(4);
  });

  it('alle Spans und Worker-Logs tragen dieselbe Trace-ID (FR-92)', async () => {
    const lines: string[] = [];
    const telemetry = createTelemetry({ serviceName: 'caller', exporter: 'memory', logSink: (l) => lines.push(l) });
    const { dir, env } = await freshEnv('ov-sched-trace-', telemetry);
    const runChunks = createProcessChunkRunner({ concurrency: 3, projectDir: dir, project, cache: env.cache, telemetry });
    const traceId = await telemetry.withSpan('job', {}, async (span) => {
      await renderVideo(env, project, { outPath: join(dir, 'out', 't.mp4'), profile, chunkSize: 10, noAudio: true, runChunks });
      return span.spanContext().traceId;
    });
    const spans = telemetry.finishedSpans();
    expect(spans.filter((s) => s.name === 'scheduler.chunk')).toHaveLength(9);
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));
    const workerLines = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['message'] === 'chunk rendered');
    expect(workerLines).toHaveLength(9);
    expect(new Set(workerLines.map((l) => l['trace_id']))).toEqual(new Set([traceId]));
    expect(workerLines.every((l) => typeof l['worker'] === 'string' && l['worker'].startsWith('process-'))).toBe(true);
  });
});
