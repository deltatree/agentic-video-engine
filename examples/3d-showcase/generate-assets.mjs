#!/usr/bin/env node
// Erzeugt das 3D-Modell des Beispiels deterministisch, ohne Abhängigkeiten (nur Node.js):
//   assets/gem.glb – facettierter Edelstein (Doppelpyramide mit 8 Seiten), PBR-Material,
//                    Animations-Clip "bob" (Auf und Ab über 2 s)
// Das Modell ist ein eigener, synthetischer Inhalt und steht unter CC0-1.0.
// Aufruf: node generate-assets.mjs  (schreibt nach ./assets neben diesem Skript)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'assets');
mkdirSync(out, { recursive: true });

// Geometrie: Ring aus 8 Punkten (Gürtel), Spitze oben (Krone), Spitze unten (Pavillon), flach schattiert.
const SIDES = 8;
const ring = Array.from({ length: SIDES }, (_, i) => {
  const a = (i / SIDES) * Math.PI * 2;
  return [Math.cos(a), 0.15, Math.sin(a)];
});
const top = [0, 0.75, 0];
const bottom = [0, -1.1, 0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
};
const positions = [];
const normals = [];
const triangle = (a, b, c) => {
  const n = norm(cross(sub(b, a), sub(c, a)));
  for (const v of [a, b, c]) {
    positions.push(...v);
    normals.push(...n);
  }
};
for (let i = 0; i < SIDES; i++) {
  const a = ring[i];
  const b = ring[(i + 1) % SIDES];
  triangle(top, b, a);
  triangle(bottom, a, b);
}

// Animation "bob": Translation y 0 → 0.15 → 0 über 2 s.
const times = [0, 1, 2];
const translations = [0, 0, 0, 0, 0.15, 0, 0, 0, 0];

const f32 = (arr) => Buffer.from(new Float32Array(arr).buffer);
const chunks = [f32(positions), f32(normals), f32(times), f32(translations)];
const offsets = [];
let offset = 0;
for (const c of chunks) {
  offsets.push(offset);
  offset += c.length;
}
const bin = Buffer.concat(chunks);
const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k)));
const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k)));
const gltf = {
  asset: { version: '2.0', generator: 'OpenVideo examples/3d-showcase' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Gem', mesh: 0 }],
  meshes: [{ name: 'Gem', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
  materials: [{ name: 'Sapphire', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.45, 1, 1], metallicFactor: 0.3, roughnessFactor: 0.15 }, emissiveFactor: [0.02, 0.05, 0.15] }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: chunks.map((c, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: c.length })),
  accessors: [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: times.length, type: 'SCALAR', min: [0], max: [2] },
    { bufferView: 3, componentType: 5126, count: times.length, type: 'VEC3' },
  ],
  animations: [{ name: 'bob', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }] }],
};

// GLB-Container: Kopf, JSON-Chunk (mit Leerzeichen aufgefüllt), BIN-Chunk (mit Nullen aufgefüllt).
const pad = (buf, byte) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, byte)]);
const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
const data = pad(bin, 0);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + data.length, 8);
const chunkHeader = (length, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(length, 0);
  h.writeUInt32LE(type, 4);
  return h;
};
writeFileSync(join(out, 'gem.glb'), Buffer.concat([header, chunkHeader(json.length, 0x4e4f534a), json, chunkHeader(data.length, 0x004e4942), data]));
console.log(`Assets written to ${out}`);
