import { describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { OpenVideoError } from '@agentic-video/core';
import { SANDBOX_IMAGE, dockerRunArgs, DEFAULT_LIMITS, runSandboxed, sandboxAvailable, type SandboxRequest } from '@agentic-video/sandbox';

const docker = await sandboxAvailable();
const noDocker = !docker.available;

async function failure(request: SandboxRequest): Promise<OpenVideoError> {
  try {
    await runSandboxed(request);
  } catch (error) {
    expect(error).toBeInstanceOf(OpenVideoError);
    return error as OpenVideoError;
  }
  throw new Error('expected the sandbox run to fail');
}

/** Fremdtext des ausgeführten Codes aus `details.untrusted`. */
function untrusted(e: OpenVideoError): string {
  return String(e.diagnostic.details?.['untrusted']);
}

describe('docker arguments', () => {
  it('pins the image by digest and sets every isolation flag', () => {
    expect(SANDBOX_IMAGE).toMatch(/^node:22-alpine@sha256:[0-9a-f]{64}$/);
    const args = dockerRunArgs('ov-sandbox-test', DEFAULT_LIMITS).join(' ');
    for (const flag of ['--rm -i', '--network none', '--read-only', '--tmpfs /tmp:rw,noexec,nosuid,size=16m', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 64', '--memory 512m', '--memory-swap 512m', '--cpus 1', '--user 65534:65534', '--ulimit nofile=64']) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain('-v ');
    expect(args).not.toContain('--mount');
  });
});

describe.skipIf(skipUnless(!noDocker, 'Docker fehlt: die Sandbox braucht einen laufenden Docker-Daemon'))('docker sandbox (needs Docker)', () => {
  it('returns the completion value and passes input over stdin', async () => {
    const r = await runSandboxed({ code: '({ sum: input.a + input.b, node: process.version })', input: { a: 40, b: 2 } });
    expect(r.output).toEqual({ sum: 42, node: expect.stringMatching(/^v22\./) });
    expect(r.trusted).toBe(false);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('awaits promises', async () => {
    const r = await runSandboxed({ code: 'Promise.resolve(7)' });
    expect(r.output).toBe(7);
  });

  it('reports thrown errors with the stack', async () => {
    const e = await failure({ code: '\n\nthrow new TypeError("boom")', filename: 'bundle.js' });
    expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
    expect(untrusted(e)).toContain('bundle.js:3');
  });

  describe('security (NFR-5)', () => {
    const fs = "process.getBuiltinModule('fs')";
    it('cannot read host files', async () => {
      const e = await failure({ code: `${fs}.readFileSync(${JSON.stringify(`${process.cwd()}/package.json`)}, 'utf8')` });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
      expect(untrusted(e)).toContain('ENOENT');
    });

    it('cannot reach the internet', async () => {
      const e = await failure({ code: "fetch('https://example.com').then((r) => r.status)", limits: { timeoutMs: 20_000 } });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
      expect(untrusted(e)).toContain('fetch failed');
    });

    it('cannot reach the cloud metadata service', async () => {
      const e = await failure({ code: "fetch('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(5000) }).then((r) => r.status)", limits: { timeoutMs: 20_000 } });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
    });

    it('has no docker socket', async () => {
      const e = await failure({ code: `${fs}.statSync('/var/run/docker.sock')` });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
      expect(untrusted(e)).toContain('ENOENT');
    });

    it('cannot write to the root file system', async () => {
      const e = await failure({ code: `${fs}.writeFileSync('/evil.txt', 'x')` });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
      expect(untrusted(e)).toMatch(/EROFS|EACCES/);
    });

    it('stops a fork bomb with the pids limit', async () => {
      const code = `
        const cp = process.getBuiltinModule('child_process');
        let started = 0;
        for (let i = 0; i < 500; i++) {
          const r = cp.spawnSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 &'], { encoding: 'utf8', timeout: 5000 });
          if (r.error || r.status !== 0) throw new Error('fork blocked after ' + started + ' processes: ' + (r.error ? r.error.code : r.stderr));
          started++;
        }
        started;`;
      const e = await failure({ code, limits: { pids: 32, timeoutMs: 30_000 } });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_CRASH');
      expect(untrusted(e)).toMatch(/fork blocked after \d+ processes/);
      const started = Number(/after (\d+)/.exec(untrusted(e))?.[1]);
      expect(started).toBeLessThan(32);
    });

    it('ends a memory overflow with OV_SANDBOX_MEMORY', async () => {
      const e = await failure({ code: 'const a = []; while (true) a.push(new Array(1e6).fill(1.5));', limits: { memoryMb: 128, timeoutMs: 30_000 } });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_MEMORY');
    });

    it('ends an endless loop with OV_SANDBOX_TIMEOUT', async () => {
      const started = Date.now();
      const e = await failure({ code: 'while (true) {}', limits: { timeoutMs: 3000 } });
      expect(e.diagnostic.code).toBe('OV_SANDBOX_TIMEOUT');
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });
});

describe('trusted-host mode', () => {
  it('runs in an empty VM context and marks the result as trusted', async () => {
    const r = await runSandboxed({ code: '({ v: input.v * 2, require: typeof require, process: typeof process, fetch: typeof fetch })', input: { v: 21 }, mode: 'trusted-host' });
    expect(r.output).toEqual({ v: 42, require: 'undefined', process: 'undefined', fetch: 'undefined' });
    expect(r.trusted).toBe(true);
  });

  it('stops endless loops', async () => {
    const e = await failure({ code: 'while (true) {}', mode: 'trusted-host', limits: { timeoutMs: 1000 } });
    expect(e.diagnostic.code).toBe('OV_SANDBOX_TIMEOUT');
  });

  it('reports memory overflow', async () => {
    const e = await failure({ code: 'const a = []; while (true) a.push(new Array(1e6).fill(1.5));', mode: 'trusted-host', limits: { memoryMb: 64, timeoutMs: 30_000 } });
    expect(e.diagnostic.code).toBe('OV_SANDBOX_MEMORY');
  });

  it('rejects invalid limits', async () => {
    const e = await failure({ code: '1', mode: 'trusted-host', limits: { timeoutMs: -1 } });
    expect(e.diagnostic.code).toBe('OV_SANDBOX_LIMITS');
  });
});
