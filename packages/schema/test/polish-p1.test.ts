/**
 * Politur P1: `migrateProject` meldet Eingaben, die kein Objekt sind, als OpenVideoError
 * (erreichbar über `openvideo migrate <datei>`).
 */
import { describe, expect, it } from 'vitest';
import { OpenVideoError, migrateProject } from '@agentic-video/schema';

describe('migrateProject mit Nicht-Objekt (Politur P1)', () => {
  it.each([[[]], [null], ['project'], [3]])('wirft OV_SCHEMA_NOT_OBJECT für %j', (input) => {
    let caught: unknown;
    try {
      migrateProject(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenVideoError);
    if (caught instanceof OpenVideoError) {
      expect(caught.diagnostic.code).toBe('OV_SCHEMA_NOT_OBJECT');
      expect(caught.diagnostic.suggestions.length).toBeGreaterThan(0);
    }
  });
});
