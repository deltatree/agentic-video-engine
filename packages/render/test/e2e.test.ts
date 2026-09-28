import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { checkProject, createNodeEnvironment, renderFrame, renderVideo, validateManifest, type NodeEnvironment } from '@agentic-video/render';

const ffmpeg = process.env['OPENVIDEO_FFMPEG'] ?? join(process.env['HOME'] ?? '', '.local/bin/ffmpeg');
const ffprobe = process.env['OPENVIDEO_FFPROBE'] ?? join(process.env['HOME'] ?? '', '.local/bin/ffprobe');
let dir: string;
let env: NodeEnvironment;

const project = {
  schemaVersion: SCHEMA_VERSION,
  metadata: { title: 'E2E' },
  settings: { theme: { colors: { primary: '#FF5A1F' } } },
  assets: [
    { id: 'tone', type: 'audio', src: 'assets/tone.wav' },
    { id: 'subs', type: 'subtitle', src: 'assets/subs.srt' },
  ],
  audio: [{ id: 'music', asset: 'tone' }],
  compositions: [
    {
      id: 'main',
      width: 640,
      height: 360,
      fps: 30,
      duration: '2s',
      background: '#0B0D12',
      tracks: [
        { id: 'music-track', kind: 'audio', clips: [{ id: 'c1', source: 'music', start: 0, volume: 0.5, fadeIn: '0.2s' }] },
        { id: 'captions', kind: 'subtitle', asset: 'subs' },
      ],
      nodes: [
        { id: 'bg', type: 'rect', width: 640, height: 360, fill: { type: 'linear', stops: [{ offset: 0, color: '#1B2A4A' }, { offset: 1, color: '#0B0D12' }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
        { id: 'dot', type: 'ellipse', width: 60, height: 60, y: 60, fill: { $ref: 'theme.colors.primary' }, x: { $keyframes: [{ t: 0, v: 40 }, { t: '2s', v: 540, ease: 'easeInOutCubic' }] } },
        { id: 'title', type: 'text', text: 'OpenVideo', fontSize: 56, fontWeight: 700, x: 40, y: 150, opacity: { $keyframes: [{ t: 0, v: 0 }, { t: '0.5s', v: 1 }] } },
        { id: 'lt', type: 'component', component: 'LowerThird', props: { name: 'Ada', role: 'Coding Agent' }, y: 250, x: 40 },
        { id: 'caps', type: 'subtitles', track: 'captions', fontSize: 22 },
      ],
    },
  ],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ov-e2e-'));
  mkdirSync(join(dir, 'assets'));
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', join(dir, 'assets', 'tone.wav')]);
  writeFileSync(join(dir, 'assets', 'subs.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHello from OpenVideo\n\n2\n00:00:01,000 --> 00:00:02,000\nRendered by an agent\n');
  env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new FileStore(join(dir, '.openvideo', 'cache'))) });
});

afterAll(async () => {
  await env.dispose();
});

describe('End-to-End: JSON → Frames → MP4 (Story 2.7)', () => {
  it('prüft das Projekt ohne Fehler', () => {
    const diagnostics = checkProject(env, project).filter((d) => d.severity === 'error');
    expect(diagnostics).toEqual([]);
    expect(env.assetDiagnostics).toEqual([]);
  });

  it('meldet falsche Komponenten-Props mit Pfad (statt sie still zu ignorieren)', () => {
    const wrong = structuredClone(project);
    const lt = wrong.compositions[0]?.nodes.find((n) => n.id === 'lt');
    if (lt !== undefined) lt.props = { title: 'Ada' } as never;
    const d = checkProject(env, wrong).find((x) => x.code === 'OV_COMPONENT_PROPS');
    expect(d?.path).toBe('composition.main.nodes.lt.props.name');
  });

  it('rendert einen Frame (visuell geprüft) deterministisch', async () => {
    const a = await renderFrame(env, project, { frame: 30, useCache: false });
    writeFileSync(join(process.env['OV_E2E_OUT'] ?? dir, 'e2e-frame-30.png'), encodePng(a.image));
    const b = await renderFrame(env, project, { frame: 30, useCache: false });
    expect(Buffer.from(b.image.data).equals(Buffer.from(a.image.data))).toBe(true);
    expect(a.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('erzeugt MP4 mit Ton und gültigem Manifest; zweiter Lauf ist bitgleich (FR-9)', async () => {
    const r = await renderVideo(env, project, { outPath: join(dir, 'out', 'e2e.mp4'), profile: { format: 'mp4', codec: 'h264' } });
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(dir, 'out', 'e2e.mp4')]).toString()) as { streams: { codec_type: string; codec_name: string; width?: number; nb_frames?: string }[]; format: { duration: string } };
    const video = probe.streams.find((s) => s.codec_type === 'video');
    const audio = probe.streams.find((s) => s.codec_type === 'audio');
    expect(video).toMatchObject({ codec_name: 'h264', width: 640, nb_frames: '60' });
    expect(audio?.codec_name).toBe('aac');
    expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
    expect(validateManifest(JSON.parse(readFileSync(r.manifestPath, 'utf8')))).toEqual([]);
    expect(r.manifest.skiaVersion).toBe('0.42.0');
    expect(r.manifest.frameHashes).toHaveLength(60);
    const again = await renderVideo(env, project, { outPath: join(dir, 'out', 'e2e-2.mp4'), profile: { format: 'mp4', codec: 'h264' } });
    expect(again.manifest.frameHashes).toEqual(r.manifest.frameHashes);
    expect(again.manifest.cache.framesFromCache).toBe(60);
    expect(again.manifest.outputs[0]?.hash).toBe(r.manifest.outputs[0]?.hash);
  });
});
