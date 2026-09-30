/**
 * Story 21.7: strukturierte Fehler in der Audio-Engine statt roher `Error`.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { OpenVideoError, SCHEMA_VERSION, type AssetResolver } from '@agentic-video/core';
import { createAudioEngine } from '@agentic-video/render';

const assets: AssetResolver = {
  get: () => undefined,
  bytes: () => Promise.reject(new Error('not used')),
  videoFrame: () => Promise.reject(new Error('not used')),
  all: () => [],
};

describe('Audio-Engine (Story 21.7)', () => {
  it('meldet eine nicht auflösbare Audioquelle als OV_AUDIO_SOURCE_UNRESOLVED', async () => {
    const engine = createAudioEngine({ assets, cache: createCache(new MemoryStore()) });
    const composition = { id: 'main', width: 16, height: 16, fps: 30, duration: '1s', tracks: [{ id: 't', kind: 'audio', clips: [{ id: 'c', source: 'ghost', start: 0 }] }], nodes: [] };
    const project = { schemaVersion: SCHEMA_VERSION, compositions: [composition] };
    const outPath = join(mkdtempSync(join(tmpdir(), 'ov-audio-err-')), 'mix.wav');
    const error: unknown = await engine.renderComposition({ project, composition, startFrame: 0, endFrame: 30, outPath }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenVideoError);
    if (!(error instanceof OpenVideoError)) return;
    expect(error.diagnostic.code).toBe('OV_AUDIO_SOURCE_UNRESOLVED');
    expect(error.diagnostic.details).toEqual({ source: 'ghost' });
    expect(error.diagnostic.suggestions.length).toBeGreaterThan(1);
  });
});
