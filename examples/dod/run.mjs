#!/usr/bin/env node
// Definition-of-Done-Test (Auftrag Abschnitt 50, Story 15.2).
// Das Skript spielt einen Coding Agent: Es spricht nur die HTTP-Agent-API an (POST /v1/<operation>).
// OpenVideo-Pakete importiert es nur, um die beiden Server zu starten.
//
// Aufruf:
//   node examples/dod/run.mjs --short            # 1920×1080, 6 s (CI)
//   node examples/dod/run.mjs                    # 3840×2160, 60 s, 30 fps
//   Optionen: --out <ordner> (Standard examples/dod/out/<variante>), --report-dir <ordner>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalServices } from '@agentic-video/cli';
import { startAgentServer } from '@agentic-video/agent';
import { COMPONENTS, SCENES, buildPlan } from './project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const short = args.includes('--short');
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const variant = short ? { name: 'short', width: 1920, height: 1080, fps: 30, seconds: 6 } : { name: 'full', width: 3840, height: 2160, fps: 30, seconds: 60 };
const outDir = resolve(opt('--out') ?? join(here, 'out', variant.name));
const reportDir = resolve(opt('--report-dir') ?? outDir);
const voiceProvider = opt('--voice') ?? 'espeak-ng';
// Server A rendert mit mehreren Worker-Prozessen, Server B (Reproduktion) mit zwei.
const WORKERS_A = Number(opt('--workers-a') ?? 4);
const WORKERS_B = 2;

const t0 = performance.now();
const timings = {};
const log = (msg) => process.stdout.write(`[dod ${((performance.now() - t0) / 1000).toFixed(1).padStart(7)} s] ${msg}\n`);
const sha = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

async function timed(label, fn) {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = Math.round(performance.now() - start) / 1000;
    log(`${label}: ${timings[label]} s`);
  }
}

class ApiError extends Error {
  constructor(operation, status, error) {
    super(`${operation} → HTTP ${status}: ${error?.code ?? '?'} ${error?.problem ?? JSON.stringify(error)}\n  suggestions: ${(error?.suggestions ?? []).join(' | ')}`);
    this.diagnostic = error;
  }
}

/** Obergrenze je HTTP-Aufruf; ein 4K-Frame mit 3D und HTML braucht auf der CPU höchstens Minuten. */
const CALL_TIMEOUT_MS = 20 * 60_000;

/** Ein Agent-Client: nur `fetch` gegen die dokumentierte HTTP-API. */
function client(baseUrl) {
  return {
    baseUrl,
    async call(operation, input) {
      const res = await fetch(`${baseUrl}/v1/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const body = await res.json();
      if (!res.ok || body.error !== undefined) throw new ApiError(operation, res.status, body.error);
      return body;
    },
    async file(projectId, path) {
      const res = await fetch(`${baseUrl}/v1/files/${projectId}/${path}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (!res.ok) throw new ApiError(`GET files/${path}`, res.status, (await res.json()).error);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** Startet einen Agent-Server mit eigenem Workspace und eigenem, leerem Cache. */
async function startServer(name, workers) {
  const workspaceDir = join(outDir, `workspace-${name}`);
  rmSync(workspaceDir, { recursive: true, force: true });
  // Kein gemeinsamer Cache: Jeder Server nutzt <workspace>/.openvideo/cache.
  const env = { ...process.env };
  delete env['OPENVIDEO_CACHE_DIR'];
  delete env['OPENVIDEO_CACHE_S3_BUCKET'];
  const services = await createLocalServices({ workspaceDir, env, ...(workers !== undefined ? { workers } : {}) });
  const server = await startAgentServer({ services, port: 0 });
  log(`server ${name}: ${server.url} (workspace ${relative(repo, workspaceDir)}${workers !== undefined ? `, ${workers} Worker-Prozesse` : ', rendert selbst'})`);
  return {
    api: client(server.url),
    async close() {
      await server.close();
      await services.dispose();
    },
  };
}

async function waitForJob(api, jobId, label) {
  let last = '';
  for (;;) {
    const s = await api.call('render.status', { jobId });
    const line = `${s.state} ${s.progress?.stage ?? ''} ${s.progress?.done ?? 0}/${s.progress?.total ?? 0}`;
    if (line !== last) {
      log(`${label}: ${line}`);
      last = line;
    }
    if (s.state === 'succeeded') return s.result;
    if (s.state === 'failed' || s.state === 'cancelled') throw new ApiError(`${label} (${s.state})`, 500, s.error);
    await new Promise((r) => setTimeout(r, short ? 500 : 5000));
  }
}

/** Startet einen Video-Render-Job und wartet auf das Ergebnis. */
async function renderVideo(api, projectId, profile, label) {
  const job = await api.call('video.render', { projectId, profile, outName: 'dod.mp4' });
  const result = await waitForJob(api, job.jobId, label);
  return { result, jobs: [{ jobId: job.jobId, framesRendered: result.framesRendered, framesFromCache: result.framesFromCache }] };
}

const ASSETS = [
  { id: 'logo', file: 'logo.svg' },
  { id: 'product', file: 'product.glb' },
  { id: 'photo', file: 'photo.png' },
  { id: 'clip', file: 'clip.mp4' },
  { id: 'music', file: 'music.wav' },
  { id: 'whoosh', file: 'whoosh.wav' },
];

async function importAssets(api, projectId, assetDir) {
  const out = [];
  for (const a of ASSETS) {
    const bytes = readFileSync(join(assetDir, a.file));
    const r = await api.call('asset.import', { projectId, base64: bytes.toString('base64'), fileName: a.file, id: a.id });
    const problems = r.diagnostics.filter((d) => d.severity === 'error');
    if (problems.length > 0) throw new Error(`asset.import ${a.id}: ${problems.map((d) => d.problem).join('; ')}`);
    out.push({ id: a.id, type: r.asset.type, src: r.asset.src, hash: r.asset.hash });
  }
  return out;
}

async function patch(api, projectId, label, patches) {
  const r = await api.call('composition.patch', { projectId, patches });
  if (!r.ok) throw new Error(`composition.patch (${label}) failed:\n${r.diagnostics.map((d) => `  ${d.code} ${d.path ?? ''}: ${d.problem}`).join('\n')}`);
  log(`patch ${label}: ${patches.length} Operation(en)`);
  return r;
}

/** JSON mit sortierten Schlüsseln, damit die Reihenfolge der Felder keinen Unterschied macht. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Findet eine Node im gespeicherten Projekt (rekursiv über children und mask.node). */
function findNode(nodes, id) {
  for (const n of nodes ?? []) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id) ?? (n.mask?.node ? findNode([n.mask.node], id) : undefined);
    if (hit) return hit;
  }
  return undefined;
}

function nodePath(nodes, id, trail = []) {
  for (const n of nodes ?? []) {
    if (n.id === id) return [...trail, id];
    const hit = nodePath(n.children, id, [...trail, n.id]);
    if (hit) return hit;
  }
  return undefined;
}

/** Prüft jeden der 21 Bestandteile im gespeicherten Projekt und liefert die Fundstellen. */
function locateComponents(project) {
  const comp = project.compositions[0];
  return COMPONENTS.map((c, i) => {
    const found = c.where.map((w) => {
      if (w.node !== undefined) {
        const n = findNode(comp.nodes, w.node);
        const ok = n !== undefined && (w.prop === undefined || n[w.prop] !== undefined);
        return { ok, ref: `node ${(nodePath(comp.nodes, w.node) ?? [w.node]).join(' › ')}${w.prop ? ` .${w.prop}` : ''}${n ? ` (type ${n.type})` : ''}` };
      }
      if (w.track !== undefined) {
        const t = (comp.tracks ?? []).find((x) => x.id === w.track);
        return { ok: t !== undefined, ref: `track ${w.track}${t ? ` (${t.kind}${t.role ? `/${t.role}` : ''}, ${(t.clips ?? t.cues ?? []).length} Einträge)` : ''}` };
      }
      const a = (project.audio ?? []).find((x) => x.id === w.audio);
      return { ok: a !== undefined, ref: `audio ${w.audio}${a?.voice ? ` (voice ${a.voice.provider})` : ''}` };
    });
    return { n: i + 1, name: c.name, ok: found.every((f) => f.ok), where: found.map((f) => f.ref), note: c.note };
  });
}

function savePng(name, base64) {
  const file = join(outDir, 'frames', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}

async function main() {
  log(`Variante ${variant.name}: ${variant.width}×${variant.height}, ${variant.seconds} s, ${variant.fps} fps → ${relative(repo, outDir)}`);
  rmSync(join(outDir, 'frames'), { recursive: true, force: true });
  for (const name of ['dod-report.json', 'dod-report.md']) rmSync(join(outDir, name), { force: true });
  mkdirSync(outDir, { recursive: true });

  // 0. Assets erzeugen (lizenzfrei, deterministisch)
  const assetDir = join(outDir, 'assets');
  await timed('assets.generate', () => {
    if (ASSETS.every((x) => existsSync(join(assetDir, x.file)))) return Promise.resolve();
    const r = spawnSync(process.execPath, [join(here, 'generate-assets.mjs'), assetDir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`generate-assets.mjs failed: ${r.stderr}`);
    return Promise.resolve();
  });

  const a = await startServer('a', WORKERS_A);
  let b;
  const report = {
    variant: { ...variant, voiceProvider },
    host: { cpus: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.version, platform: `${process.platform} ${process.arch}` },
    steps: [],
  };
  const step = (name, detail) => {
    report.steps.push({ step: report.steps.length + 1, name, ...detail });
  };
  try {
    const api = a.api;
    const plan = buildPlan({ ...variant, voiceProvider });

    // 1. project.create
    const created = await timed('project.create', () => api.call('project.create', { name: `dod-${variant.name}`, width: variant.width, height: variant.height, fps: variant.fps, duration: `${variant.seconds}s` }));
    const projectId = created.projectId;
    step('project.create', { projectId, compositions: created.compositions });

    // 2. asset.import
    const assets = await timed('asset.import', () => importAssets(api, projectId, assetDir));
    step('asset.import', { assets });

    // 3. Aufbau über semantische Patches
    await timed('composition.patch (build)', async () => {
      await patch(api, projectId, 'metadata', [{ op: 'setProjectProperty', property: 'metadata', value: { title: 'OpenVideo – Definition of Done', description: 'All 21 components of section 50, built by an agent through the HTTP API.' } }]);
      await patch(api, projectId, 'grade + shader', [
        { op: 'addNode', parentId: null, node: plan.grade },
        { op: 'addNode', parentId: 'grade', node: plan.background },
      ]);
      for (const [name, scene] of Object.entries(plan.scenes)) await patch(api, projectId, `scene ${name}`, [{ op: 'addNode', parentId: 'grade', node: scene }]);
      await patch(api, projectId, 'audio + tracks + markers', [
        { op: 'setProjectProperty', property: 'audio', value: plan.audio },
        { op: 'setCompositionProperty', compositionId: 'main', property: 'tracks', value: plan.tracks },
        { op: 'setCompositionProperty', compositionId: 'main', property: 'markers', value: plan.markers },
      ]);
      await patch(api, projectId, 'captions', [{ op: 'addNode', parentId: null, node: plan.captions }]);
    });
    step('composition.patch', { calls: 9 });

    // 4. Validieren
    const validation = await timed('composition.validate', () => api.call('composition.validate', { projectId }));
    const errors = validation.diagnostics.filter((d) => d.severity === 'error');
    const warnings = validation.diagnostics.filter((d) => d.severity === 'warning');
    for (const d of warnings) log(`  warning ${d.code} ${d.path ?? ''}: ${d.problem}`);
    if (!validation.ok || errors.length > 0) throw new Error(`composition.validate: ${errors.length} Fehler\n${validation.text}`);
    step('composition.validate', { ok: validation.ok, errors: errors.length, warnings: warnings.map((d) => `${d.code}: ${d.problem}`) });

    // Fundstellen der 21 Bestandteile im gespeicherten Projekt
    const info = await api.call('project.inspect', { projectId });
    const ir = JSON.parse((await api.file(projectId, info.entry)).toString('utf8'));
    const components = locateComponents(ir);
    const missing = components.filter((c) => !c.ok);
    if (missing.length > 0) throw new Error(`Bestandteile fehlen: ${missing.map((c) => c.name).join(', ')}`);
    report.components = components;

    // 5. Frames rendern und inspizieren (Mitte jeder Szene)
    const checkpoints = Object.entries(SCENES).map(([name, [s, e]]) => ({ scene: name, frame: Math.round(((s + e) / 2) * variant.seconds * variant.fps) }));
    const before = {};
    await timed('frame.render + frame.inspect', async () => {
      for (const c of checkpoints) {
        const r = await api.call('frame.render', { projectId, frame: c.frame });
        const png = Buffer.from(r.image.base64, 'base64');
        before[c.frame] = { hash: sha(png), key: r.key };
        savePng(`before-${c.scene}-${c.frame}.png`, r.image.base64);
        const inspected = await api.call('frame.inspect', { projectId, frame: c.frame });
        const ids = [];
        const walk = (list) => {
          for (const n of list) {
            if (n.opacity === undefined || n.opacity > 0) ids.push(n.id);
            walk(n.children ?? []);
          }
        };
        walk(inspected.tree);
        c.visibleNodes = ids.length;
        c.scenesVisible = ids.filter((id) => typeof id === 'string' && id.startsWith('scene-'));
        c.issues = inspected.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.nodeId ?? ''}: ${d.problem}`);
        c.renderDiagnostics = r.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.code}: ${d.problem}`);
        c.description = inspected.description.split('\n').slice(0, 3).join(' ');
        c.pixelHash = before[c.frame].hash;
        log(`frame ${c.frame} (${c.scene}): ${ids.length} Nodes, Szenen ${c.scenesVisible.join(', ')}, ${c.issues.length} Hinweise`);
        if (!c.scenesVisible.includes(`scene-${c.scene === 'three' ? '3d' : c.scene}`)) throw new Error(`frame.inspect: Szene ${c.scene} ist in Frame ${c.frame} nicht sichtbar.`);
      }
    });
    step('frame.render + frame.inspect', { checkpoints });

    // 6. Gezielter Patch: Titelfarbe im Intro
    const targeted = { op: 'setProperty', nodeId: 'intro-title', property: 'fill', value: '#FFD23F' };
    const patched = await timed('composition.patch (targeted)', () => patch(api, projectId, 'targeted', [targeted]));
    step('composition.patch (targeted)', { patch: targeted, inverse: patched.inverse });

    // 7. Erneut rendern: nur Frames im Intro dürfen sich ändern
    const rerender = [];
    await timed('frame.render (after patch)', async () => {
      for (const c of checkpoints) {
        const r = await api.call('frame.render', { projectId, frame: c.frame });
        const hash = sha(Buffer.from(r.image.base64, 'base64'));
        savePng(`after-${c.scene}-${c.frame}.png`, r.image.base64);
        const changed = hash !== before[c.frame].hash;
        const expected = c.scene === 'intro';
        rerender.push({ scene: c.scene, frame: c.frame, changed, expectedChange: expected, keyChanged: r.key !== before[c.frame].key, cached: r.cached });
        log(`frame ${c.frame} (${c.scene}): ${changed ? 'geändert' : 'unverändert'}${r.cached ? ' (Cache)' : ''}`);
      }
    });
    const wrong = rerender.filter((r) => r.changed !== r.expectedChange);
    if (wrong.length > 0) throw new Error(`Nach dem Patch änderten sich unerwartete Frames: ${JSON.stringify(wrong)}`);
    step('frame.render (after patch)', { frames: rerender, onlyAffectedChanged: true });

    const sheet = await api.call('preview.contactSheet', { projectId, frames: checkpoints.map((c) => c.frame), columns: 3, cellWidth: 640 });
    savePng('contact-sheet.png', sheet.image.base64);

    // 8. Ganzes Video rendern (Worker A: der Server selbst)
    const profile = { format: 'mp4', codec: 'h264' };
    const { result: resultA, jobs: jobsA } = await timed('video.render (A)', () => renderVideo(api, projectId, profile, 'video.render A'));
    const manifestA = JSON.parse((await api.file(projectId, 'out/dod.mp4.render-manifest.json')).toString('utf8'));
    const videoA = await api.file(projectId, 'out/dod.mp4');
    writeFileSync(join(outDir, 'dod-a.mp4'), videoA);
    step('video.render (A)', { workers: WORKERS_A, jobs: jobsA, frames: resultA.frames, warnings: resultA.warnings, output: { bytes: videoA.length, hash: sha(videoA) } });

    // 9. Reproduktion auf einem zweiten Worker: eigener Server, leerer Cache, 2 Worker-Prozesse.
    // Die IR wird nach dem gezielten Patch neu gelesen: B bekommt genau das Projekt, das A gerendert hat.
    const irFinal = JSON.parse((await api.file(projectId, info.entry)).toString('utf8'));
    b = await startServer('b', WORKERS_B);
    // Leeres Projekt anlegen, dieselben Assets importieren, dann dieselbe IR mit project.update setzen.
    // (project.create mit der IR scheitert, solange die Assets fehlen; mit Asset-Liste, aber ohne
    // Dateien bliebe die Render-Umgebung veraltet.)
    const created2 = await timed('project.create (B)', () => b.api.call('project.create', { name: `dod-${variant.name}-repro`, width: variant.width, height: variant.height, fps: variant.fps, duration: `${variant.seconds}s` }));
    const projectB = created2.projectId;
    await timed('asset.import (B)', () => importAssets(b.api, projectB, assetDir));
    const updated = await timed('project.update (B)', () => b.api.call('project.update', { projectId: projectB, project: irFinal }));
    if (!updated.ok) throw new Error(`project.update (B): ${updated.diagnostics.map((d) => `${d.code}: ${d.problem}`).join('; ')}`);
    const irB = JSON.parse((await b.api.file(projectB, (await b.api.call('project.inspect', { projectId: projectB })).entry)).toString('utf8'));
    const val2 = await b.api.call('composition.validate', { projectId: projectB });
    if (!val2.ok) throw new Error(`composition.validate (B): ${val2.text}`);
    const { result: resultB, jobs: jobsB } = await timed('video.render (B)', () => renderVideo(b.api, projectB, profile, 'video.render B'));
    const manifestB = JSON.parse((await b.api.file(projectB, 'out/dod.mp4.render-manifest.json')).toString('utf8'));
    const videoB = await b.api.file(projectB, 'out/dod.mp4');
    const hashesA = manifestA.frameHashes;
    const hashesB = manifestB.frameHashes;
    const differing = hashesA.map((h, i) => (h === hashesB[i] ? -1 : i)).filter((i) => i >= 0);
    const reproduction = {
      sameIr: canonical(irB) === canonical(irFinal),
      framesA: hashesA.length,
      framesB: hashesB.length,
      frameHashesEqual: hashesA.length === hashesB.length && differing.length === 0,
      differingFrames: differing.slice(0, 50),
      differingCount: differing.length,
      frameHashListA: sha(JSON.stringify(hashesA)),
      frameHashListB: sha(JSON.stringify(hashesB)),
      chunksA: manifestA.chunks.map((c) => ({ start: c.start, end: c.end, worker: c.worker ?? 'server' })),
      chunksB: manifestB.chunks.map((c) => ({ start: c.start, end: c.end, worker: c.worker ?? 'server' })),
      cacheB: manifestB.cache,
      videoHashA: sha(videoA),
      videoHashB: sha(videoB),
      videoBytesEqual: sha(videoA) === sha(videoB),
      manifestA: { compositionHash: manifestA.compositionHash, projectHash: manifestA.projectHash, renderBackend: manifestA.renderBackend, resolution: manifestA.resolution, fps: manifestA.fps, chromiumVersion: manifestA.chromiumVersion, threeVersion: manifestA.threeVersion, skiaVersion: manifestA.skiaVersion, ffmpegVersion: manifestA.ffmpegVersion, stages: manifestA.stages, audio: manifestA.audio },
      manifestB: { compositionHash: manifestB.compositionHash, projectHash: manifestB.projectHash, stages: manifestB.stages },
    };
    step('video.render (B, 2 worker processes)', { workers: WORKERS_B, jobs: jobsB, frames: resultB.frames });
    report.reproduction = reproduction;
    log(`Reproduktion: ${reproduction.frameHashesEqual ? 'alle' : 'NICHT alle'} ${hashesA.length} Frame-Hashes gleich; Video-Bytes ${reproduction.videoBytesEqual ? 'gleich' : 'verschieden'}`);
    if (!reproduction.frameHashesEqual) throw new Error(`Frame-Hashes verschieden in ${differing.length} Frames, z. B. ${differing.slice(0, 10).join(', ')}`);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    log(`FEHLER: ${report.error}`);
  } finally {
    report.timings = timings;
    report.totalSeconds = Math.round(performance.now() - t0) / 1000;
    await b?.close();
    await a.close();
    writeReport(report);
  }
  process.exitCode = report.ok ? 0 : 1;
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'dod-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const r = report.reproduction;
  const md = [
    `# Definition-of-Done-Bericht (${report.variant.name})`,
    '',
    `Ergebnis: **${report.ok ? 'bestanden' : 'nicht bestanden'}**${report.error ? ` – ${report.error}` : ''}`,
    '',
    `- Video: ${report.variant.width}×${report.variant.height}, ${report.variant.seconds} s, ${report.variant.fps} fps, Stimme ${report.variant.voiceProvider}`,
    `- Rechner: ${report.host.cpus} × ${report.host.cpuModel}, ${report.host.memoryGiB} GiB, Node ${report.host.node}, ${report.host.platform}, keine GPU`,
    `- Gesamtlaufzeit: ${report.totalSeconds} s`,
    '',
    '## Die 21 Bestandteile',
    '',
    '| # | Bestandteil | Fundstelle | Umsetzung |',
    '|---|---|---|---|',
    ...(report.components ?? []).map((c) => `| ${c.n} | ${c.name} | ${c.where.join('<br>')} | ${c.note} |`),
    '',
    '## Ablauf',
    '',
    '| Schritt | Operation | Laufzeit (s) |',
    '|---|---|---|',
    ...Object.entries(report.timings).map(([k, v], i) => `| ${i + 1} | ${k} | ${v} |`),
    '',
    ...(report.steps.find((s) => s.name === 'frame.render (after patch)')
      ? [
          '## Gezielte Änderung',
          '',
          'Patch: `setProperty intro-title.fill = #FFD23F`. Danach wurden dieselben Frames neu gerendert.',
          '',
          '| Szene | Frame | geändert | erwartet | aus Cache |',
          '|---|---|---|---|---|',
          ...report.steps.find((s) => s.name === 'frame.render (after patch)').frames.map((f) => `| ${f.scene} | ${f.frame} | ${f.changed ? 'ja' : 'nein'} | ${f.expectedChange ? 'ja' : 'nein'} | ${f.cached ? 'ja' : 'nein'} |`),
          '',
        ]
      : []),
    ...(r
      ? [
          '## Reproduktion auf einem zweiten Worker',
          '',
          'Server B hat einen eigenen, leeren Workspace und Cache und rendert mit 2 Worker-Prozessen. Er bekam dieselbe IR und dieselben Assets.',
          '',
          `- Frames: A ${r.framesA}, B ${r.framesB}`,
          `- Frame-Hashes gleich: **${r.frameHashesEqual ? 'ja' : `nein (${r.differingCount} verschieden)`}**`,
          `- Hash der Frame-Hash-Liste: A \`${r.frameHashListA}\`, B \`${r.frameHashListB}\``,
          `- Chunks A: ${r.chunksA.map((c) => `${c.start}–${c.end} (${c.worker})`).join(', ')}`,
          `- Chunks B: ${r.chunksB.map((c) => `${c.start}–${c.end} (${c.worker})`).join(', ')}`,
          `- Video-Datei byte-gleich: ${r.videoBytesEqual ? 'ja' : 'nein'} (A \`${r.videoHashA}\`, B \`${r.videoHashB}\`)`,
          `- Backends: ${r.manifestA.renderBackend.join(', ')}`,
          '',
        ]
      : []),
  ].join('\n');
  writeFileSync(join(reportDir, 'dod-report.md'), `${md}\n`);
  if (reportDir !== outDir) {
    for (const name of ['dod-report.json', 'dod-report.md']) copyFileSync(join(reportDir, name), join(outDir, name));
  }
  log(`Bericht: ${relative(repo, join(reportDir, 'dod-report.md'))}`);
}

await main();
