import { describe, expect, it } from 'vitest';
import { METRIC_NAMES, createTelemetry } from '@agentic-video/telemetry';

describe('Telemetrie (FR-92)', () => {
  it('meldet alle Metriken aus A46', async () => {
    const t = createTelemetry({ serviceName: 'test', exporter: 'memory', logSink: () => undefined });
    t.metrics.recordRenderDuration(1.5);
    t.metrics.recordFrameDuration(20);
    t.metrics.recordQueueWait(0.2);
    t.metrics.cacheHit('frame');
    t.metrics.cacheMiss('frame');
    t.metrics.workerFailure('crash');
    t.metrics.recordEncodingDuration(3);
    t.metrics.setGpuMemory(1024);
    const collected = await t.collectMetrics();
    const names = new Set(collected.flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.descriptor.name))));
    for (const name of METRIC_NAMES) expect(names.has(name), name).toBe(true);
    await t.shutdown();
  });

  it('trägt eine Trace-ID über verschachtelte und entfernte Spans', async () => {
    const lines: string[] = [];
    const t = createTelemetry({ serviceName: 'test', exporter: 'memory', logSink: (l) => lines.push(l) });
    let parent: string | undefined;
    await t.withSpan('job', { job: 'a' }, async () => {
      parent = t.traceparent();
      await t.withSpan('chunk', {}, async () => {
        await Promise.resolve();
        t.logger.info('rendering');
      });
    });
    // Worker in einem anderen Prozess setzt den Kontext aus traceparent fort
    await t.withRemoteParent(parent, () => t.withSpan('worker.chunk', {}, () => Promise.resolve()));
    const spans = t.finishedSpans();
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(spans.map((s) => s.name).sort()).toEqual(['chunk', 'job', 'worker.chunk']);
    expect(traceIds.size).toBe(1);
    const log = JSON.parse(lines[0] ?? '{}') as { trace_id?: string };
    expect(traceIds.has(log.trace_id ?? '')).toBe(true);
    await t.shutdown();
  });

  it('setzt den Fehlerstatus und reicht Fehler weiter', async () => {
    const t = createTelemetry({ serviceName: 'test', exporter: 'memory', logSink: () => undefined });
    await expect(t.withSpan('boom', {}, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(t.finishedSpans()[0]?.status.code).toBe(2);
    await t.shutdown();
  });
});
