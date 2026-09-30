#!/usr/bin/env node
// Erzeugt alle Assets des Definition-of-Done-Videos deterministisch und lizenzfrei:
// SVG-Logo, glTF-Modell mit Animations-Clip, Bild, Video, Musik, Soundeffekte.
// Aufruf: node examples/dod/generate-assets.mjs <zielordner>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'examples/dod/assets';
mkdirSync(out, { recursive: true });
const ffmpeg = process.env.OPENVIDEO_FFMPEG ?? 'ffmpeg';
const ff = (args) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args]);

// 1. SVG-Logo: stilisiertes Play-Symbol in einem Hexagon
writeFileSync(
  join(out, 'logo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF5A1F"/><stop offset="1" stop-color="#FFB347"/></linearGradient></defs>
  <path d="M100 10 L178 55 L178 145 L100 190 L22 145 L22 55 Z" fill="url(#g)"/>
  <path d="M82 65 L140 100 L82 135 Z" fill="#0B0D12"/>
</svg>
`,
);

// 2. glTF-Modell: Ikosaeder mit Normalen, PBR-Material und Rotations-Clip "spin"
const t = (1 + Math.sqrt(5)) / 2;
const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
});
const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
const positions = [];
const normals = [];
for (const f of faces) {
  const [a, b, c] = f.map((i) => verts[i]);
  const n = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  const l = Math.hypot(...n);
  for (const v of [a, b, c]) {
    positions.push(...v);
    normals.push(...n.map((x) => x / l));
  }
}
const times = [0, 2, 4];
const rot = [[0, 0, 0, 1], [0, Math.sin(Math.PI / 2), 0, Math.cos(Math.PI / 2)], [0, 0, 0, 1]].flatMap((q, i) => (i === 1 ? [0, 1, 0, 0] : q));
const f32 = (arr) => Buffer.from(new Float32Array(arr).buffer);
const chunks = [f32(positions), f32(normals), f32(times), f32(rot)];
const buffer = Buffer.concat(chunks);
const offsets = chunks.reduce((acc, c, i) => [...acc, (acc[i] ?? 0) + (i === 0 ? 0 : chunks[i - 1].length)], []);
const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k)));
const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k)));
const gltf = {
  asset: { version: '2.0', generator: 'OpenVideo DoD generator' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Gem', mesh: 0 }],
  meshes: [{ name: 'Gem', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
  materials: [{ name: 'Orange', pbrMetallicRoughness: { baseColorFactor: [1, 0.35, 0.12, 1], metallicFactor: 0.6, roughnessFactor: 0.25 } }],
  buffers: [{ byteLength: buffer.length }],
  bufferViews: chunks.map((c, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: c.length })),
  accessors: [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [4] },
    { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
  ],
  animations: [{ name: 'spin', channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }], samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }] }],
};
const json = Buffer.from(JSON.stringify(gltf));
const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const binPadded = Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, 0)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
const jh = Buffer.alloc(8);
jh.writeUInt32LE(jsonPadded.length, 0);
jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8);
bh.writeUInt32LE(binPadded.length, 0);
bh.writeUInt32LE(0x004e4942, 4);
writeFileSync(join(out, 'product.glb'), Buffer.concat([header, jh, jsonPadded, bh, binPadded]));

// 3. Bild (Fraktal), 4. Video (8 s, bewegtes Muster)
ff(['-f', 'lavfi', '-i', 'mandelbrot=s=1600x900:end_pts=1', '-frames:v', '1', join(out, 'photo.png')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-vf', 'hue=s=0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bitexact', join(out, 'clip.mp4')]);

// 5. Musik: Akkordfolge (C–Am–F–G) mit weicher Hüllkurve, 60 s, 48 kHz Stereo
const chords = [[261.63, 329.63, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63], [196.0, 246.94, 293.66]];
const expr = chords
  .map((c, i) => `between(mod(t,8),${i * 2},${i * 2 + 2})*(${c.map((f) => `sin(2*PI*${f}*t)`).join('+')})*0.12*(1-exp(-4*(mod(t,2))))*exp(-0.35*mod(t,2))`)
  .join('+');
ff(['-f', 'lavfi', '-i', `aevalsrc='${expr}|${expr}':s=48000:d=60`, '-c:a', 'pcm_s16le', join(out, 'music.wav')]);

// 6. Soundeffekt: Whoosh (gefiltertes Rauschen mit Hüllkurve)
ff(['-f', 'lavfi', '-i', 'anoisesrc=d=0.8:c=pink:r=48000:a=0.5:s=7', '-af', "highpass=f=400,lowpass=f=6000,volume='if(lt(t,0.3),t/0.3,max(0,1-(t-0.3)/0.5))':eval=frame", '-ac', '2', '-c:a', 'pcm_s16le', join(out, 'whoosh.wav')]);
console.log(`Assets geschrieben nach ${out}`);
