/**
 * Blend Mode `hue` für PixiJS (ADR 0018): PixiJS 8 liefert `saturation`, `color` und `luminosity`,
 * aber kein `hue`. Die Formel folgt W3C Compositing Level 1 (wie Skia):
 * `B(Cb, Cs) = SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))`.
 */
import { BlendModeFilter, ExtensionType, extensions } from 'pixi.js';

/** GLSL-Hilfsfunktionen für Lum/Sat (W3C Compositing, Abschnitt 5.9). */
const HSL_GL = `
float ovLum(vec3 c) { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
vec3 ovClipColor(vec3 c) {
  float l = ovLum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = vec3(l) + (c - vec3(l)) * l / (l - n);
  if (x > 1.0) c = vec3(l) + (c - vec3(l)) * (1.0 - l) / (x - l);
  return c;
}
vec3 ovSetLum(vec3 c, float l) { return ovClipColor(c + vec3(l - ovLum(c))); }
float ovSat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 ovSetSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) return vec3(0.0);
  return (c - vec3(mn)) * s / (mx - mn);
}
vec3 blendHue(vec3 base, vec3 blend, float opacity) {
  vec3 hue = ovSetLum(ovSetSat(blend, ovSat(base)), ovLum(base));
  return hue * opacity + base * (1.0 - opacity);
}
`;

/** Dieselben Funktionen in WGSL (für einen WebGPU-Renderer von PixiJS). */
const HSL_GPU = `
fn ovLum(c: vec3<f32>) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }
fn ovClipColor(cIn: vec3<f32>) -> vec3<f32> {
  var c = cIn;
  let l = ovLum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (n < 0.0) { c = vec3<f32>(l) + (c - vec3<f32>(l)) * l / (l - n); }
  if (x > 1.0) { c = vec3<f32>(l) + (c - vec3<f32>(l)) * (1.0 - l) / (x - l); }
  return c;
}
fn ovSetLum(c: vec3<f32>, l: f32) -> vec3<f32> { return ovClipColor(c + vec3<f32>(l - ovLum(c))); }
fn ovSat(c: vec3<f32>) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn ovSetSat(c: vec3<f32>, s: f32) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) { return vec3<f32>(0.0); }
  return (c - vec3<f32>(mn)) * s / (mx - mn);
}
fn blendHue(base: vec3<f32>, blend: vec3<f32>, opacity: f32) -> vec3<f32> {
  let hue = ovSetLum(ovSetSat(blend, ovSat(base)), ovLum(base));
  return hue * opacity + base * (1.0 - opacity);
}
`;

/**
 * PixiJS-Blend-Filter für `blendMode: 'hue'`. Wird beim Laden des Pakets als Erweiterung
 * registriert; danach nimmt jeder `Container` `blendMode = 'hue'` an.
 *
 * @example
 * ```ts
 * import '@agentic-video/renderer-pixi';
 * container.blendMode = 'hue'; // über isBlendMode-Guard im Renderer
 * ```
 */
export class HueBlend extends BlendModeFilter {
  /** Name, unter dem PixiJS den Filter als Blend Mode führt. */
  static readonly extension = { name: 'hue', type: ExtensionType.BlendMode } as const;

  constructor() {
    super({
      gl: {
        functions: HSL_GL,
        main: 'finalColor = vec4(blendHue(back.rgb, front.rgb, front.a), blendedAlpha) * uBlend;',
      },
      gpu: {
        functions: HSL_GPU,
        main: 'out = vec4<f32>(blendHue(back.rgb, front.rgb, front.a), blendedAlpha) * blendUniforms.uBlend;',
      },
    });
  }
}

let registered = false;

/**
 * Registriert {@link HueBlend} genau einmal bei PixiJS.
 *
 * @example
 * ```ts
 * registerHueBlend();
 * ```
 */
export function registerHueBlend(): void {
  if (registered) return;
  registered = true;
  extensions.add(HueBlend);
}
