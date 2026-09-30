/**
 * Story 17.8: fromAudio-Tracks werden vor dem Render transkribiert (Cache je Audio-Hash);
 * Provider-Wahl und Quellprüfung teilen sich Render und `subtitles.transcribe`.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry, type AssetRecord, type AsrProvider } from '@agentic-video/core';
import { chooseAsrProvider, resolveFromAudioTracks, transcriptionSource } from '@agentic-video/speech';

const dir = mkdtempSync(join(tmpdir(), 'ov-from-audio-'));
const wav = join(dir, 'vo.wav');
writeFileSync(wav, new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));

function fakeAsr(id: string, calls: string[]): AsrProvider {
  return {
    id,
    version: () => Promise.resolve('1'),
    available: () => Promise.resolve(true),
    transcribe: (path) => {
      calls.push(path);
      return Promise.resolve({ cues: [{ start: 0.5, end: 1.5, text: 'hello there', words: [{ text: 'hello', start: 0.5, end: 1 }, { text: 'there', start: 1, end: 1.5 }] }] });
    },
  };
}

const records: AssetRecord[] = [
  { id: 'vo', type: 'audio', src: 'vo.wav', path: wav, hash: 'sha256:vo', metadata: {} },
  { id: 'logo', type: 'image', src: 'logo.png', path: join(dir, 'logo.png'), hash: 'sha256:logo', metadata: {} },
];
const assets = { get: (id: string) => records.find((r) => r.id === id), all: () => records };

function project(tracks: unknown[]): Record<string, unknown> {
  return { compositions: [{ id: 'main', width: 10, height: 10, fps: 30, duration: '3s', tracks, nodes: [] }] };
}

describe('fromAudio vor dem Render (Story 17.8)', () => {
  it('transkribiert fromAudio-Tracks einmal je Audio-Hash und meldet Fehler je Track', async () => {
    const calls: string[] = [];
    const registry = new Registry();
    registry.registerAsrProvider(fakeAsr('whisper-cpp', calls));
    const cache = createCache(new MemoryStore());
    const p = project([
      { id: 'subs', kind: 'subtitle', fromAudio: { source: 'vo', provider: 'whisper-cpp' } },
      { id: 'again', kind: 'subtitle', fromAudio: { source: 'vo', provider: 'whisper-cpp' } },
      { id: 'image', kind: 'subtitle', fromAudio: { source: 'logo', provider: 'whisper-cpp' } },
      { id: 'inline', kind: 'subtitle', fromAudio: { source: 'vo', provider: 'whisper-cpp' }, cues: [] },
    ]);
    const result = await resolveFromAudioTracks(p, { registry, assets, cache });
    expect([...result.keys()]).toEqual(['main/subs', 'main/again', 'main/image']);
    const subs = result.get('main/subs');
    expect(subs !== undefined && 'cues' in subs ? subs.cues[0]?.words?.map((w) => w.text) : undefined).toEqual(['hello', 'there']);
    const image = result.get('main/image');
    expect(image !== undefined && 'error' in image ? image.error.code : undefined).toBe('OV_TRANSCRIBE_SOURCE');
    // Zweiter Track mit demselben Audio: Cache-Treffer.
    expect(calls).toHaveLength(1);
  });

  it('meldet fehlende ASR-Provider und fehlende Assets strukturiert', async () => {
    const empty = new Registry();
    expect(() => chooseAsrProvider(empty, undefined)).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_ASR_UNAVAILABLE' }) }));
    const two = new Registry();
    two.registerAsrProvider(fakeAsr('a', []));
    two.registerAsrProvider(fakeAsr('b', []));
    expect(() => chooseAsrProvider(two, undefined)).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_ASR_PROVIDER' }) }));
    expect(chooseAsrProvider(two, 'b')).toBe('b');
    expect(() => transcriptionSource(assets, 'nope')).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_ASSET_UNKNOWN' }) }));
    const result = await resolveFromAudioTracks(project([{ id: 'subs', kind: 'subtitle', fromAudio: { source: 'vo', provider: 'whisper-cpp' } }]), { registry: empty, assets, cache: createCache(new MemoryStore()) });
    const entry = result.get('main/subs');
    expect(entry !== undefined && 'error' in entry ? entry.error.code : undefined).toBe('OV_ASR_UNAVAILABLE');
  });
});
