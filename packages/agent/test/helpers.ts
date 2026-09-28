/**
 * Gemeinsame Test-Hilfen der Agent-Tests: ein kleines Rechteck-Backend und Dienste ohne echte Renderer.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry, getNumber, parseColor, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createTelemetry } from '@agentic-video/telemetry';
import type { RenderEnvironment } from '@agentic-video/render';
import { JobManager, Workspace, type AgentServices, type SourceService } from '@agentic-video/agent';

/** Backend, das Rechtecke flächig füllt (für Pixelprüfungen). */
export function rectBackend(): RenderBackend {
  return {
    id: 'skia',
    nodeTypes: ['rect', 'text'],
    capabilities: [],
    fusable: true,
    versions: () => ({ test: '1' }),
    check: () => ({ supported: true, diagnostics: [] }),
    renderLayer: (req) => {
      const data = new Uint8Array(req.width * req.height * 4);
      for (const n of req.nodes) {
        if (n.type !== 'rect') continue;
        const c = parseColor(typeof n.props['fill'] === 'string' ? n.props['fill'] : '#FFFFFF');
        for (let y = Math.round(getNumber(n, 'y', 0) * req.scale); y < Math.min(req.height, Math.round((getNumber(n, 'y', 0) + getNumber(n, 'height', 0)) * req.scale)); y++)
          for (let x = Math.round(getNumber(n, 'x', 0) * req.scale); x < Math.min(req.width, Math.round((getNumber(n, 'x', 0) + getNumber(n, 'width', 0)) * req.scale)); x++) {
            const o = (y * req.width + x) * 4;
            data[o] = Math.round(c.r * 255);
            data[o + 1] = Math.round(c.g * 255);
            data[o + 2] = Math.round(c.b * 255);
            data[o + 3] = 255;
          }
      }
      return Promise.resolve({ width: req.width, height: req.height, data });
    },
    dispose: () => Promise.resolve(),
  };
}

/** Render-Umgebung für Tests (Registry optional vorgegeben). */
export function testEnvironment(registry: Registry = new Registry()): RenderEnvironment {
  const telemetry = createTelemetry({ serviceName: 'agent-test', exporter: 'memory', logSink: () => undefined });
  if (!registry.backends.has('skia')) registry.registerBackend(rectBackend());
  return {
    registry,
    assets: { get: () => undefined, bytes: () => Promise.reject(new Error('none')), videoFrame: () => Promise.reject(new Error('none')), all: () => [] },
    fonts: { all: () => [], has: (f) => f === 'Inter', fallbacks: () => [] },
    cache: createCache(new MemoryStore()),
    telemetry,
    composite: (req) => {
      const img = req.layers.find((l): l is { kind: 'image'; image: RgbaImage } => l.kind === 'image');
      return img?.image ?? { width: req.width, height: req.height, data: new Uint8Array(req.width * req.height * 4) };
    },
    accumulate: (images) => images[0] ?? { width: 1, height: 1, data: new Uint8Array(4) },
    overlays: {
      debugOverlay: (_s, _b, _o, size) => ({ width: size.width, height: size.height, data: new Uint8Array(size.width * size.height * 4) }),
      contactSheet: (frames) => frames[0]?.image ?? { width: 1, height: 1, data: new Uint8Array(4) },
    },
    media: {
      createEncoder: (o) => {
        let frames = 0;
        return Promise.resolve({
          write: () => {
            frames++;
            return Promise.resolve();
          },
          finish: async () => {
            await writeFile(o.outPath, new Uint8Array([0]));
            return { outputs: [o.outPath], frames, encoder: 'test', args: [] };
          },
          abort: () => Promise.resolve(),
        });
      },
      info: () => Promise.resolve({ version: 'test', license: 'LGPL-2.1-or-later', configuration: '', codecLicenses: {} }),
    },
    versions: { 'backend:skia': '1' },
    trusted: false,
    platform: { os: 'linux' },
  };
}

/** Optionen für {@link testServices}. */
export interface TestServiceOptions {
  readonly isolation?: 'container' | 'trusted';
  readonly sources?: SourceService;
  readonly registry?: Registry;
}

/** Agent-Dienste für Tests mit einem Workspace unter `root`. */
export function testServices(root: string, options: TestServiceOptions = {}): AgentServices {
  const env = testEnvironment(options.registry);
  return {
    workspace: new Workspace(root),
    jobs: new JobManager(join(root, 'jobs'), env.telemetry, 2),
    telemetry: env.telemetry,
    isolation: options.isolation ?? 'container',
    withEnvironment: (_dir, _project, fn) => fn(env),
    encodePng: (image) => encodePng(image),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
  };
}

/** Kleines, gültiges JSON-Projekt. */
export function smallProject(nodes: readonly Record<string, unknown>[] = [], extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 64, height: 36, fps: 10, duration: 20, nodes: [...nodes], ...extra }] };
}
