/**
 * Gemeinsame Testdaten: ein 2D-Projekt mit 90 Frames (ohne Text, damit Schriften
 * auf Host und im Container nicht abweichen).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { createNodeEnvironment, type NodeEnvironment } from '@agentic-video/render';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';

export const project = {
  schemaVersion: SCHEMA_VERSION,
  metadata: { title: 'Scheduler' },
  compositions: [
    {
      id: 'main',
      width: 320,
      height: 180,
      fps: 30,
      duration: '3s',
      background: '#0B0D12',
      nodes: [
        { id: 'bg', type: 'rect', width: 320, height: 180, fill: { type: 'linear', stops: [{ offset: 0, color: '#1B2A4A' }, { offset: 1, color: '#0B0D12' }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
        { id: 'dot', type: 'ellipse', width: 40, height: 40, y: 70, fill: '#FF5A1F', x: { $keyframes: [{ t: 0, v: 10 }, { t: '3s', v: 270, ease: 'easeInOutCubic' }] } },
        { id: 'bar', type: 'rect', width: { $keyframes: [{ t: 0, v: 0 }, { t: '3s', v: 320 }] }, height: 8, y: 160, fill: '#3DDC97' },
      ],
    },
  ],
};

/** Neuer Projektordner mit eigenem Datei-Cache. */
export function tempProjectDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Render-Umgebung mit Datei-Cache in `<dir>/.openvideo/cache`. */
export function makeEnv(dir: string, telemetry?: Telemetry): Promise<NodeEnvironment> {
  return createNodeEnvironment({
    projectDir: dir,
    project,
    cache: createCache(new FileStore(join(dir, '.openvideo', 'cache'))),
    telemetry: telemetry ?? createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined }),
  });
}
