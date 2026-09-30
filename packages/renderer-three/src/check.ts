/**
 * Vorab-Prüfung einer `scene3d`-Node (FR-44): meldet, was dieser Renderer nicht
 * oder nur mit einem bestimmten Backend darstellen kann.
 */
import { isRecord, type Diagnostic } from '@agentic-video/core';

/** Node-Typen, die als Kinder einer `scene3d` erlaubt sind. */
export const THREE_CHILD_TYPES: readonly string[] = ['camera3d', 'light3d', 'mesh3d', 'model3d', 'instances3d', 'particles3d', 'group3d'];

const ERROR_CLASS = 'ThreeRendererError';

interface Walk {
  readonly node: Readonly<Record<string, unknown>>;
  readonly pointer: string;
}

function idOf(node: Readonly<Record<string, unknown>>): string {
  return typeof node['id'] === 'string' ? node['id'] : '(unknown)';
}

function childrenOf(node: Readonly<Record<string, unknown>>, pointer: string): Walk[] {
  const children = node['children'];
  if (!Array.isArray(children)) return [];
  const out: Walk[] = [];
  children.forEach((child: unknown, i) => {
    if (isRecord(child)) out.push({ node: child, pointer: `${pointer}/children/${String(i)}` });
  });
  return out;
}

/** Alle Nachfahren einer Node in Tiefensuche (ohne die Node selbst). */
function descendants(node: Readonly<Record<string, unknown>>, pointer: string): Walk[] {
  const out: Walk[] = [];
  const visit = (w: Walk): void => {
    out.push(w);
    for (const c of childrenOf(w.node, w.pointer)) visit(c);
  };
  for (const c of childrenOf(node, pointer)) visit(c);
  return out;
}

/** Nutzt die Node ein GLSL-`ShaderMaterial`? */
export function usesShaderMaterial(node: Readonly<Record<string, unknown>>): boolean {
  const material = node['material'];
  return isRecord(material) && material['type'] === 'shader';
}

/**
 * Prüft, ob eine Szene Features nutzt, die nur unter WebGL2 laufen.
 * Heute ist das nur das GLSL-`ShaderMaterial`: der WebGPU-Renderer von Three.js
 * übersetzt kein GLSL.
 *
 * @example
 * ```ts
 * requiresWebGL2(sceneNode); // true, wenn ein Kind material.type 'shader' nutzt
 * ```
 */
export function requiresWebGL2(scene: Readonly<Record<string, unknown>>): boolean {
  return descendants(scene, '').some((w) => usesShaderMaterial(w.node));
}

/**
 * Welches Backend rendert eine `scene3d`-Node (Story 21.5)? Dieselbe Regel wie im
 * `ThreeLayerRenderer`: Node-Property `backend`, sonst `preferred`; `auto` nutzt WebGPU, außer die
 * Szene braucht WebGL2 (GLSL) oder WebGPU fehlt. `backend: 'webgpu'` bleibt `webgpu` (der Renderer
 * meldet GLSL dann als Fehler). Die Funktion ist rein; Render-Manifest und Cache-Schlüssel nutzen sie
 * mit dem geprüften WebGPU-Adapter der Render-Seite.
 *
 * @example
 * ```ts
 * threeBackendFor({ type: 'scene3d', children: [] }, true); // 'webgpu'
 * threeBackendFor({ type: 'scene3d', backend: 'webgl2', children: [] }, true); // 'webgl2'
 * ```
 */
export function threeBackendFor(scene: Readonly<Record<string, unknown>>, webgpuAvailable: boolean, preferred: 'auto' | 'webgpu' | 'webgl2' = 'auto'): 'webgpu' | 'webgl2' {
  const prop = scene['backend'];
  const wanted = prop === 'webgpu' || prop === 'webgl2' || prop === 'auto' ? prop : preferred;
  if (wanted !== 'auto') return wanted;
  if (requiresWebGL2(scene)) return 'webgl2';
  return webgpuAvailable ? 'webgpu' : 'webgl2';
}

/**
 * Prüft eine `scene3d`-Node vor dem Rendern.
 *
 * Gemeldete Einschränkungen:
 * - `OV_THREE_NODE_TYPE`: Die Node ist keine `scene3d`.
 * - `OV_THREE_UNSUPPORTED`: Ein Kind ist kein 3D-Node-Typ.
 * - `OV_THREE_CAMERA_UNKNOWN`: `camera` nennt keine vorhandene `camera3d`.
 * - `OV_THREE_BACKEND_FEATURE`: `backend: 'webgpu'` mit GLSL-`ShaderMaterial` (nur WebGL2).
 * - `OV_THREE_BACKEND_FALLBACK` (info): `backend: 'auto'` fällt wegen GLSL auf WebGL2 zurück.
 * - `OV_THREE_SHADER_MISSING`: `material.type: 'shader'` ohne `fragmentShader`.
 * - `OV_THREE_FOG_RANGE` (Warnung): `fog.far` ist nicht größer als `fog.near`.
 * - `OV_THREE_SHADOWS_OFF` (Warnung): `castShadow` gesetzt, aber `shadows` der Szene ist aus.
 * - `OV_THREE_ENVIRONMENT_CONFLICT` (info): `hdri` und `preset` gleichzeitig; `hdri` gewinnt.
 *
 * @example
 * ```ts
 * const diagnostics = checkThreeNode({ id: 'hero', type: 'scene3d', width: 640, height: 360, backend: 'webgpu', children: [] });
 * ```
 */
export function checkThreeNode(node: Readonly<Record<string, unknown>>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const sceneId = idOf(node);
  if (node['type'] !== 'scene3d') {
    out.push({
      code: 'OV_THREE_NODE_TYPE',
      severity: 'error',
      errorClass: ERROR_CLASS,
      problem: `The Three.js renderer renders only "scene3d" nodes, not "${String(node['type'])}".`,
      nodeId: sceneId,
      suggestions: ['Wrap the 3D nodes in a scene3d node.', 'Remove renderer: "three" from this node.'],
    });
    return out;
  }
  const all = descendants(node, '');
  const backend = typeof node['backend'] === 'string' ? node['backend'] : 'auto';

  for (const { node: child, pointer } of all) {
    const id = idOf(child);
    const type = String(child['type']);
    if (!THREE_CHILD_TYPES.includes(type)) {
      out.push({
        code: 'OV_THREE_UNSUPPORTED',
        severity: 'error',
        errorClass: ERROR_CLASS,
        problem: `Node type "${type}" cannot be a child of scene3d.`,
        nodeId: id,
        pointer,
        suggestions: [`Use one of: ${THREE_CHILD_TYPES.join(', ')}.`, 'Move 2D nodes outside of the scene3d node.'],
      });
    }
    const material = child['material'];
    if (usesShaderMaterial(child)) {
      if (isRecord(material) && typeof material['fragmentShader'] !== 'string') {
        out.push({
          code: 'OV_THREE_SHADER_MISSING',
          severity: 'error',
          errorClass: ERROR_CLASS,
          problem: 'material.type "shader" needs a GLSL fragmentShader.',
          nodeId: id,
          pointer: `${pointer}/material`,
          suggestions: ['fragmentShader: "varying vec2 vUv; uniform float time; void main() { gl_FragColor = vec4(vUv, 0.5 + 0.5 * sin(time), 1.0); }"'],
        });
      }
      if (backend === 'webgpu') {
        out.push({
          code: 'OV_THREE_BACKEND_FEATURE',
          severity: 'error',
          errorClass: ERROR_CLASS,
          problem: 'GLSL shader materials need the WebGL2 backend; the WebGPU backend cannot compile GLSL.',
          nodeId: id,
          pointer: `${pointer}/material`,
          details: { backend, feature: 'material.shader' },
          suggestions: ['Set backend: "webgl2" (or "auto") on the scene3d node.', 'Use material.type "standard", "physical" or "basic".'],
        });
      } else if (backend === 'auto') {
        out.push({
          code: 'OV_THREE_BACKEND_FALLBACK',
          severity: 'info',
          errorClass: ERROR_CLASS,
          problem: 'The scene uses a GLSL shader material, so "auto" renders it with WebGL2 instead of WebGPU.',
          nodeId: id,
          pointer: `${pointer}/material`,
          details: { backend, feature: 'material.shader' },
          suggestions: ['Set backend: "webgl2" to make the choice explicit.'],
        });
      }
    }
    if (child['castShadow'] === true && node['shadows'] !== true) {
      out.push({
        code: 'OV_THREE_SHADOWS_OFF',
        severity: 'warning',
        errorClass: ERROR_CLASS,
        problem: 'castShadow is set, but shadows are disabled on the scene.',
        nodeId: id,
        pointer: `${pointer}/castShadow`,
        suggestions: [`Set shadows: true on scene3d "${sceneId}".`],
      });
    }
  }

  const camera = node['camera'];
  if (typeof camera === 'string' && !all.some((w) => w.node['type'] === 'camera3d' && w.node['id'] === camera)) {
    const cameras = all.filter((w) => w.node['type'] === 'camera3d').map((w) => idOf(w.node));
    out.push({
      code: 'OV_THREE_CAMERA_UNKNOWN',
      severity: 'error',
      errorClass: ERROR_CLASS,
      problem: `Camera "${camera}" is not a camera3d child of this scene.`,
      nodeId: sceneId,
      pointer: '/camera',
      received: JSON.stringify(camera),
      suggestions: cameras.length > 0 ? [`Use one of: ${cameras.join(', ')}.`] : ['Add a camera3d child with this id.', 'Remove the camera property to use the default camera.'],
    });
  }

  const fog = node['fog'];
  if (isRecord(fog) && typeof fog['near'] === 'number' && typeof fog['far'] === 'number' && fog['far'] <= fog['near']) {
    out.push({
      code: 'OV_THREE_FOG_RANGE',
      severity: 'warning',
      errorClass: ERROR_CLASS,
      problem: 'fog.far must be greater than fog.near; the fog has no visible gradient.',
      nodeId: sceneId,
      pointer: '/fog',
      received: JSON.stringify({ near: fog['near'], far: fog['far'] }),
      suggestions: [`fog: { color: "${String(fog['color'])}", near: ${String(fog['near'])}, far: ${String(fog['near'] + 20)} }`],
    });
  }

  const env = node['environment'];
  if (isRecord(env) && env['hdri'] !== undefined && env['preset'] !== undefined) {
    out.push({
      code: 'OV_THREE_ENVIRONMENT_CONFLICT',
      severity: 'info',
      errorClass: ERROR_CLASS,
      problem: 'environment has both hdri and preset; the hdri is used.',
      nodeId: sceneId,
      pointer: '/environment',
      suggestions: ['Remove environment.preset.'],
    });
  }
  return out;
}
