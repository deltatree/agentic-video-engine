/**
 * Regressionstest C8 (Code-Review 2026-09-28): Ungültiges JSON in `details.untrusted`
 * darf den eigentlichen Laufzeitfehler nicht durch einen SyntaxError verdecken.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OpenVideoError } from '@agentic-video/core';
import { compileTsx } from '@agentic-video/compiler';

vi.mock('@agentic-video/sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agentic-video/sandbox')>();
  return {
    ...original,
    runSandboxed: () =>
      Promise.reject(
        new OpenVideoError({ code: 'OV_SANDBOX_CRASH', errorClass: 'SandboxError', problem: 'The code threw an error.', suggestions: ['x'], details: { mode: 'trusted-host', thrown: true, untrusted: '{"stack": "cut off' } }),
      ),
  };
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('C8: ungültiges untrusted-JSON', () => {
  it('liefert OV_COMPILE_RUNTIME statt eines SyntaxError', async () => {
    const error: unknown = await compileTsx('sampled.tsx', { projectDir: fixtures, mode: 'trusted-host' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenVideoError);
    if (!(error instanceof OpenVideoError)) return;
    expect(error.diagnostic.code).toBe('OV_COMPILE_RUNTIME');
    expect(error.diagnostic.details?.['untrusted']).toBe('{"stack": "cut off');
  });
});
