/**
 * Benannte, überwachte Skips für umgebungsabhängige Tests (Story 22.1, Entscheidung T12).
 *
 * Lokal darf ein Test übersprungen werden, wenn z. B. Docker, Piper oder whisper.cpp fehlen –
 * immer mit Begründung. In CI setzt der Workflow `OPENVIDEO_REQUIRE_ALL=1`: Dann wird jeder
 * solche Skip zum Fehler, außer er steht auf der Allowlist (`allowInCi`, z. B. GPU-Tests).
 */
import { OpenVideoError } from '@agentic-video/core';

/** Optionen für {@link skipUnless}. */
export interface SkipOptions {
  /**
   * `true` erlaubt den Skip auch mit `OPENVIDEO_REQUIRE_ALL=1` (Allowlist, etwa für GPU-Hardware,
   * die kein CI-Runner hat).
   */
  readonly allowInCi?: boolean;
  /** Umgebung für den Wächter; Standard: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Ein protokollierter Skip (für Berichte und Tests). */
export interface SkipRecord {
  /** Die benannte Begründung. */
  readonly reason: string;
  /** `true`, wenn der Skip auf der Allowlist steht. */
  readonly allowInCi: boolean;
}

const recorded: SkipRecord[] = [];

/** `true`, wenn der CI-Wächter aktiv ist (`OPENVIDEO_REQUIRE_ALL=1`). */
export function requireAll(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env['OPENVIDEO_REQUIRE_ALL'] === '1';
}

/**
 * Entscheidet, ob ein umgebungsabhängiger Test übersprungen wird. Gibt `true` zurück, wenn
 * `available` falsch ist – zur Verwendung mit `it.skipIf(...)`/`describe.skipIf(...)`.
 *
 * Mit `OPENVIDEO_REQUIRE_ALL=1` wirft die Funktion stattdessen `OV_TEST_SKIP_FORBIDDEN`, damit
 * eine fehlende Werkzeugkette in CI rot wird statt still zu verschwinden. Ausnahmen stehen mit
 * `allowInCi: true` auf der Allowlist.
 *
 * @param available - Ist die Umgebung vorhanden (Werkzeug, Image, Modell)?
 * @param reason - Benannte Begründung, was fehlt und wie man es installiert.
 * @param options - Allowlist-Eintrag und Umgebung.
 * @returns `true`, wenn übersprungen werden soll.
 *
 * @example
 * ```ts
 * import { it } from 'vitest';
 * import { skipUnless } from '@agentic-video/testing';
 *
 * it.skipIf(skipUnless(dockerOk, 'Docker fehlt: Docker-Daemon starten'))('läuft im Container', async () => {
 *   // ...
 * });
 * ```
 */
export function skipUnless(available: boolean, reason: string, options: SkipOptions = {}): boolean {
  if (available) return false;
  const allowInCi = options.allowInCi === true;
  if (requireAll(options.env) && !allowInCi) {
    throw new OpenVideoError({
      code: 'OV_TEST_SKIP_FORBIDDEN',
      errorClass: 'TestEnvironmentError',
      problem: `A test would be skipped although OPENVIDEO_REQUIRE_ALL=1 forbids it: ${reason}`,
      suggestions: [
        'Install the missing tool in the CI job (see .github/workflows/ci.yml).',
        'If the environment can never exist on CI runners (e.g. GPU hardware), pass { allowInCi: true } to skipUnless.',
        'Unset OPENVIDEO_REQUIRE_ALL to allow named skips locally.',
      ],
    });
  }
  recorded.push({ reason, allowInCi });
  return true;
}

/**
 * Bisher in diesem Prozess protokollierte Skips.
 *
 * @example
 * ```ts
 * skipUnless(false, 'Piper fehlt');
 * skippedTests(); // [{ reason: 'Piper fehlt', allowInCi: false }]
 * ```
 */
export function skippedTests(): readonly SkipRecord[] {
  return [...recorded];
}

/**
 * `true`, wenn Wall-Clock-Grenzen geprüft werden sollen (`OV_PERF_STRICT=1`, Story 22.4).
 * Harte Zeitgrenzen hängen von der Maschine ab; ohne den Schalter laufen solche Tests nicht,
 * damit geteilte CI-Runner nicht zufällig rot werden. Der Nightly-Benchmark setzt ihn.
 *
 * @example
 * ```ts
 * import { it } from 'vitest';
 * import { perfStrict } from '@agentic-video/testing';
 *
 * it.skipIf(!perfStrict())('1080p in unter 600 ms', () => {
 *   // ...
 * });
 * ```
 */
export function perfStrict(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env['OV_PERF_STRICT'] === '1';
}
