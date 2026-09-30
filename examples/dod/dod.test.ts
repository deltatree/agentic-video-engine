// Definition-of-Done-Test, kurze Variante (1920×1080, 6 s): startet examples/dod/run.mjs als eigenen
// Prozess, damit Server und Worker-Prozesse die gebauten Pakete (dist) nutzen wie ein echter Agent.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = join(here, 'out', 'short-test');
const built = existsSync(join(here, '..', '..', 'packages', 'cli', 'dist', 'index.js')) && existsSync(join(here, '..', '..', 'packages', 'agent', 'dist', 'index.js'));

/** PATH mit den lokalen Werkzeugen aus ~/.local/opt (FFmpeg, espeak-ng), falls vorhanden. */
function toolPath(): string {
  const opt = join(homedir(), '.local', 'opt');
  const extra = [join(opt, 'node22', 'bin'), join(opt, 'ffmpeg-7.0.2-amd64-static'), join(opt, 'espeak-ng'), join(homedir(), '.local', 'bin')].filter((p) => existsSync(p));
  return [...extra, process.env['PATH'] ?? ''].join(delimiter);
}

interface Report {
  ok: boolean;
  error?: string;
  components: { n: number; name: string; ok: boolean; where: string[] }[];
  steps: { name: string; frames?: { scene: string; changed: boolean; expectedChange: boolean }[]; checkpoints?: unknown[] }[];
  reproduction: { frameHashesEqual: boolean; framesA: number; framesB: number; sameIr: boolean; chunksB: { worker: string }[] };
}

/** Prüft die Grundform des Berichts; fehlt etwas, hat run.mjs vorzeitig aufgehört. */
function isReport(value: unknown): value is Report {
  if (typeof value !== 'object' || value === null) return false;
  return 'ok' in value && 'components' in value && Array.isArray(value.components) && 'steps' in value && Array.isArray(value.steps) && 'reproduction' in value && typeof value.reproduction === 'object';
}

describe('Definition of Done (Auftrag Abschnitt 50), kurze Variante', () => {
  // Ohne gebaute Pakete kann der Agent-Server nicht starten: benannter Grund statt stiller Auslassung.
  it.skipIf(!built)('erzeugt, prüft, ändert, rendert und reproduziert ein Video mit allen 21 Bestandteilen (braucht `npm run build`)', () => {
    const r = spawnSync(process.execPath, [join(here, 'run.mjs'), '--short', '--out', out], { encoding: 'utf8', env: { ...process.env, PATH: toolPath() }, timeout: 29 * 60_000 });
    const reportFile = join(out, 'dod-report.json');
    expect(existsSync(reportFile), `run.mjs schrieb keinen Bericht.\n${r.stdout}\n${r.stderr}`).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(reportFile, 'utf8'));
    if (!isReport(parsed)) throw new Error(`dod-report.json hat nicht die erwartete Form:\n${JSON.stringify(parsed).slice(0, 2000)}`);
    const report = parsed;
    expect(report.error, r.stdout).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(r.status).toBe(0);

    // Alle 21 Bestandteile sind benannt im Projekt nachweisbar.
    expect(report.components).toHaveLength(21);
    expect(report.components.filter((c) => !c.ok)).toEqual([]);

    // Ablauf in der geforderten Reihenfolge.
    expect(report.steps.map((s) => s.name)).toEqual([
      'project.create',
      'asset.import',
      'composition.patch',
      'composition.validate',
      'frame.render + frame.inspect',
      'composition.patch (targeted)',
      'frame.render (after patch)',
      'video.render (A)',
      'video.render (B, 2 worker processes)',
    ]);
    expect(report.steps[4]?.checkpoints?.length).toBeGreaterThanOrEqual(3);

    // Nur die vom Patch betroffenen Frames ändern sich.
    const after = report.steps[6]?.frames ?? [];
    expect(after.filter((f) => f.changed)).toEqual(after.filter((f) => f.expectedChange));
    expect(after.some((f) => f.changed)).toBe(true);

    // Zweiter Worker: gleiche IR, gleiche Frame-Hashes, gerendert in Worker-Prozessen.
    expect(report.reproduction.sameIr).toBe(true);
    expect(report.reproduction.framesA).toBe(180);
    expect(report.reproduction.framesB).toBe(180);
    expect(report.reproduction.frameHashesEqual).toBe(true);
    expect(report.reproduction.chunksB.every((c) => c.worker !== 'server')).toBe(true);
  }, 30 * 60_000);
});
