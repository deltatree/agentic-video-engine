/**
 * `openvideo doctor` (FR-79): prüft die Umgebung und nennt konkrete Lösungen.
 */
import { existsSync } from 'node:fs';
import { access, constants, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import { probeCapabilities } from '@agentic-video/ffmpeg';
import { loadFontSet } from '@agentic-video/fonts';
import { detectBlender } from '@agentic-video/renderer-blender';
import { sandboxAvailable } from '@agentic-video/sandbox';

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
 * Prüft Chromium, WebGL2 und WebGPU auf einer eigenen, statischen Probe-Seite (gemeinsame Probe
 * `probeBrowserGraphics` aus `@agentic-video/renderer-browser`, Story 21.5). Die unsicheren
 * Grafik-Schalter gelten nur hier, wo WebGL/WebGPU geprüft wird; sonst dieselben Schalter, derselbe
 * Grafik-Modus (`OPENVIDEO_BROWSER_GPU`) und dieselbe minimale Umgebung wie der Render-Host.
 */
async function browserProbe(): Promise<{ version: string; webgl2: string; webgpu: string; webgpuAvailable: boolean; mode: string }> {
  const { CHROMIUM_ARGS, probeBrowserGraphics } = await import('@agentic-video/renderer-browser');
  const r = await probeBrowserGraphics({ baseArgs: CHROMIUM_ARGS });
  // `webgpu` ist bei fehlendem WebGPU der Grund aus der Probe (z. B. `no adapter`), nicht nur „unavailable“.
  return { version: r.chromium, webgl2: r.webgl2, webgpu: r.webgpu, webgpuAvailable: r.webgpuAvailable, mode: r.mode };
}

/**
 * Doctor-Zeile für WebGPU aus der Grafik-Probe. Ist WebGPU nicht nutzbar, nennt `detail` den Grund
 * der Probe (`probeWebGPU`: fehlendes `navigator.gpu`, kein Adapter, oder ein Adapter, dessen
 * Mini-Render scheitert), damit klar ist, warum `backend: "auto"` WebGL2 wählt.
 *
 * @example
 * ```ts
 * webgpuCheck({ webgpu: 'no adapter', webgpuAvailable: false });
 * // { status: 'warn', detail: 'unavailable: no adapter', fix: 'scene3d with backend "auto" renders with WebGL2; …' }
 * ```
 */
export function webgpuCheck(probe: { readonly webgpu: string; readonly webgpuAvailable: boolean } | undefined): Omit<DoctorCheck, 'name'> {
  if (probe === undefined) return { status: 'warn', detail: 'browser unavailable' };
  if (probe.webgpuAvailable) return { status: 'ok', detail: probe.webgpu };
  const reason = probe.webgpu === 'unavailable' || probe.webgpu === '' ? 'navigator.gpu is missing (this Chromium has no WebGPU)' : probe.webgpu;
  return {
    status: 'warn',
    detail: `unavailable: ${reason}`,
    fix: 'scene3d with backend "auto" renders with WebGL2; set backend "webgl2" to silence this, or update Chromium and the graphics drivers for WebGPU.',
  };
}

/**
 * Doctor-Zeile zur Laufzeit (ADR 0029): Der Wrapper aus `npm run setup` setzt `OPENVIDEO_RUNTIME_INFO`
 * (z. B. `docker, image openvideo-local:0.1.0`). Ohne die Variable läuft die CLI nativ auf dem Host.
 *
 * @example
 * ```ts
 * runtimeCheck('docker, image openvideo-local:0.1.0');
 * // { status: 'ok', detail: 'docker, image openvideo-local:0.1.0' }
 * ```
 */
export function runtimeCheck(info: string | undefined): Omit<DoctorCheck, 'name'> {
  if (info === undefined || info.trim() === '') return { status: 'ok', detail: 'native (this host)' };
  return { status: 'ok', detail: info.trim() };
}

/**
 * Führt alle Prüfungen aus: Laufzeit, Node, Browser, WebGL, WebGPU, GPU, FFmpeg, Codecs, Blender,
 * Fonts, Dateisystem, Docker, Hardware-Encoder.
 *
 * @example
 * ```ts
 * const checks = await runDoctor({ projectDir: process.cwd(), runtimeInfo: process.env['OPENVIDEO_RUNTIME_INFO'] });
 * ```
 */
export async function runDoctor(options: { readonly projectDir: string; readonly runtimeInfo?: string | undefined }): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const inContainer = options.runtimeInfo !== undefined && options.runtimeInfo.trim() !== '';
  out.push({ name: 'runtime', ...runtimeCheck(options.runtimeInfo) });
  out.push(
    await check('node', () => {
      const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
      const ok = major > 22 || (major === 22 && minor >= 13);
      return Promise.resolve({ status: ok ? ('ok' as const) : ('fail' as const), detail: `Node ${process.versions.node}`, ...(ok ? {} : { fix: 'Install Node.js 22.13 or newer (https://nodejs.org).' }) });
    }),
  );
  let probe: { version: string; webgl2: string; webgpu: string; webgpuAvailable: boolean; mode: string } | undefined;
  out.push(
    await check('browser', async () => {
      probe = await browserProbe();
      return { status: 'ok', detail: `Chromium ${probe.version} (${probe.mode === 'native' ? 'GPU mode: native ANGLE, OPENVIDEO_BROWSER_GPU=1' : 'SwiftShader'})` };
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
  out.push({ name: 'webgpu', ...webgpuCheck(probe) });
  out.push(
    await check('gpu', async () => {
      // Dieselbe Probe wie Render-Manifest und Metrik gpu_memory (Story 21.5).
      const { describeHostGpu, probeHostGpu } = await import('@agentic-video/renderer-browser');
      const gpu = await probeHostGpu();
      if (gpu !== undefined) return { status: 'ok', detail: describeHostGpu(gpu), ...(probe?.mode !== 'native' ? { fix: 'Optional: OPENVIDEO_BROWSER_GPU=1 renders WebGL/WebGPU on this GPU (not bit-identical to SwiftShader).' } : {}) };
      if (existsSync('/dev/nvidia0')) return { status: 'warn', detail: 'NVIDIA device present, but nvidia-smi does not answer.', fix: 'Install the NVIDIA driver utilities or the NVIDIA Container Toolkit.' };
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
      // Im Container des Wrappers gibt es kein Docker; eigene TSX-Projekte laufen dort mit --trusted.
      if (!sandbox.available && inContainer) {
        return { status: 'warn', detail: 'No Docker inside the OpenVideo container (expected).', fix: 'TSX projects: run your OWN project with --trusted; it runs in this container, which sees only the mounted folders. Untrusted TSX needs a native setup with Docker.' };
      }
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
