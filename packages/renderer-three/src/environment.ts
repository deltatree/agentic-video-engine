/**
 * Umgebungen für Reflexionen und Hintergrund (FR-40): Presets und HDRI.
 */
import { BackSide, BufferAttribute, Mesh, MeshBasicMaterial, Scene, SphereGeometry, Color, SRGBColorSpace, type Object3D } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Name eines eingebauten Umgebungs-Presets. */
export type EnvironmentPreset = 'studio' | 'neutral' | 'sunset';

/** Farbverlauf einer prozeduralen Umgebung: oben, Horizont, unten (sRGB). */
const GRADIENTS: Readonly<Record<'neutral' | 'sunset', readonly [string, string, string]>> = {
  neutral: ['#D9D9D9', '#A6A6A6', '#595959'],
  sunset: ['#1B2A5E', '#FF8A3D', '#2A1A14'],
};

function gradientScene(colors: readonly [string, string, string]): Scene {
  const scene = new Scene();
  const geometry = new SphereGeometry(10, 64, 32);
  const pos = geometry.getAttribute('position');
  const data = new Float32Array(pos.count * 3);
  const top = new Color().setStyle(colors[0], SRGBColorSpace);
  const horizon = new Color().setStyle(colors[1], SRGBColorSpace);
  const bottom = new Color().setStyle(colors[2], SRGBColorSpace);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) c.copy(horizon).lerp(top, Math.pow(y, 0.6));
    else c.copy(horizon).lerp(bottom, Math.pow(-y, 0.6));
    data[i * 3] = c.r;
    data[i * 3 + 1] = c.g;
    data[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new BufferAttribute(data, 3));
  scene.add(new Mesh(geometry, new MeshBasicMaterial({ side: BackSide, vertexColors: true })));
  return scene;
}

/**
 * Baut die Szene eines Umgebungs-Presets, die ein PMREM-Generator zur Umgebungstextur macht.
 * - `studio`: `RoomEnvironment` von Three.js (Softboxen in einem Raum).
 * - `neutral`: grauer Verlauf von hell (oben) nach dunkel (unten).
 * - `sunset`: Verlauf Nachtblau → Orange am Horizont → dunkler Boden.
 *
 * @example
 * ```ts
 * const envScene = presetScene('sunset');
 * ```
 */
export function presetScene(preset: EnvironmentPreset): Scene {
  if (preset === 'studio') return new RoomEnvironment();
  return gradientScene(GRADIENTS[preset]);
}

/** Type Guard für Meshes mit Standard-Typparametern. */
export function isMesh(o: Object3D): o is Mesh {
  return o instanceof Mesh;
}

/** Gibt Geometrien und Materialien einer Preset-Szene frei. */
export function disposeScene(scene: Scene): void {
  scene.traverse((o) => {
    if (isMesh(o)) {
      o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of materials) m.dispose();
    }
  });
}
