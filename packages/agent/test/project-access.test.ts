/**
 * Review M3: Eingebundene Projekte (Symlinks von project.open) werden bei jedem Zugriff erneut
 * gegen die aktuellen Wurzeln geprüft, nicht nur beim Öffnen.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, assertProjectAccess, invokeOperation, readProjectFile, type AgentServices } from '@agentic-video/agent';
import { smallProject, testServices } from './helpers.js';

async function code(services: AgentServices, op: string, input: unknown): Promise<string | undefined> {
  const r = await invokeOperation(OPERATIONS, op, input, { services, via: 'test' });
  return r.ok ? undefined : r.error.code;
}

describe('Review M3: Wurzelprüfung bei jedem Zugriff', () => {
  it('sperrt ein früher geöffnetes Projekt nach einem Neustart ohne passende Wurzel', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ov-access-ws-'));
    const root = mkdtempSync(join(tmpdir(), 'ov-access-root-'));
    mkdirSync(join(root, 'launch'));
    writeFileSync(join(root, 'launch', 'project.json'), JSON.stringify(smallProject()));
    const first: AgentServices = { ...testServices(workspace), projectRoots: [root] };
    expect(await code(first, 'project.open', { path: 'launch' })).toBeUndefined();
    expect(await code(first, 'composition.get', { projectId: 'launch' })).toBeUndefined();

    // „Neustart“: derselbe Workspace, aber ohne Wurzeln.
    const restarted = testServices(workspace);
    expect(await code(restarted, 'composition.get', { projectId: 'launch' })).toBe('OV_PATH_OUTSIDE');
    expect(await code(restarted, 'composition.patch', { projectId: 'launch', patches: [{ op: 'addNode', parentId: null, node: { id: 'x', type: 'rect', width: 1, height: 1 } }] })).toBe('OV_PATH_OUTSIDE');
    await expect(readProjectFile({ services: restarted, via: 'test' }, 'launch', 'project.json')).rejects.toMatchObject({ diagnostic: { code: 'OV_PATH_OUTSIDE' } });

    // Andere Wurzel: weiterhin gesperrt. Vom Host eingebunden (openvideo dev): erlaubt.
    const other: AgentServices = { ...testServices(workspace), projectRoots: [mkdtempSync(join(tmpdir(), 'ov-access-other-'))] };
    expect(await code(other, 'composition.get', { projectId: 'launch' })).toBe('OV_PATH_OUTSIDE');
    const host: AgentServices = { ...testServices(workspace), hostProjectDirs: [join(root, 'launch')] };
    expect(await code(host, 'composition.get', { projectId: 'launch' })).toBeUndefined();
  });

  it('lässt echte Projektordner im Workspace immer zu', async () => {
    const services = testServices(mkdtempSync(join(tmpdir(), 'ov-access-plain-')));
    const created = await invokeOperation(OPERATIONS, 'project.create', { name: 'Plain', project: smallProject() }, { services, via: 'test' });
    expect(created.ok).toBe(true);
    await expect(assertProjectAccess(services, 'plain')).resolves.toBeUndefined();
    await expect(assertProjectAccess(services, 'missing')).resolves.toBeUndefined();
  });
});
