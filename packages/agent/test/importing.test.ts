/**
 * Review m4: project.import – idPrefix bei anime und motion-canvas, deklarierte Img-Assets,
 * kein Folgen von Symlinks beim Schreiben, glTF, HTML, OV_IMPORT_FILE_EXISTS und Pfad-Ausbruch.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRecord } from '@agentic-video/core';
import { OPERATIONS, invokeOperation, type AgentServices } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

const RECT = { id: 'box', type: 'rect', x: 0, y: 0, width: 10, height: 10, fill: '#FF0000' };

function newServices(): AgentServices {
  return testServices(mkdtempSync(join(tmpdir(), 'ov-import-')));
}

async function run(services: AgentServices, op: string, input: unknown): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; code: string }> {
  const r = await invokeOperation(OPERATIONS, op, input, { services, via: 'test' });
  if (!r.ok) return { ok: false, code: r.error.code };
  if (!isRecord(r.result)) throw new Error('no object');
  return { ok: true, result: r.result };
}

async function ok(services: AgentServices, op: string, input: unknown): Promise<Record<string, unknown>> {
  const r = await run(services, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${r.code}`);
  return r.result;
}

async function code(services: AgentServices, op: string, input: unknown): Promise<string | undefined> {
  const r = await run(services, op, input);
  return r.ok ? undefined : r.code;
}

async function create(services: AgentServices, nodes: readonly Record<string, unknown>[] = [RECT]): Promise<string> {
  return String((await ok(services, 'project.create', { name: 'Import', project: smallProject(nodes) }))['projectId']);
}

function ids(value: unknown): string[] {
  const out: string[] = [];
  const visit = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const n of list.filter(isRecord)) {
      out.push(String(n['id']));
      visit(n['children']);
    }
  };
  visit(value);
  return out;
}

/** Kleinstes GLB (nur JSON-Chunk). */
function glb(json: unknown): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + padded).fill(0x20);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  return out;
}

const MODEL = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Box', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ count: 3, componentType: 5126, type: 'VEC3' }] };

describe('Review m4: idPrefix', () => {
  it('anime: Ziele bekommen das Präfix (passend zu einem früheren Import)', async () => {
    const services = newServices();
    const id = await create(services, [RECT, { id: 'logo-box', type: 'rect', width: 5, height: 5 }]);
    const r = await ok(services, 'project.import', { projectId: id, format: 'anime', idPrefix: 'logo', content: { entries: [{ targets: 'box', params: { opacity: [0, 1], duration: 500 } }] } });
    expect(r['ok']).toBe(true);
    const comp = await ok(services, 'composition.get', { projectId: id });
    const nodes = Array.isArray(comp['nodes']) ? comp['nodes'].filter(isRecord) : [];
    expect(JSON.stringify(nodes.find((n) => n['id'] === 'logo-box')?.['opacity'])).toContain('$keyframes');
    expect(nodes.find((n) => n['id'] === 'box')?.['opacity']).toBeUndefined();
  });

  it('motion-canvas: Node- und Asset-IDs bekommen das Präfix; Img-Assets stehen in "assets"', async () => {
    const services = newServices();
    const id = await create(services);
    writeFileSync(join(services.workspace.projectDir(id), 'assets', 'pic.png'), new Uint8Array([137, 80, 78, 71]));
    const content = { scenes: [{ name: 'intro', nodes: [{ type: 'Rect', key: 'card', props: { width: 20, height: 10 } }, { type: 'Img', key: 'pic', props: { src: 'assets/pic.png', width: 4, height: 4 } }], timeline: [] }] };
    const r = await ok(services, 'project.import', { projectId: id, format: 'motion-canvas', idPrefix: 'mc', content });
    expect(r['ok']).toBe(true);
    expect(r['nodes']).toEqual(['mc-intro']);
    const assets = Array.isArray(r['assets']) ? r['assets'].map(String) : [];
    expect(assets.length).toBe(1);
    expect(assets[0]?.startsWith('mc-')).toBe(true);
    const comp = await ok(services, 'composition.get', { projectId: id });
    const all = ids(comp['nodes']);
    expect(all.filter((n) => n !== 'box').every((n) => n.startsWith('mc-'))).toBe(true);
    expect(JSON.stringify(comp['nodes'])).toContain(`"asset":"${assets[0] ?? ''}"`);
  });
});

describe('Review m4: glTF und HTML', () => {
  it('importiert ein GLB aus base64 und schreibt das Modell', async () => {
    const services = newServices();
    const id = await create(services);
    const r = await ok(services, 'project.import', { projectId: id, format: 'gltf', base64: Buffer.from(glb(MODEL)).toString('base64'), idPrefix: 'robot' });
    expect(r['ok']).toBe(true);
    expect(r['assets']).toEqual(['robot']);
    expect(existsSync(join(services.workspace.projectDir(id), 'assets', 'robot.glb'))).toBe(true);
  });

  it('importiert HTML als html-Node mit Präfix-ID', async () => {
    const services = newServices();
    const id = await create(services);
    const r = await ok(services, 'project.import', { projectId: id, format: 'html', content: '<div style="color: red">Hello</div>', idPrefix: 'card' });
    expect(r['ok']).toBe(true);
    expect(r['nodes']).toEqual(['card']);
    const comp = await ok(services, 'composition.get', { projectId: id });
    expect(ids(comp['nodes'])).toContain('card');
  });
});

describe('Review m4: Dateien schreiben', () => {
  it('überschreibt keine andere Datei gleichen Namens (OV_IMPORT_FILE_EXISTS)', async () => {
    const services = newServices();
    const id = await create(services);
    const file = join(services.workspace.projectDir(id), 'assets', 'robot.glb');
    writeFileSync(file, 'other content');
    expect(await code(services, 'project.import', { projectId: id, format: 'gltf', base64: Buffer.from(glb(MODEL)).toString('base64'), idPrefix: 'robot' })).toBe('OV_IMPORT_FILE_EXISTS');
    expect(readFileSync(file, 'utf8')).toBe('other content');
  });

  it('folgt keinem vorhandenen Symlink', async () => {
    const services = newServices();
    const id = await create(services);
    const outside = join(mkdtempSync(join(tmpdir(), 'ov-import-outside-')), 'target.glb');
    const link = join(services.workspace.projectDir(id), 'assets', 'robot.glb');
    symlinkSync(outside, link);
    expect(await code(services, 'project.import', { projectId: id, format: 'gltf', base64: Buffer.from(glb(MODEL)).toString('base64'), idPrefix: 'robot' })).toBe('OV_IMPORT_FILE_EXISTS');
    expect(existsSync(outside)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('liest keine Quelle außerhalb des Projekts (Pfad-Ausbruch)', async () => {
    const services = newServices();
    const id = await create(services);
    const r = await code(services, 'project.import', { projectId: id, format: 'svg', path: '../../../../etc/hostname' });
    expect(r === 'OV_PATH_OUTSIDE' || r === 'OV_FILE_NOT_FOUND').toBe(true);
    expect(await code(services, 'project.import', { projectId: id, format: 'svg', path: '/etc/hostname' })).toMatch(/^OV_(PATH_OUTSIDE|FILE_NOT_FOUND)$/u);
  });
});
