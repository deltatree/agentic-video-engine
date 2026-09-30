#!/usr/bin/env node
// Lizenzinventar (FR-88, NFR-6, Story 22.6): erzeugt licenses.json, THIRD_PARTY_NOTICES.md und eine
// CycloneDX-SBOM (sbom.cdx.json) für alle Laufzeit-Abhängigkeiten und für den Inhalt jedes
// Container-Images (FFmpeg, Chromium, Blender …, Versionen aus deploy/docker/Dockerfile).
//
// Aufruf: node scripts/licenses.mjs           schreibt die drei Dateien neu
//         node scripts/licenses.mjs --check   schreibt nichts; Exit-Code 1, wenn eine Laufzeit-
//                                             Abhängigkeit keine erlaubte Lizenz hat oder eine der
//                                             drei Dateien nicht dem erzeugten Stand entspricht
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Dateien des Inventars (relativ zur Wurzel). */
export const INVENTORY_FILES = ['licenses.json', 'THIRD_PARTY_NOTICES.md', 'sbom.cdx.json'];

/** OSI-anerkannte Lizenzen, die als Laufzeit-Abhängigkeit erlaubt sind. */
export const ALLOWED = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'BlueOak-1.0.0', 'MPL-2.0', 'Zlib', 'Python-2.0', 'Unicode-3.0', 'CC0-1.0', 'Unlicense']);

/** Wertet einfache SPDX-Ausdrücke aus: OR = eine erlaubte genügt, AND = alle nötig. */
export function allowed(expr) {
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (clean.includes(' OR ')) return clean.split(' OR ').some((p) => allowed(p.trim()));
  if (clean.includes(' AND ')) return clean.split(' AND ').every((p) => allowed(p.trim()));
  return ALLOWED.has(clean);
}

/** Laufzeit-Abhängigkeiten aus package-lock.json und node_modules. */
function npmEntries(root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const entries = [];
  const problems = [];
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (path === '' || meta.dev === true || meta.link === true || !path.includes('node_modules/')) continue;
    const dir = join(root, path);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license : typeof pkg.license?.type === 'string' ? pkg.license.type : Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : meta.license ?? 'UNKNOWN';
    const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = licenseFile !== undefined ? readFileSync(join(dir, licenseFile), 'utf8') : '';
    const name = pkg.name ?? path.split('node_modules/').pop();
    if (!allowed(license)) problems.push(`${name}@${pkg.version}: ${license}`);
    entries.push({ name, version: pkg.version, license, repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '', path, licenseText: text });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
  return { entries, problems };
}

/** Standardwerte der `ARG`-Zeilen eines Dockerfiles (erster Wert gewinnt). */
function dockerArgs(root) {
  const file = join(root, 'deploy', 'docker', 'Dockerfile');
  if (!existsSync(file)) return undefined;
  const args = {};
  for (const m of readFileSync(file, 'utf8').matchAll(/^ARG\s+([A-Z0-9_]+)=(\S+)/gmu)) if (!(m[1] in args)) args[m[1]] = m[2];
  return args;
}

/**
 * Inhalt je Container-Image (deploy/docker/Dockerfile, Ziele base … worker und local). Versionen kommen aus
 * den ARG-Werten; ändert sich das Dockerfile, ist das Inventar veraltet (`--check`).
 */
export function imageInventory(root = ROOT) {
  const a = dockerArgs(root);
  if (a === undefined) return [];
  const debian = `Debian 13 (trixie), apt snapshot ${a.DEBIAN_SNAPSHOT}`;
  const src = (url) => `Corresponding source: ${url}`;
  const base = [
    { name: 'Node.js', version: `22 (${a.NODE_IMAGE})`, license: 'MIT AND others (OpenSSL Apache-2.0, ICU Unicode-3.0, …)', bundled: true, note: 'Base image node:22-trixie-slim; notices in /usr/local/share/doc/node and the Node.js LICENSE file.' },
    { name: 'Debian base system', version: debian, license: 'Various (GPL-2.0-or-later, LGPL-2.1-or-later, MIT, BSD, …)', bundled: true, note: `Per-package notices in /usr/share/doc/*/copyright. ${src('https://snapshot.debian.org/')}` },
    { name: 'tini', version: a.TINI_VERSION, license: 'MIT', bundled: true, note: 'Init process (Debian package).' },
    { name: 'fontconfig', version: a.FONTCONFIG_VERSION, license: 'HPND-sell-variant', bundled: true, note: 'Debian package.' },
    { name: 'DejaVu fonts (fonts-dejavu-core)', version: 'Debian package', license: 'Bitstream-Vera AND LicenseRef-DejaVu-public-domain', bundled: true, note: 'Fallback system font.' },
    { name: 'ca-certificates', version: 'Debian package', license: 'MPL-2.0 AND GPL-2.0-or-later', bundled: true, note: 'CA bundle (MPL-2.0 data, GPL-2.0-or-later scripts).' },
    { name: 'OpenVideo and npm dependencies', version: 'see "npm dependencies"', license: 'Apache-2.0 and the licenses listed below', bundled: true, note: 'dist/ of all packages plus production node_modules.' },
  ];
  const renderCpu = [
    ...base,
    { name: 'FFmpeg', version: a.FFMPEG_VERSION, license: 'GPL-2.0-or-later', bundled: true, note: `Debian package, built with --enable-gpl (libx264, libx265); the render manifest records the license reported by the binary; notices in /usr/share/doc/ffmpeg/copyright. ${src('https://snapshot.debian.org/package/ffmpeg/')}` },
    { name: 'Chromium (Chrome for Testing)', version: `${a.CHROMIUM_VERSION} (revision ${a.CHROMIUM_REVISION})`, license: 'BSD-3-Clause AND others (LGPL-2.1, MPL-2.0, Apache-2.0, … of bundled third-party code)', bundled: true, note: `Archives verified by SHA-256 (${a.CHROMIUM_SHA256}); full notices via chrome://credits in the bundled browser. ${src('https://chromium.googlesource.com/chromium/src')}` },
    { name: 'Chromium system libraries', version: debian, license: 'Various (LGPL-2.1-or-later, MIT, BSD, …)', bundled: true, note: 'Installed by `playwright install-deps chromium` from the same Debian snapshot.' },
  ];
  return [
    { image: 'openvideo-base', target: 'base', contents: base },
    { image: 'openvideo-render-cpu', target: 'render-cpu', contents: renderCpu },
    {
      image: 'openvideo-render-gpu',
      target: 'render-gpu',
      contents: [...renderCpu, { name: 'NVIDIA driver libraries (libnvidia-encode, CUDA)', version: 'host driver', license: 'LicenseRef-NVIDIA-proprietary', bundled: false, note: 'Not in the image: injected at runtime by the NVIDIA Container Toolkit from the host driver.' }],
    },
    {
      image: 'openvideo-blender',
      target: 'blender',
      contents: [
        ...renderCpu,
        { name: 'Blender', version: a.BLENDER_VERSION, license: 'GPL-3.0-or-later', bundled: true, note: `Official binary release in /opt/blender (SHA-256 ${a.BLENDER_SHA256}); runs as a separate process, OpenVideo does not link it. Licenses of Blender and its libraries in /opt/blender/copyright.txt and /opt/blender/license/. ${src(`https://download.blender.org/source/blender-${a.BLENDER_VERSION}.tar.xz`)}` },
        { name: 'Mesa and X11 client libraries', version: debian, license: 'MIT AND others', bundled: true, note: 'EGL/GL runtime for Blender (Debian packages).' },
      ],
    },
    { image: 'openvideo-studio', target: 'studio', contents: [...base, { name: 'OpenVideo Studio bundle', version: 'apps/studio/dist', license: 'Apache-2.0 AND MIT (React, Monaco Editor)', bundled: true, note: 'Pre-built browser bundle.' }] },
    { image: 'openvideo-worker', target: 'worker', contents: renderCpu },
    {
      image: 'openvideo-local',
      target: 'local',
      contents: [
        ...renderCpu,
        { name: 'OpenVideo Studio bundle', version: 'apps/studio/dist', license: 'Apache-2.0 AND MIT (React, Monaco Editor)', bundled: true, note: 'Pre-built browser bundle.' },
        { name: 'Blender', version: a.BLENDER_VERSION, license: 'GPL-3.0-or-later', bundled: false, note: 'Only with `npm run setup -- --with-blender` (target blender as base, ARG LOCAL_BASE); then as in openvideo-blender. Built locally, never published (ADR 0029).' },
      ],
    },
  ];
}

/** Gebündelte Nicht-Code-Inhalte der npm-Pakete. */
const BUNDLED_ASSETS = [
  { name: 'Inter', version: '4.1', license: 'OFL-1.1', path: 'packages/fonts/assets/inter' },
  { name: 'JetBrains Mono', version: '2.304', license: 'OFL-1.1', path: 'packages/fonts/assets/jetbrains-mono' },
  { name: 'Noto Color Emoji', version: '2026-09-24', license: 'OFL-1.1', path: 'packages/fonts/assets/noto-color-emoji' },
  { name: 'CanvasKit (Skia)', version: '0.42.0', license: 'BSD-3-Clause', path: 'node_modules/canvaskit-wasm' },
];

/** Externe Werkzeuge aus Sicht der npm-Pakete (in Images siehe `images`). */
const EXTERNAL_TOOLS = [
  { name: 'FFmpeg', license: 'LGPL-2.1-or-later or GPL-2.0-or-later (depends on build)', note: 'External process, not in the npm packages. Bundled (GPL-2.0-or-later build) in the render-cpu, render-gpu, blender and worker images. The render manifest records the exact build license and codec licenses.' },
  { name: 'Chromium (via Playwright)', license: 'BSD-3-Clause and others', note: 'Downloaded by Playwright, not in the npm packages. Bundled in the render-cpu, render-gpu, blender and worker images.' },
  { name: 'Blender', license: 'GPL-3.0-or-later', note: 'Optional external process for blender nodes, not in the npm packages and never linked. Bundled only in the openvideo-blender image (GPL-3.0-or-later binary, source offer in the image inventory).' },
  { name: 'Piper, espeak-ng, whisper.cpp', license: 'MIT / GPL-3.0-or-later / MIT', note: 'Optional external speech engines; not bundled in the npm packages or images.' },
];

/**
 * Erzeugt Inhalt und Prüfergebnis des Inventars, ohne zu schreiben.
 *
 * @returns {{ files: Record<string, string>, problems: string[], count: number }}
 */
export function buildInventory(root = ROOT) {
  const { entries, problems } = npmEntries(root);
  const images = imageInventory(root);
  const files = {};
  files['licenses.json'] = JSON.stringify({ generated: 'scripts/licenses.mjs', policy: [...ALLOWED], dependencies: entries.map(({ licenseText: _t, ...e }) => e), bundledAssets: BUNDLED_ASSETS, externalTools: EXTERNAL_TOOLS, images }, null, 2) + '\n';
  const notices = ['# Third-Party Notices', '', 'OpenVideo (Apache-2.0) uses the following third-party software at runtime.', 'Generated by `node scripts/licenses.mjs`. Do not edit by hand; `node scripts/licenses.mjs --check` fails when this file is out of date.', ''];
  notices.push('## Bundled assets', '', ...BUNDLED_ASSETS.map((x) => `- ${x.name} ${x.version} – ${x.license} (${x.path})`), '');
  notices.push('## External tools (not in the npm packages)', '', ...EXTERNAL_TOOLS.map((t) => `- ${t.name} – ${t.license}. ${t.note}`), '');
  if (images.length > 0) {
    notices.push('## Container images', '', 'Contents of the official images built from `deploy/docker/Dockerfile` (one target per image).', '');
    for (const img of images) {
      notices.push(`### ${img.image} (target \`${img.target}\`)`, '');
      for (const c of img.contents) notices.push(`- ${c.name} ${c.version} – ${c.license}${c.bundled ? '' : ' (not bundled)'}. ${c.note}`);
      notices.push('');
    }
  }
  notices.push('## npm dependencies', '');
  for (const e of entries) {
    notices.push(`### ${e.name} ${e.version}`, '', `License: ${e.license}${e.repository ? `  \nSource: ${e.repository}` : ''}`, '');
    if (e.licenseText.trim() !== '') notices.push('```text', e.licenseText.trim(), '```', '');
  }
  files['THIRD_PARTY_NOTICES.md'] = notices.join('\n');
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Inhalte der Images als Komponenten; gleiche Komponenten in mehreren Images einmal, mit Liste der Images.
  const imageComponents = new Map();
  for (const img of images) {
    for (const c of img.contents) {
      if (!c.bundled || c.name.startsWith('OpenVideo')) continue;
      const key = `${c.name}@${c.version}`;
      const hit = imageComponents.get(key) ?? { type: 'application', name: c.name, version: c.version, licenses: [{ expression: c.license }], properties: [{ name: 'openvideo:images', value: '' }] };
      hit.properties[0].value = [...hit.properties[0].value.split(', ').filter((v) => v !== ''), img.image].join(', ');
      imageComponents.set(key, hit);
    }
  }
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${createHash('sha256').update(JSON.stringify(entries.map((e) => [e.name, e.version]))).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5')}`,
    version: 1,
    metadata: { component: { type: 'application', name: rootPkg.name, version: rootPkg.version, licenses: [{ license: { id: 'Apache-2.0' } }] } },
    components: [...entries.map((e) => ({ type: 'library', name: e.name, version: e.version, purl: `pkg:npm/${e.name.replace('@', '%40')}@${e.version}`, licenses: [{ expression: e.license }] })), ...imageComponents.values()],
  };
  files['sbom.cdx.json'] = JSON.stringify(sbom, null, 2) + '\n';
  return { files, problems, count: entries.length };
}

/**
 * Welche Inventar-Dateien unter `root` weichen vom erzeugten Stand ab (oder fehlen)?
 *
 * @returns {string[]}
 */
export function staleFiles(root, files) {
  return Object.entries(files)
    .filter(([name, text]) => !existsSync(join(root, name)) || readFileSync(join(root, name), 'utf8') !== text)
    .map(([name]) => name);
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const { files, problems, count } = buildInventory(ROOT);
  if (problems.length > 0) {
    console.error('Nicht erlaubte Lizenzen in Laufzeit-Abhängigkeiten:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  if (checkOnly) {
    const stale = staleFiles(ROOT, files);
    if (stale.length > 0) {
      console.error(`Lizenzinventar veraltet: ${stale.join(', ')} entspricht nicht package-lock.json, node_modules und deploy/docker/Dockerfile.\nNeu erzeugen mit: node scripts/licenses.mjs (und die Dateien mit einchecken).`);
      process.exit(1);
    }
  } else {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(ROOT, name), text);
  }
  console.log(`Lizenzprüfung bestanden: ${count} Laufzeit-Pakete, alle mit erlaubter Lizenz${checkOnly ? '; Inventar aktuell' : '; Inventar geschrieben'}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
