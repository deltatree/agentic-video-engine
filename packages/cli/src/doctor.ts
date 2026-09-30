/**
 * `openvideo doctor` (FR-79): prüft die Umgebung und nennt konkrete Lösungen.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { access, constants, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OpenVideoError } from '@agentic-video/core';
import { probeCapabilities } from '@agentic-video/ffmpeg';
import { loadFontSet } from '@agentic-video/fonts';
import { detectBlender } from '@agentic-video/renderer-blender';
import { sandboxAvailable } from '@agentic-video/sandbox';

const run = promisify(execFile);

/** Ergebnis einer Prüfung. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly fix?: string;
}

async function check(name: string, fn: () => Promise<Omit<DoctorCheck, 'name'>>): Promise<DoctorCheck> {
  try {
    return { name, ...(await fn()) };
  } catch (error) {
    const d = error instanceof OpenVideoError ? error.diagnostic : undefined;
    return { name, status: 'fail', detail: d?.problem ?? (error instanceof Error ? error.message : String(error)), ...(d?.suggestions[0] !== undefined ? { fix: d.suggestions[0] } : {}) };
  }
}

/**
 * Prüft Chromium, WebGL2 und WebGPU auf einer eigenen, statischen Probe-Seite. Die unsicheren
 * Grafik-Schalter (`CHROMIUM_GRAPHICS_ARGS`: SwiftShader, WebGPU) gelten nur hier, wo WebGL/WebGPU
 * geprüft wird; sonst dieselben Schalter und dieselbe minimale Umgebung wie der Render-Host.
 */
async function browserProbe(): Promise<{ version: string; webgl2: string; webgpu: string }> {
  const { chromium } = await import('playwright-core');
  const { CHROMIUM_ARGS, CHROMIUM_GRAPHICS_ARGS, chromiumEnv } = await import('@agentic-video/renderer-browser');
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>probe</title>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const browser = await chromium.launch({ executablePath: process.env['OPENVIDEO_CHROMIUM'] ?? chromium.executablePath(), args: [...CHROMIUM_ARGS, ...CHROMIUM_GRAPHICS_ARGS], env: chromiumEnv(process.env) });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${String(port)}/`);
    const r = await page.evaluate(async () => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl !== null && info !== null && info !== undefined ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
      let gpu = 'unavailable';
      const g: unknown = Reflect.get(navigator, 'gpu');
      if (typeof g === 'object' && g !== null && 'requestAdapter' in g && typeof g.requestAdapter === 'function') {
        const adapter: unknown = await Reflect.apply(g.requestAdapter, g, []);
        const info: unknown = typeof adapter === 'object' && adapter !== null ? Reflect.get(adapter, 'info') : undefined;
        const field = (k: string): string => (typeof info === 'object' && info !== null ? String(Reflect.get(info, k) ?? '') : '');
        gpu = adapter === null ? 'no adapter' : `${field('vendor')} ${field('architecture')}`.trim() || 'adapter';
      }
      return { renderer, gpu };
    });
    return { version: browser.version(), webgl2: r.renderer, webgpu: r.gpu };
  } finally {
    await browser.close();
    server.close();
  }
}

/**
 * Führt alle Prüfungen aus: Node, Browser, WebGL, WebGPU, GPU, FFmpeg, Codecs, Blender,
 * Fonts, Dateisystem, Docker, Hardware-Encoder.
 *
 * @example
 * ```ts
 * const checks = await runDoctor({ projectDir: process.cwd() });
 * ```
 */
export async function runDoctor(options: { readonly projectDir: string }): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  out.push(
    await check('node', () => {
      const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
      const ok = major > 22 || (major === 22 && minor >= 13);
      return Promise.resolve({ status: ok ? ('ok' as const) : ('fail' as const), detail: `Node ${process.versions.node}`, ...(ok ? {} : { fix: 'Install Node.js 22.13 or newer (https://nodejs.org).' }) });
    }),
  );
  let probe: { version: string; webgl2: string; webgpu: string } | undefined;
  out.push(
    await check('browser', async () => {
      probe = await browserProbe();
      return { status: 'ok', detail: `Chromium ${probe.version}` };
    }),
  );
  if (out[out.length - 1]?.status === 'fail') out[out.length - 1] = { ...(out[out.length - 1] ?? { name: 'browser', status: 'fail', detail: '' }), fix: 'Run `npx playwright install chromium`, or set OPENVIDEO_CHROMIUM to a Chromium binary.' };
  if (probe !== undefined) {
    out.push(
      await check('browser-sandbox', async () => {
        // Ohne unsichere Schalter (Story 16.1): startet Chromium mit der OS-Sandbox?
        const { probeOsSandbox } = await import('@agentic-video/renderer-browser');
        const sandboxed = await probeOsSandbox(process.env['OPENVIDEO_CHROMIUM']);
        return sandboxed
          ? { status: 'ok', detail: 'Chromium starts with the OS sandbox; HTML scripts can be enabled with --trusted.' }
          : { status: 'warn', detail: 'Chromium starts only without the OS sandbox; HTML scripts stay disabled.', fix: 'Allow unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=1) and do not run as root.' };
      }),
    );
  }
  out.push({ name: 'webgl', status: probe === undefined ? 'fail' : probe.webgl2 === 'unavailable' ? 'fail' : 'ok', detail: probe?.webgl2 ?? 'browser unavailable', ...(probe?.webgl2 === 'unavailable' ? { fix: 'Update graphics drivers, or keep the SwiftShader flags (CPU rendering).' } : {}) });
  out.push({ name: 'webgpu', status: probe === undefined || probe.webgpu === 'unavailable' ? 'warn' : 'ok', detail: probe?.webgpu ?? 'browser unavailable', ...(probe?.webgpu === 'unavailable' ? { fix: 'WebGPU falls back to WebGL2; set scene3d.backend to "webgl2" to silence this.' } : {}) });
  out.push(
    await check('gpu', async () => {
      if (existsSync('/dev/nvidia0')) {
        const r = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']).catch(() => ({ stdout: 'NVIDIA device present' }));
        return { status: 'ok', detail: r.stdout.trim() };
      }
      const dri = existsSync('/dev/dri') ? readdirSync('/dev/dri').filter((f) => f.startsWith('renderD')) : [];
      if (dri.length > 0) return { status: 'ok', detail: `DRM render nodes: ${dri.join(', ')}` };
      return { status: 'warn', detail: 'No GPU found; rendering uses the CPU (SwiftShader, Skia CPU).', fix: 'Optional: use the openvideo/render-gpu image on a GPU host.' };
    }),
  );
  let caps: Awaited<ReturnType<typeof probeCapabilities>> | undefined;
  out.push(
    await check('ffmpeg', async () => {
      caps = await probeCapabilities();
      return { status: 'ok', detail: `FFmpeg ${caps.version} (${caps.license})` };
    }),
  );
  out.push(
    await check('codecs', () => {
      if (caps === undefined) return Promise.resolve({ status: 'fail' as const, detail: 'FFmpeg unavailable', fix: 'Install FFmpeg first.' });
      const wanted = ['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'prores_ks', 'gif', 'libwebp_anim', 'png', 'aac', 'libopus'];
      const missing = wanted.filter((e) => !(caps?.encoders.includes(e) ?? false));
      return Promise.resolve({ status: missing.length === 0 ? ('ok' as const) : ('warn' as const), detail: missing.length === 0 ? 'All encoders present.' : `Missing encoders: ${missing.join(', ')}`, ...(missing.length > 0 ? { fix: 'Use a full FFmpeg build (e.g. johnvansickle static builds or your distribution package).' } : {}) });
    }),
  );
  out.push(
    await check('blender', () => {
      const b = detectBlender();
      if (!b.found) throw new OpenVideoError(b.diagnostic);
      return Promise.resolve({ status: 'ok' as const, detail: `Blender ${b.version} (${b.path})` });
    }),
  );
  const blender = out[out.length - 1];
  if (blender?.status === 'fail') out[out.length - 1] = { ...blender, status: 'warn', fix: blender.fix ?? 'Install Blender 4.2 LTS for blender nodes (optional).' };
  out.push(
    await check('fonts', async () => {
      const fonts = await loadFontSet({ projectDir: options.projectDir });
      const families = [...new Set(fonts.all().map((f) => f.family))];
      return { status: families.length > 0 ? 'ok' : 'fail', detail: `${String(families.length)} families: ${families.join(', ')}` };
    }),
  );
  out.push(
    await check('filesystem', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ov-doctor-'));
      await writeFile(join(dir, 'probe'), 'ok');
      await rm(dir, { recursive: true });
      await access(options.projectDir, constants.W_OK);
      const fs = await statfs(options.projectDir);
      const freeGb = (fs.bavail * fs.bsize) / 1e9;
      return { status: freeGb < 5 ? 'warn' : 'ok', detail: `Project folder writable, ${freeGb.toFixed(1)} GB free`, ...(freeGb < 5 ? { fix: 'Free disk space; 4K renders need several GB of frame cache.' } : {}) };
    }),
  );
  out.push(
    await check('docker', async () => {
      const sandbox = await sandboxAvailable();
      return sandbox.available
        ? { status: 'ok', detail: `Docker ${sandbox.version ?? ''} is available (sandbox image ${sandbox.image}).`.replace('  ', ' ') }
        : { status: 'warn', detail: `Docker is not available${sandbox.reason !== undefined ? `: ${sandbox.reason}` : ''}.`, fix: 'Install Docker to run TSX projects and scripted HTML safely; JSON projects work without it.' };
    }),
  );
  out.push(
    await check('hardware encoders', () => {
      if (caps === undefined) return Promise.resolve({ status: 'warn' as const, detail: 'FFmpeg unavailable' });
      const hw = Object.entries(caps.hardwareEncoders).filter(([, v]) => v).map(([k]) => k);
      return Promise.resolve({ status: 'ok' as const, detail: hw.length > 0 ? `Available: ${hw.join(', ')}` : 'None; CPU encoding is used (always available).' });
    }),
  );
  return out;
}
