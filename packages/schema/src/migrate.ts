/**
 * Migration älterer IR-Versionen (FR-5).
 */
import type { Diagnostic } from './diagnostics.js';
import { SCHEMA_VERSION } from './version.js';

/** Ein Migrationsschritt von genau einer Version zur nächsten. */
export interface Migration {
  readonly from: string;
  readonly to: string;
  /** Wandelt das Project um und meldet jeden Informationsverlust als Diagnose. */
  readonly migrate: (project: Record<string, unknown>) => { project: Record<string, unknown>; diagnostics: readonly Diagnostic[] };
}

/** Eingebaute Migrationen. Version 1.0.0 ist die erste veröffentlichte Version. */
export const BUILTIN_MIGRATIONS: readonly Migration[] = [];

/** Ergebnis von {@link migrateProject}. */
export interface MigrationResult {
  readonly project: Record<string, unknown>;
  readonly from: string;
  readonly to: string;
  readonly diagnostics: readonly Diagnostic[];
}

function parse(version: string): [number, number, number] {
  const [a, b, c] = version.split('.').map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
}

/** Vergleicht zwei Versionen: negativ, 0 oder positiv. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Hebt ein Project auf {@link SCHEMA_VERSION}. Kleinere Versionen derselben Major-Version
 * sind kompatibel und bekommen nur die neue Versionsnummer.
 *
 * @example
 * ```ts
 * const { project, diagnostics } = migrateProject(JSON.parse(oldText));
 * ```
 */
export function migrateProject(input: unknown, migrations: readonly Migration[] = BUILTIN_MIGRATIONS, target: string = SCHEMA_VERSION): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('migrateProject expects a project object');
  }
  let project: Record<string, unknown> = { ...Object.fromEntries(Object.entries(input)) };
  const version = project['schemaVersion'];
  const diagnostics: Diagnostic[] = [];
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    diagnostics.push({
      code: 'OV_SCHEMA_VERSION',
      severity: 'error',
      errorClass: 'MigrationError',
      problem: 'The project has no valid "schemaVersion"; it cannot be migrated safely.',
      path: 'schemaVersion',
      suggestions: [`Add schemaVersion: "${target}" if the file was written for this version.`],
    });
    return { project, from: String(version), to: String(version), diagnostics };
  }
  let current = version;
  if (compareVersions(current, target) > 0) {
    diagnostics.push({
      code: 'OV_SCHEMA_VERSION',
      severity: 'error',
      errorClass: 'MigrationError',
      problem: `The project uses schema ${current}, which is newer than this OpenVideo (${target}).`,
      path: 'schemaVersion',
      suggestions: ['Update OpenVideo to a newer version.'],
    });
    return { project, from: version, to: current, diagnostics };
  }
  while (parse(current)[0] < parse(target)[0]) {
    const step = migrations.find((m) => m.from === current);
    if (step === undefined) {
      diagnostics.push({
        code: 'OV_SCHEMA_VERSION',
        severity: 'error',
        errorClass: 'MigrationError',
        problem: `No migration path from schema ${current} to ${target}.`,
        path: 'schemaVersion',
        suggestions: ['Recreate the project with the current version.'],
      });
      return { project, from: version, to: current, diagnostics };
    }
    const result = step.migrate(project);
    project = { ...result.project, schemaVersion: step.to };
    diagnostics.push(...result.diagnostics);
    current = step.to;
  }
  if (current !== target) project = { ...project, schemaVersion: target };
  return { project, from: version, to: target, diagnostics };
}
