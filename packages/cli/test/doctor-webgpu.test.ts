// `openvideo doctor` nennt bei fehlendem WebGPU den Grund der Probe (Nacharbeit zur robusten WebGPU-Probe).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor, webgpuCheck } from '@agentic-video/cli';

describe('doctor: WebGPU mit Grund', () => {
  it('nennt den Grund der Probe statt nur „unavailable“', () => {
    expect(webgpuCheck({ webgpu: 'no adapter', webgpuAvailable: false })).toMatchObject({ status: 'warn', detail: 'unavailable: no adapter' });
    const unusable = webgpuCheck({ webgpu: 'google swiftshader (unusable: TypeError: swizzle)', webgpuAvailable: false });
    expect(unusable.detail).toBe('unavailable: google swiftshader (unusable: TypeError: swizzle)');
    expect(unusable.fix).toContain('WebGL2');
  });

  it('erklärt ein fehlendes navigator.gpu', () => {
    expect(webgpuCheck({ webgpu: 'unavailable', webgpuAvailable: false }).detail).toBe('unavailable: navigator.gpu is missing (this Chromium has no WebGPU)');
  });

  it('meldet nutzbares WebGPU mit dem Adapter und ohne Browser eine Warnung', () => {
    expect(webgpuCheck({ webgpu: 'nvidia ampere', webgpuAvailable: true })).toEqual({ status: 'ok', detail: 'nvidia ampere' });
    expect(webgpuCheck(undefined)).toEqual({ status: 'warn', detail: 'browser unavailable' });
  });

  it('runDoctor nutzt dieselbe Zeile', async () => {
    const checks = await runDoctor({ projectDir: mkdtempSync(join(tmpdir(), 'ov-doctor-webgpu-')) });
    const row = checks.find((c) => c.name === 'webgpu');
    expect(row).toBeDefined();
    if (row?.status === 'warn' && row.detail !== 'browser unavailable') expect(row.detail).toMatch(/^unavailable: .+/u);
  }, 120_000);
});
