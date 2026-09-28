/**
 * @packageDocumentation
 * Observability für OpenVideo (FR-92, A46): OpenTelemetry-Metriken und Traces,
 * W3C-Trace-Kontext über Prozess- und Maschinengrenzen, strukturierte JSON-Logs mit Trace-IDs.
 *
 * @example
 * ```ts
 * const telemetry = createTelemetry({ serviceName: 'openvideo-worker', exporter: 'otlp' });
 * await telemetry.withSpan('render.chunk', { frames: 30 }, async () => renderChunk());
 * ```
 */
import { context, propagation, trace, SpanStatusCode, type Attributes, type Meter, type Span, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  ConsoleMetricExporter,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OpenVideoError } from '@agentic-video/core';

/** Die Metriken aus Auftrag A46. */
export const METRIC_NAMES = [
  'render_duration',
  'frame_duration',
  'queue_wait',
  'cache_hits',
  'cache_misses',
  'worker_failures',
  'gpu_memory',
  'cpu_usage',
  'encoding_duration',
] as const;

/** Instrumente für alle OpenVideo-Metriken. */
export interface OpenVideoMetrics {
  /** Dauer eines ganzen Render Jobs in Sekunden. */
  recordRenderDuration(seconds: number, attributes?: Attributes): void;
  /** Dauer eines Frames in Millisekunden. */
  recordFrameDuration(ms: number, attributes?: Attributes): void;
  /** Wartezeit eines Chunks in der Queue in Sekunden. */
  recordQueueWait(seconds: number, attributes?: Attributes): void;
  cacheHit(tier: string, count?: number): void;
  cacheMiss(tier: string, count?: number): void;
  workerFailure(reason: string): void;
  /** Encoding-Dauer in Sekunden. */
  recordEncodingDuration(seconds: number, attributes?: Attributes): void;
  /** Meldet GPU-Speicher in Bytes, sobald eine GPU-Messung vorliegt. */
  setGpuMemory(bytes: number | undefined): void;
}

/** Log-Stufen. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Strukturierter Logger; jede Zeile trägt `trace_id` und `span_id`, falls ein Span aktiv ist. */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Optionen für {@link createTelemetry}. */
export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** `none` (Standard), `memory` (Tests), `console`, `otlp` (HTTP, `OTEL_EXPORTER_OTLP_ENDPOINT`), `prometheus` (Pull auf `prometheusPort`). */
  readonly exporter?: 'none' | 'memory' | 'console' | 'otlp' | 'prometheus';
  readonly otlpEndpoint?: string;
  readonly prometheusPort?: number;
  readonly logLevel?: LogLevel;
  /** Ziel für Log-Zeilen (Standard: stderr). */
  readonly logSink?: (line: string) => void;
  /** Export-Intervall für Metriken in ms (Standard 10 000). */
  readonly metricIntervalMs?: number;
}

/** Eine eingerichtete Telemetrie-Instanz (kein globaler Zustand außer dem OTel-Kontextmanager). */
export interface Telemetry {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly metrics: OpenVideoMetrics;
  readonly logger: Logger;
  /** Führt `fn` in einem Span aus; Fehler setzen den Span-Status und werden weitergereicht. */
  withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T>;
  /** W3C-`traceparent` des aktuellen Kontexts, z. B. für Worker-Aufträge. */
  traceparent(): string | undefined;
  /** Führt `fn` mit einem entfernten Eltern-Span aus (aus `traceparent`). */
  withRemoteParent<T>(traceparent: string | undefined, fn: () => Promise<T>): Promise<T>;
  /** Nur bei `exporter: 'memory'`: beendete Spans. */
  finishedSpans(): readonly ReadableSpan[];
  /** Nur bei `exporter: 'memory'`: aktuelle Metriken einsammeln. */
  collectMetrics(): Promise<readonly ResourceMetrics[]>;
  shutdown(): Promise<void>;
}

let contextManagerInstalled = false;

function installContext(): void {
  if (contextManagerInstalled) return;
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  contextManagerInstalled = true;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Richtet Traces, Metriken und Logs ein.
 *
 * @example
 * ```ts
 * const t = createTelemetry({ serviceName: 'openvideo-api', exporter: 'prometheus', prometheusPort: 9464 });
 * t.metrics.cacheHit('frame');
 * ```
 */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  installContext();
  const exporter = options.exporter ?? 'none';
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName, [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.1.0' });

  const memorySpans = new InMemorySpanExporter();
  const processors: SpanProcessor[] = [];
  if (exporter === 'memory') processors.push(new SimpleSpanProcessor(memorySpans));
  if (exporter === 'console') processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  if (exporter === 'otlp') processors.push(new BatchSpanProcessor(new OTLPTraceExporter(options.otlpEndpoint !== undefined ? { url: `${options.otlpEndpoint}/v1/traces` } : {})));
  const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: processors });

  const memoryMetrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const readers: IMetricReader[] = [];
  let memoryReader: PeriodicExportingMetricReader | undefined;
  const interval = options.metricIntervalMs ?? 10_000;
  if (exporter === 'memory') {
    memoryReader = new PeriodicExportingMetricReader({ exporter: memoryMetrics, exportIntervalMillis: 3_600_000 });
    readers.push(memoryReader);
  }
  if (exporter === 'console') readers.push(new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter(), exportIntervalMillis: interval }));
  if (exporter === 'otlp') readers.push(new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(options.otlpEndpoint !== undefined ? { url: `${options.otlpEndpoint}/v1/metrics` } : {}), exportIntervalMillis: interval }));
  if (exporter === 'prometheus') readers.push(new PrometheusExporter({ port: options.prometheusPort ?? 9464 }));
  const meterProvider = new MeterProvider({ resource, readers });

  const tracer = tracerProvider.getTracer('openvideo');
  const meter = meterProvider.getMeter('openvideo');
  const renderDuration = meter.createHistogram('render_duration', { unit: 's', description: 'Duration of a render job.' });
  const frameDuration = meter.createHistogram('frame_duration', { unit: 'ms', description: 'Duration of one rendered frame.' });
  const queueWait = meter.createHistogram('queue_wait', { unit: 's', description: 'Time a chunk waited in the queue.' });
  const cacheHits = meter.createCounter('cache_hits', { description: 'Cache hits by tier.' });
  const cacheMisses = meter.createCounter('cache_misses', { description: 'Cache misses by tier.' });
  const workerFailures = meter.createCounter('worker_failures', { description: 'Failed chunks or crashed workers.' });
  const encodingDuration = meter.createHistogram('encoding_duration', { unit: 's', description: 'Duration of video encoding.' });
  let gpuBytes: number | undefined;
  meter.createObservableGauge('gpu_memory', { unit: 'By', description: 'GPU memory in use (only reported when measurable).' }).addCallback((r) => {
    if (gpuBytes !== undefined) r.observe(gpuBytes);
  });
  let lastCpu = process.cpuUsage();
  let lastTime = process.hrtime.bigint();
  meter.createObservableGauge('cpu_usage', { unit: '1', description: 'Process CPU usage as fraction of one core since the last observation.' }).addCallback((r) => {
    const cpu = process.cpuUsage(lastCpu);
    const now = process.hrtime.bigint();
    const elapsedMicros = Number(now - lastTime) / 1000;
    lastCpu = process.cpuUsage();
    lastTime = now;
    if (elapsedMicros > 0) r.observe((cpu.user + cpu.system) / elapsedMicros);
  });

  const metrics: OpenVideoMetrics = {
    recordRenderDuration: (s, a) => {
      renderDuration.record(s, a);
    },
    recordFrameDuration: (ms, a) => {
      frameDuration.record(ms, a);
    },
    recordQueueWait: (s, a) => {
      queueWait.record(s, a);
    },
    cacheHit: (tier, count = 1) => {
      cacheHits.add(count, { tier });
    },
    cacheMiss: (tier, count = 1) => {
      cacheMisses.add(count, { tier });
    },
    workerFailure: (reason) => {
      workerFailures.add(1, { reason });
    },
    recordEncodingDuration: (s, a) => {
      encodingDuration.record(s, a);
    },
    setGpuMemory: (bytes) => {
      gpuBytes = bytes;
    },
  };

  const minLevel = LEVELS[options.logLevel ?? 'info'];
  const sink = options.logSink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const logger: Logger = {
    log(level, message, fields = {}) {
      if (LEVELS[level] < minLevel) return;
      const span = trace.getActiveSpan()?.spanContext();
      sink(
        JSON.stringify({
          time: new Date().toISOString(),
          level,
          service: options.serviceName,
          message,
          ...(span !== undefined ? { trace_id: span.traceId, span_id: span.spanId } : {}),
          ...fields,
        }),
      );
    },
    debug: (m, f) => {
      logger.log('debug', m, f);
    },
    info: (m, f) => {
      logger.log('info', m, f);
    },
    warn: (m, f) => {
      logger.log('warn', m, f);
    },
    error: (m, f) => {
      logger.log('error', m, f);
    },
  };

  return {
    tracer,
    meter,
    metrics,
    logger,
    withSpan(name, attributes, fn) {
      return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof OpenVideoError ? error.diagnostic.code : error instanceof Error ? error.message : String(error) });
          throw error;
        } finally {
          span.end();
        }
      });
    },
    traceparent() {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      return carrier['traceparent'];
    },
    withRemoteParent(traceparent, fn) {
      if (traceparent === undefined) return fn();
      const ctx = propagation.extract(context.active(), { traceparent });
      return context.with(ctx, fn);
    },
    finishedSpans() {
      return memorySpans.getFinishedSpans();
    },
    async collectMetrics() {
      if (memoryReader === undefined) return [];
      await memoryReader.forceFlush();
      return memoryMetrics.getMetrics();
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}
