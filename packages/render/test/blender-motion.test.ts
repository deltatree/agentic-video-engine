/**
 * Story 17.5: Der Frame-Render übergibt Blender-Nodes mit `motionBlur: true` Subframe-Zustände
 * (`motionStates`). Das Backend ist ein Test-Backend mit demselben Vertrag wie das echte
 * (Fähigkeit `motion-states`), damit der Test ohne Blender läuft.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, getVec3, type LayerRequest, type RenderBackend } from '@agentic-video/core';
import { createNodeEnvironment, renderFrame, type BackendProvider, type NodeEnvironment } from '@agentic-video/render';
import { MOTION_STATES_CAPABILITY, type BlenderLayerRequest } from '@agentic-video/renderer-blender';

const requests: BlenderLayerRequest[] = [];

const blender: RenderBackend = {
  id: 'blender',
  nodeTypes: ['blender'],
  capabilities: ['blender.motion-blur', MOTION_STATES_CAPABILITY],
  fusable: false,
  versions: () => ({ 'test-blender': '1' }),
  check: () => ({ supported: true, diagnostics: [] }),
  renderLayer: (req: LayerRequest) => {
    requests.push(req);
    return Promise.resolve({ width: req.width, height: req.height, data: new Uint8Array(req.width * req.height * 4) });
  },
  dispose: () => Promise.resolve(),
};

const provider: BackendProvider = {
  ids: ['blender'],
  register(registry) {
    registry.registerBackend(blender);
    return Promise.resolve({});
  },
  dispose: () => Promise.resolve(),
};

const MOVING = { $keyframes: [{ t: 0, v: [-3, 0, 0] }, { t: 10, v: [3, 0, 0] }] };

function project(motionBlur: boolean, position: unknown = MOVING): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    compositions: [
      {
        id: 'main',
        width: 64,
        height: 36,
        fps: 30,
        duration: '1s',
        nodes: [
          {
            id: 'b',
            type: 'blender',
            width: 64,
            height: 36,
            motionBlur,
            children: [{ id: 'cube', type: 'mesh3d', position }],
          },
        ],
      },
    ],
  };
}

let env: NodeEnvironment;

beforeAll(async () => {
  env = await createNodeEnvironment({ projectDir: mkdtempSync(join(tmpdir(), 'ov-blender-mb-')), project: project(true), cache: createCache(new MemoryStore()), skipDefaultProviders: true, providers: [provider] });
});

afterAll(async () => {
  await env.dispose();
});

describe('Blender Motion Blur (Story 17.5)', () => {
  it('übergibt motionStates an ±0,25 Frames für motionBlur: true', async () => {
    requests.length = 0;
    await renderFrame(env, project(true), { frame: 5, useCache: false });
    const req = requests[0];
    expect(req?.motionStates?.map((m) => m.offset)).toEqual([-0.25, 0.25]);
    const xs = (req?.motionStates ?? []).map((m) => {
      const cube = m.nodes[0]?.children[0];
      return cube === undefined ? Number.NaN : getVec3(cube, 'position', [0, 0, 0])[0];
    });
    expect(xs[0]).toBeCloseTo(-0.15, 6);
    expect(xs[1]).toBeCloseTo(0.15, 6);
  });

  it('übergibt keine motionStates ohne motionBlur', async () => {
    requests.length = 0;
    await renderFrame(env, project(false), { frame: 5, useCache: false });
    expect(requests[0]?.motionStates).toBeUndefined();
  });

  it('nimmt die Subframe-Zustände in den Layer-Schlüssel auf', async () => {
    requests.length = 0;
    // Am Frame 5 steht der Würfel in beiden Projekten bei x = 0; nur die Nachbar-Subframes unterscheiden sich.
    await renderFrame(env, project(true), { frame: 5, useCache: false });
    requests.length = 0;
    await renderFrame(env, project(true, [0, 0, 0]), { frame: 5, useCache: false });
    expect(requests).toHaveLength(1);
  });
});
