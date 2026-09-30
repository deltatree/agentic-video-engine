/**
 * Story 21.3: GPU-Quota und Browser-GPU im Docker-Runner (Argumente; kein Docker-Daemon nötig).
 */
import { describe, expect, it } from 'vitest';
import { dockerGpusArg, dockerRunArgs } from '@agentic-video/scheduler';

describe('Docker-Runner: GPU-Quota (Story 21.3)', () => {
  it('setzt --gpus, die Treiber-Fähigkeiten und optional OPENVIDEO_BROWSER_GPU', () => {
    const args = dockerRunArgs('ghcr.io/deltatree/openvideo-render-gpu:0.1.0', 'ov-gpu-1', { gpus: 'device=0' }, { browserGpu: true, command: ['worker', '--stdio'] });
    const text = args.join(' ');
    expect(text).toContain('--gpus device=0 -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics');
    expect(text).toContain('-e OPENVIDEO_BROWSER_GPU=1');
    expect(args.slice(-3)).toEqual(['ghcr.io/deltatree/openvideo-render-gpu:0.1.0', 'worker', '--stdio']);
    // Die Härtung bleibt: kein Netz, read-only, keine Capabilities.
    expect(text).toContain('--network none --read-only');
    expect(text).toContain('--cap-drop ALL');
  });

  it('ohne GPU-Quota gibt es kein --gpus und keine Browser-GPU', () => {
    const args = dockerRunArgs('img:1', 'n');
    expect(args).not.toContain('--gpus');
    expect(args.join(' ')).not.toContain('OPENVIDEO_BROWSER_GPU');
    expect(args.slice(-2)).toEqual(['img:1', '--stdio']);
  });

  it('normalisiert Angaben und lehnt ungültige ab', () => {
    expect(dockerGpusArg('all')).toBe('all');
    expect(dockerGpusArg('2')).toBe('2');
    expect(dockerGpusArg('device=0')).toBe('device=0');
    expect(dockerGpusArg('device=1')).toBe('device=1');
    expect(dockerGpusArg('0,1')).toBe('"device=0,1"');
    expect(dockerGpusArg('device=0,1')).toBe('"device=0,1"');
    expect(dockerGpusArg('device=GPU-12345678-aaaa')).toBe('device=GPU-12345678-aaaa');
    // Eine einzelne Zahl ist eine Anzahl (Docker); 0 GPUs und GPU-IDs ohne device= sind mehrdeutig.
    for (const bad of ['', 'x', '0', 'GPU-12345678-aaaa', 'device=', '0;rm -rf /', '--privileged']) expect(() => dockerGpusArg(bad), bad).toThrow(/valid GPU quota/u);
  });
});
