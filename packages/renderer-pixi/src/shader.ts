/**
 * `shader`-Nodes mit GLSL für PixiJS (FR-31).
 *
 * Vertrag für `glsl` (GLSL ES 3.0, Shadertoy-Stil):
 * `void mainImage(out vec4 fragColor, in vec2 fragCoord)`. `fragCoord` ist die lokale
 * Pixelposition in der Box (Ursprung oben links, y nach unten, wie `coord` bei SkSL).
 * Die Farbe ist nicht vormultipliziert. Uniforms: `time` (Sekunden), `frame`, `resolution`
 * (Box in Pixeln) und jede Zahl aus `uniforms` (Zahl → `float`, 2–4 Zahlen → `vec2`–`vec4`).
 */
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { GlProgram, Mesh, MeshGeometry, Shader, UniformGroup } from 'pixi.js';

const VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vCoord;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  // aUV bleibt aktiv, damit PixiJS die Geometrie ohne Warnung zuordnet; x · 0 ändert nichts.
  vCoord = aPosition + aUV * vec2(0.0, 0.0);
}
`;

type UniformType = 'f32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>';
const GLSL_TYPES: Readonly<Record<UniformType, string>> = { f32: 'float', 'vec2<f32>': 'vec2', 'vec3<f32>': 'vec3', 'vec4<f32>': 'vec4' };
const BY_LENGTH: readonly UniformType[] = ['f32', 'f32', 'vec2<f32>', 'vec3<f32>', 'vec4<f32>'];
const RESERVED = new Set(['time', 'frame', 'resolution']);

/** Uniform-Beschreibung für PixiJS. */
interface UniformEntry {
  readonly value: number | Float32Array;
  readonly type: UniformType;
}

/**
 * Baut die Uniforms eines Shaders: eigene Werte plus `time`, `frame`, `resolution`.
 * Listen mit mehr als 4 Zahlen werden übersprungen (`checkPixiNode` meldet sie).
 */
export function shaderUniforms(custom: unknown, time: number, frame: number, width: number, height: number): Record<string, UniformEntry> {
  const out: Record<string, UniformEntry> = {};
  if (isRecord(custom)) {
    for (const [name, v] of Object.entries(custom)) {
      if (RESERVED.has(name)) continue;
      if (typeof v === 'number') out[name] = { value: v, type: 'f32' };
      else if (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x): x is number => typeof x === 'number')) {
        const type = BY_LENGTH[v.length] ?? 'f32';
        out[name] = { value: v.length === 1 ? (v[0] ?? 0) : new Float32Array(v), type };
      }
    }
  }
  out['time'] = { value: time, type: 'f32' };
  out['frame'] = { value: frame, type: 'f32' };
  out['resolution'] = { value: new Float32Array([width, height]), type: 'vec2<f32>' };
  return out;
}

/** Fragment-Shader um den Nutzer-Code. Die Ausgabe wird vormultipliziert. */
export function fragmentSource(glsl: string, uniforms: Readonly<Record<string, UniformEntry>>): string {
  const decls = Object.entries(uniforms)
    .map(([name, u]) => `uniform ${GLSL_TYPES[u.type]} ${name};`)
    .join('\n');
  return `#version 300 es
precision highp float;
in vec2 vCoord;
out vec4 finalColor;
${decls}
${glsl}
void main() {
  vec4 c = vec4(0.0);
  mainImage(c, vCoord);
  finalColor = vec4(c.rgb * c.a, c.a);
}
`;
}

/**
 * Baut ein Mesh, das die Box `width × height` mit dem Shader füllt.
 *
 * @example
 * ```ts
 * const mesh = createShaderMesh('void mainImage(out vec4 c, in vec2 p) { c = vec4(p / resolution, 0.0, 1.0); }', {}, 1.5, 45, 320, 180, 'bg');
 * ```
 */
export function createShaderMesh(glsl: string, custom: unknown, time: number, frame: number, width: number, height: number, nodeId: string): Mesh<MeshGeometry, Shader> {
  const uniforms = shaderUniforms(custom, time, frame, width, height);
  let glProgram: GlProgram;
  try {
    glProgram = GlProgram.from({ vertex: VERTEX, fragment: fragmentSource(glsl, uniforms), name: `ov-shader-${nodeId}` });
  } catch (error) {
    throw new OpenVideoError({
      code: 'OV_PIXI_SHADER',
      errorClass: 'PixiRendererError',
      problem: 'The GLSL shader could not be prepared.',
      nodeId,
      cause: error,
      suggestions: ['Define void mainImage(out vec4 fragColor, in vec2 fragCoord).'],
    });
  }
  const geometry = new MeshGeometry({
    positions: new Float32Array([0, 0, width, 0, width, height, 0, height]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const shader = new Shader({ glProgram, resources: { ovUniforms: new UniformGroup(uniforms) } });
  return new Mesh({ geometry, shader });
}
