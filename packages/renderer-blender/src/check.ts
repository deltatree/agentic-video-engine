/**
 * Vorab-Prüfung einer `blender`-Node (FR-44): meldet vor dem Render, was Blender nicht
 * oder nur genähert darstellt.
 */
import { isRecord, type Diagnostic } from '@agentic-video/core';

/** Node-Typen, die als Kinder einer `blender`-Node übertragen werden. */
export const BLENDER_CHILD_TYPES: readonly string[] = ['camera3d', 'light3d', 'mesh3d', 'model3d', 'instances3d', 'particles3d', 'group3d'];

/** Höchstzahl an Instanzen je `instances3d` bzw. Partikeln je `particles3d`, die als Einzelobjekte in Blender entstehen. */
export const MAX_BLENDER_INSTANCES = 10_000;

const ERROR_CLASS = 'BlenderRendererError';
const USE_THREE = 'Render this part with a scene3d node (Three.js) instead of blender.';

interface Walk {
  readonly node: Readonly<Record<string, unknown>>;
  readonly pointer: string;
}

function idOf(node: Readonly<Record<string, unknown>>): string {
  return typeof node['id'] === 'string' ? node['id'] : '(unknown)';
}

function descendants(node: Readonly<Record<string, unknown>>): Walk[] {
  const out: Walk[] = [];
  const visit = (n: Readonly<Record<string, unknown>>, pointer: string): void => {
    const children = n['children'];
    if (!Array.isArray(children)) return;
    children.forEach((child: unknown, i) => {
      if (!isRecord(child)) return;
      const p = `${pointer}/children/${String(i)}`;
      out.push({ node: child, pointer: p });
      visit(child, p);
    });
  };
  visit(node, '');
  return out;
}

function unsupported(problem: string, nodeId: string, pointer: string, suggestions: readonly string[]): Diagnostic {
  return { code: 'OV_BLENDER_UNSUPPORTED', severity: 'error', errorClass: ERROR_CLASS, problem, nodeId, pointer, suggestions };
}

function info(code: string, problem: string, nodeId: string, pointer: string, suggestions: readonly string[], severity: 'info' | 'warning' = 'info'): Diagnostic {
  return { code, severity, errorClass: ERROR_CLASS, problem, nodeId, pointer, suggestions };
}

/**
 * Prüft eine `blender`-Node vor dem Render.
 *
 * Fehler (Render bricht ab):
 * - `OV_BLENDER_NODE_TYPE`: Die Node ist keine `blender`-Node.
 * - `OV_BLENDER_UNSUPPORTED`: `instances3d` bzw. `particles3d` mit mehr als 10 000 Instanzen/Partikeln,
 *   GLSL-Shader-Material (`material.type: 'shader'`), `postprocessing`, 2D-Kinder.
 * - `OV_BLENDER_CAMERA_UNKNOWN`: `camera` nennt keine `camera3d` der Szene.
 * - `OV_BLENDER_MASK_OBJECT`: `pass: 'object-mask'` ohne gültiges `maskObject`.
 *
 * Warnungen und Hinweise:
 * - `OV_BLENDER_IGNORED` (Warnung): `filters`, `shadow` oder `toneMapping` wirken nicht.
 * - `OV_BLENDER_APPROXIMATED` (Hinweis): `ambient`/`hemisphere`-Licht und `environment.preset`
 *   werden über das Weltlicht genähert.
 *
 * @example
 * ```ts
 * const diagnostics = checkBlenderNode({ id: 'hero', type: 'blender', width: 640, height: 360, children: [] });
 * ```
 */
export function checkBlenderNode(node: Readonly<Record<string, unknown>>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const sceneId = idOf(node);
  if (node['type'] !== 'blender') {
    out.push({
      code: 'OV_BLENDER_NODE_TYPE',
      severity: 'error',
      errorClass: ERROR_CLASS,
      problem: `The Blender renderer renders only "blender" nodes, not "${String(node['type'])}".`,
      nodeId: sceneId,
      suggestions: ['Wrap the 3D nodes in a blender node.', 'Remove renderer: "blender" from this node.'],
    });
    return out;
  }
  const all = descendants(node);
  for (const { node: child, pointer } of all) {
    const id = idOf(child);
    const type = String(child['type']);
    if (type === 'instances3d' || type === 'particles3d') {
      const count = typeof child['count'] === 'number' ? child['count'] : 0;
      const what = type === 'instances3d' ? 'instances' : 'particles';
      if (count > MAX_BLENDER_INSTANCES) {
        out.push(
          unsupported(`${type} with ${String(count)} ${what} exceeds the Blender limit of ${String(MAX_BLENDER_INSTANCES)}.`, id, `${pointer}/count`, [
            USE_THREE,
            `Reduce count to ${String(MAX_BLENDER_INSTANCES)} or less.`,
          ]),
        );
      }
    } else if (!BLENDER_CHILD_TYPES.includes(type)) {
      out.push(unsupported(`Node type "${type}" cannot be a child of a blender node.`, id, pointer, [`Use one of: ${BLENDER_CHILD_TYPES.join(', ')}.`, 'Move 2D nodes outside of the blender node.']));
    }
    const material = child['material'];
    if (isRecord(material) && material['type'] === 'shader') {
      out.push(unsupported('GLSL shader materials cannot be transferred to Blender.', id, `${pointer}/material`, [USE_THREE, 'Use material.type "standard" or "physical".']));
    }
    if (type === 'light3d' && (child['kind'] === 'ambient' || child['kind'] === 'hemisphere')) {
      out.push(
        info('OV_BLENDER_APPROXIMATED', `The ${child['kind']} light is approximated by world lighting in Blender.`, id, pointer, [
          'Use a directional, point or spot light for exact lighting.',
        ]),
      );
    }
  }

  if (node['postprocessing'] !== undefined) {
    out.push(unsupported('postprocessing is not available in the Blender renderer.', sceneId, '/postprocessing', [USE_THREE, 'Use layer effects (effects on a layer node) for bloom-like looks.']));
  }
  for (const key of ['filters', 'shadow'] as const) {
    if (node[key] !== undefined) {
      out.push(info('OV_BLENDER_IGNORED', `${key} on a blender node has no effect.`, sceneId, `/${key}`, [`Remove ${key}, or wrap the blender node in a layer and use layer effects.`], 'warning'));
    }
  }
  const toneMapping = node['toneMapping'];
  if (toneMapping !== undefined && toneMapping !== 'none') {
    out.push(info('OV_BLENDER_IGNORED', 'toneMapping has no effect; Blender output uses the "Standard" view transform.', sceneId, '/toneMapping', ['Remove toneMapping.', 'Use a color-grade layer effect.'], 'warning'));
  }
  const env = node['environment'];
  if (isRecord(env) && typeof env['preset'] === 'string' && env['hdri'] === undefined) {
    out.push(info('OV_BLENDER_APPROXIMATED', `environment.preset "${env['preset']}" is approximated by a sky gradient in Blender.`, sceneId, '/environment/preset', ['Use environment.hdri with an HDRI asset for image-based lighting.']));
  }

  const camera = node['camera'];
  const cameras = all.filter((w) => w.node['type'] === 'camera3d').map((w) => idOf(w.node));
  if (typeof camera === 'string' && !cameras.includes(camera)) {
    out.push({
      code: 'OV_BLENDER_CAMERA_UNKNOWN',
      severity: 'error',
      errorClass: ERROR_CLASS,
      problem: `Camera "${camera}" is not a camera3d child of this blender node.`,
      nodeId: sceneId,
      pointer: '/camera',
      received: JSON.stringify(camera),
      suggestions: cameras.length > 0 ? [`Use one of: ${cameras.join(', ')}.`] : ['Add a camera3d child with this id.', 'Remove the camera property to use the default camera.'],
    });
  }

  if (node['pass'] === 'object-mask') {
    const mask = node['maskObject'];
    const candidates = all.filter((w) => ['mesh3d', 'model3d', 'instances3d', 'particles3d', 'group3d'].includes(String(w.node['type']))).map((w) => idOf(w.node));
    if (typeof mask !== 'string' || !candidates.includes(mask)) {
      out.push({
        code: 'OV_BLENDER_MASK_OBJECT',
        severity: 'error',
        errorClass: ERROR_CLASS,
        problem: typeof mask === 'string' ? `maskObject "${mask}" is not a mesh3d, model3d, instances3d, particles3d or group3d child.` : 'pass "object-mask" needs maskObject.',
        nodeId: sceneId,
        pointer: '/maskObject',
        suggestions: candidates.length > 0 ? [`maskObject: "${candidates[0] ?? ''}"`] : ['Add a mesh3d child and name it in maskObject.'],
      });
    }
  }
  return out;
}
