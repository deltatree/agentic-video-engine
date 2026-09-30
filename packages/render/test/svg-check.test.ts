/**
 * Story 17.6: checkProject prüft auch SVG-Assets (nicht unterstützte Elemente, blockierte Bilder).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, SCHEMA_VERSION, type AssetRecord, type AssetResolver } from '@agentic-video/core';
import { checkProject } from '@agentic-video/render';

describe('checkProject mit SVG-Assets (Story 17.6)', () => {
  it('meldet filter und Bilder außerhalb des Projects als Warnung', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-svg-check-'));
    const path = join(dir, 'icon.svg');
    writeFileSync(path, '<svg viewBox="0 0 10 10"><filter id="f"/><image href="../../secret.png"/><image href="logo.png"/><rect width="10" height="10"/></svg>');
    const records: AssetRecord[] = [
      { id: 'icon', type: 'svg', src: 'assets/icon.svg', path, hash: 'sha256:1', metadata: {} },
      { id: 'logo', type: 'image', src: 'assets/logo.png', path: join(dir, 'logo.png'), hash: 'sha256:2', metadata: {} },
    ];
    const assets: AssetResolver = {
      get: (id) => records.find((r) => r.id === id),
      bytes: () => Promise.reject(new Error('not used')),
      videoFrame: () => Promise.reject(new Error('not used')),
      all: () => records,
    };
    const project = {
      schemaVersion: SCHEMA_VERSION,
      assets: records.map((r) => ({ id: r.id, type: r.type, src: r.src })),
      compositions: [{ id: 'main', width: 10, height: 10, fps: 30, duration: 1, nodes: [{ id: 'logoSvg', type: 'svg', asset: 'icon', width: 10, height: 10 }] }],
    };
    const diagnostics = checkProject({ registry: new Registry(), assets }, project).filter((d) => d.code.startsWith('OV_SVG'));
    expect(diagnostics.map((d) => [d.code, d.severity, d.nodeId])).toEqual([
      ['OV_SVG_UNSUPPORTED', 'warning', 'logoSvg'],
      ['OV_SVG_IMAGE_BLOCKED', 'warning', 'logoSvg'],
    ]);
    expect(diagnostics[1]?.problem).toContain('outside the project');
  });
});
