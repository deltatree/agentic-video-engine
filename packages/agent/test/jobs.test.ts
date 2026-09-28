import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry } from '@agentic-video/telemetry';
import { JobManager } from '@agentic-video/agent';

function telemetry(logs: string[] = []): ReturnType<typeof createTelemetry> {
  return createTelemetry({ serviceName: 'jobs-test', exporter: 'memory', logSink: (l) => logs.push(l) });
}

describe('B7: JobManager', () => {
  it('ein in der Warteschlange abgebrochener Job läuft nie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-jobs-'));
    const jobs = new JobManager(dir, telemetry(), 1);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = jobs.start('a', 'p', () => gate);
    let ran = false;
    const second = jobs.start('b', 'p', () => {
      ran = true;
      return Promise.resolve('done');
    });
    expect(jobs.cancel(second).state).toBe('cancelled');
    release();
    await jobs.wait(first);
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(false);
    expect(jobs.status(second).state).toBe('cancelled');
  });

  it('restore überspringt kaputte Journal-Dateien', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-jobs-'));
    const jobs = new JobManager(dir, telemetry(), 1);
    const id = jobs.start('a', 'p', () => Promise.resolve(1));
    await jobs.wait(id);
    await jobs.flush();
    writeFileSync(join(dir, 'job-broken.json'), '{ not json');
    const logs: string[] = [];
    const restored = new JobManager(dir, telemetry(logs), 1);
    await restored.restore();
    expect(restored.status(id).state).toBe('succeeded');
    expect(logs.join('\n')).toContain('job-broken.json');
  });

  it('schreibt das Journal geordnet: der Endzustand gewinnt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-jobs-'));
    const jobs = new JobManager(dir, telemetry(), 1);
    const id = jobs.start('a', 'p', () => Promise.resolve(1));
    await jobs.wait(id);
    await jobs.flush();
    const journal = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as { state: string };
    expect(journal.state).toBe('succeeded');
  });

  it('fängt Schreibfehler des Journals ab und protokolliert sie', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'ov-jobs-'));
    const blocked = join(parent, 'journal');
    writeFileSync(blocked, 'not a directory');
    const logs: string[] = [];
    const jobs = new JobManager(blocked, telemetry(logs), 1);
    const id = jobs.start('a', 'p', () => Promise.resolve(1));
    const info = await jobs.wait(id);
    await jobs.flush();
    expect(info.state).toBe('succeeded');
    expect(logs.join('\n')).toContain('journal');
  });

  it('hält nur eine begrenzte Zahl beendeter Jobs im Speicher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-jobs-'));
    mkdirSync(dir, { recursive: true });
    const jobs = new JobManager(dir, telemetry(), 4, 3);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = jobs.start('a', 'p', () => Promise.resolve(i));
      ids.push(id);
      await jobs.wait(id);
    }
    expect(jobs.list().length).toBe(3);
    expect(jobs.list().map((j) => j.id)).toEqual(ids.slice(3));
  });
});
