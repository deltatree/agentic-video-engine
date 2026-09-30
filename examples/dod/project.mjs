// Baut die Patches des Definition-of-Done-Videos (Auftrag Abschnitt 50).
// Alle Werte sind für 1920×1080 entworfen und werden mit `S` auf die Zielgröße skaliert.
// Zeiten sind Anteile der Gesamtdauer `D`, damit kurze (6 s) und volle (60 s) Variante
// dieselbe Struktur mit allen 21 Bestandteilen haben.

/** Szenen als Anteile der Gesamtdauer [Beginn, Ende]; Nachbarn überlappen für Übergänge. */
export const SCENES = {
  intro: [0.0, 0.15],
  motion: [0.14, 0.35],
  data: [0.34, 0.51],
  media: [0.5, 0.65],
  three: [0.64, 0.86],
  outro: [0.85, 1.0],
};

/** Voiceover-Zeilen je Szene (volle Variante) und eine kurze Zeile für `--short`. */
const LINES_FULL = {
  intro: 'This is OpenVideo. A coding agent built this whole film through the API.',
  motion: 'Motion graphics and a live HTML interface, animated frame by frame.',
  data: 'Charts grow straight from the data.',
  media: 'Photos and video clips sit right in the scene.',
  three: 'A real three D scene, with a camera move, lights, particles and bloom.',
  outro: 'Every frame is deterministic. Render it anywhere, get the same pixels.',
};
const LINES_SHORT = { intro: 'OpenVideo. Built by an agent.', three: 'Same pixels on every worker.' };

/**
 * Liefert die Bausteine des Projekts für eine Variante.
 * @param {{ width: number, height: number, fps: number, seconds: number, voiceProvider: string }} v
 */
export function buildPlan(v) {
  const S = v.width / 1920;
  const D = v.seconds;
  const fps = v.fps;
  const px = (n) => Math.round(n * S * 100) / 100;
  const f = (sec) => Math.round(sec * fps);
  const at = (fraction) => f(fraction * D);
  const td = Math.max(0.2, 0.01 * D); // Übergangsdauer in Sekunden
  const tdF = f(td);
  const win = (name) => {
    const [a, b] = SCENES[name];
    return { from: at(a), duration: at(b) - at(a) };
  };
  /** Zeit relativ zum Szenenbeginn als Anteil der Szenendauer → Frames. */
  const local = (name, fraction) => Math.round(win(name).duration * fraction);
  const W = v.width;
  const H = v.height;

  // ---------------------------------------------------------------- Intro
  const intro = {
    id: 'scene-intro',
    type: 'group',
    timing: win('intro'),
    transition: { out: { type: 'fade', duration: tdF } },
    children: [
      { id: 'intro-shader', type: 'shader', width: W, height: H, sksl: BG_SKSL, uniforms: { accent: [1.0, 0.35, 0.12] } },
      {
        id: 'intro-particles',
        type: 'particles',
        width: W,
        height: H,
        count: 260,
        seed: 7,
        emitter: { x: W / 2, y: px(430), radius: px(40), shape: 'circle' },
        lifetime: { min: 0.6 * Math.min(1, D / 20) + 0.4, max: 1.2 * Math.min(1, D / 20) + 0.6 },
        speed: { min: px(160), max: px(520) },
        size: { start: px(7), end: px(1) },
        color: { start: '#FFB347', end: '#FF5A1F' },
        shape: 'spark',
        blendMode: 'screen',
      },
      {
        id: 'intro-logo',
        type: 'svg',
        asset: 'logo',
        x: W / 2 - px(110),
        y: px(210),
        width: px(220),
        height: px(220),
        scale: { $spring: { from: { x: 0.2, y: 0.2 }, to: { x: 1, y: 1 }, at: 0, stiffness: 140, damping: 12 } },
        rotation: { $keyframes: [{ t: 0, v: -90 }, { t: local('intro', 0.35), v: 0, ease: 'easeOutBack' }] },
        shadow: { color: '#FF5A1F80', blur: px(30), offsetX: 0, offsetY: px(8) },
      },
      {
        id: 'intro-title',
        type: 'text',
        text: 'OpenVideo',
        fontFamily: 'Inter',
        fontSize: px(150),
        fontWeight: 800,
        letterSpacing: px(-4),
        fill: '#F5F7FF',
        x: px(120),
        y: px(470),
        width: W - px(240),
        textAlign: 'center',
        textAnimation: { unit: 'char', start: local('intro', 0.1), stagger: Math.max(1, local('intro', 0.04)), duration: local('intro', 0.3), ease: 'easeOutCubic', from: { opacity: 0, y: px(60), blur: px(10) } },
      },
      {
        id: 'intro-tagline',
        type: 'text',
        text: 'VIDEO AS CODE · MADE FOR AGENTS',
        fontFamily: 'Inter',
        fontSize: px(34),
        fontWeight: 500,
        letterSpacing: px(8),
        fontFeatures: { kern: 1, liga: 1 },
        fill: '#FFB347',
        x: px(120),
        y: px(670),
        width: W - px(240),
        textAlign: 'center',
        opacity: { $keyframes: [{ t: local('intro', 0.45), v: 0 }, { t: local('intro', 0.7), v: 1, ease: 'easeOutCubic' }] },
      },
    ],
  };

  // ---------------------------------------------------------------- Motion + HTML-UI
  const motion = {
    id: 'scene-motion',
    type: 'group',
    timing: win('motion'),
    transition: { in: { type: 'slide-left', duration: tdF, ease: 'easeOutCubic' }, out: { type: 'wipe-left', duration: tdF } },
    children: [
      heading('motion-heading', '2D Motion Graphics & HTML UI', px, W),
      {
        id: 'motion-wave',
        type: 'path',
        d: `M ${px(120)} ${px(620)} C ${px(260)} ${px(420)}, ${px(420)} ${px(820)}, ${px(560)} ${px(620)} S ${px(840)} ${px(420)}, ${px(980)} ${px(620)}`,
        stroke: { type: 'linear', stops: [{ offset: 0, color: '#22D3EE' }, { offset: 1, color: '#8B5CF6' }] },
        strokeWidth: px(14),
        strokeCap: 'round',
        trimEnd: { $keyframes: [{ t: 0, v: 0 }, { t: local('motion', 0.5), v: 1, ease: 'easeInOutCubic' }] },
      },
      {
        id: 'motion-hexagon',
        type: 'polygon',
        points: hexagon(px(0), px(0), px(90)),
        x: px(230),
        y: px(340),
        fill: '#FF5A1F',
        rotation: { $expr: 'time * 90' },
        scale: { $spring: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, at: local('motion', 0.1), stiffness: 170, damping: 14 } },
      },
      {
        id: 'motion-orbit',
        type: 'ellipse',
        width: px(56),
        height: px(56),
        fill: '#FFD23F',
        motionPath: { d: `M ${px(560)} ${px(360)} a ${px(160)} ${px(90)} 0 1 0 ${px(320)} 0 a ${px(160)} ${px(90)} 0 1 0 ${px(-320)} 0`, progress: { $keyframes: [{ t: 0, v: 0 }, { t: win('motion').duration, v: 1 }] } },
      },
      ...[0, 1, 2, 3].map((i) => ({
        id: `motion-bar-${i}`,
        type: 'rect',
        x: px(150 + i * 110),
        y: px(760),
        width: px(80),
        height: px(160),
        origin: { x: 0.5, y: 1 },
        cornerRadius: px(14),
        fill: ['#22D3EE', '#4F7CFF', '#8B5CF6', '#EC4899'][i],
        scale: { $spring: { from: { x: 1, y: 0 }, to: { x: 1, y: 0.4 + 0.2 * i }, at: local('motion', 0.15 + 0.07 * i), stiffness: 120, damping: 12 } },
      })),
      {
        id: 'ui-card',
        type: 'html',
        x: px(1100),
        y: px(250),
        width: px(700),
        height: px(620),
        html: UI_HTML,
        css: uiCss(S, win('motion').duration / fps),
        shadow: { color: '#00000099', blur: px(40), offsetX: 0, offsetY: px(20) },
      },
    ],
  };

  // ---------------------------------------------------------------- Daten
  const data = {
    id: 'scene-data',
    type: 'group',
    timing: win('data'),
    transition: { in: { type: 'iris', duration: tdF, ease: 'easeOutCubic' }, out: { type: 'fade', duration: tdF } },
    children: [
      heading('data-heading', 'Data Visualization', px, W),
      {
        id: 'data-bars',
        type: 'component',
        component: 'BarChart',
        x: px(120),
        y: px(250),
        props: {
          width: px(760),
          height: px(620),
          title: 'Frames rendered per minute',
          showValues: true,
          grid: true,
          duration: local('data', 0.4),
          data: [
            { label: 'Skia', value: 1840 },
            { label: 'Pixi', value: 1320 },
            { label: 'Three', value: 610 },
            { label: 'HTML', value: 420 },
          ],
        },
      },
      {
        id: 'data-line',
        type: 'component',
        component: 'LineChart',
        x: px(1000),
        y: px(250),
        props: {
          width: px(760),
          height: px(620),
          title: 'Cache hit ratio',
          area: true,
          grid: true,
          duration: local('data', 0.5),
          delay: local('data', 0.1),
          data: [
            { label: 'Mon', value: 42 },
            { label: 'Tue', value: 55 },
            { label: 'Wed', value: 61 },
            { label: 'Thu', value: 74 },
            { label: 'Fri', value: 88 },
          ],
        },
      },
    ],
  };

  // ---------------------------------------------------------------- Bild + Video
  const media = {
    id: 'scene-media',
    type: 'group',
    timing: win('media'),
    transition: { in: { type: 'zoom-in', duration: tdF, ease: 'easeOutCubic' }, out: { type: 'slide-up', duration: tdF } },
    children: [
      heading('media-heading', 'Images & Embedded Video', px, W),
      {
        id: 'media-photo',
        type: 'image',
        asset: 'photo',
        x: px(120),
        y: px(250),
        width: px(800),
        height: px(450),
        fit: 'cover',
        origin: { x: 0.5, y: 0.5 },
        scale: { $keyframes: [{ t: 0, v: { x: 1, y: 1 } }, { t: win('media').duration, v: { x: 1.12, y: 1.12 }, ease: 'easeInOutSine' }] },
        mask: { node: { id: 'media-photo-mask', type: 'rect', width: px(800), height: px(450), cornerRadius: px(28), fill: '#FFFFFF' } },
      },
      {
        id: 'media-video',
        type: 'video',
        asset: 'clip',
        x: px(1000),
        y: px(250),
        width: px(800),
        height: px(450),
        fit: 'cover',
        muted: true,
        loop: true,
        mask: { node: { id: 'media-video-mask', type: 'rect', width: px(800), height: px(450), cornerRadius: px(28), fill: '#FFFFFF' } },
        shadow: { color: '#000000AA', blur: px(30), offsetX: 0, offsetY: px(12) },
      },
      caption('media-photo-label', 'image · Ken Burns', px(120), px(730), px),
      caption('media-video-label', 'video · muted, looped', px(1000), px(730), px),
    ],
  };

  // ---------------------------------------------------------------- 3D
  const threeDur = win('three').duration;
  const three = {
    id: 'scene-3d',
    type: 'group',
    timing: win('three'),
    transition: { in: { type: 'fade', duration: tdF }, out: { type: 'blur', duration: tdF } },
    children: [
      {
        id: 'stage',
        type: 'scene3d',
        width: W,
        height: H,
        camera: 'cam',
        background: '#070A12',
        toneMapping: 'aces',
        shadows: true,
        environment: { preset: 'studio', intensity: 0.4 },
        postprocessing: { bloom: { strength: 0.9, radius: 0.5, threshold: 0.6 }, vignette: { offset: 1.0, darkness: 1.1 } },
        children: [
          {
            id: 'cam',
            type: 'camera3d',
            fov: 38,
            target: [0, 0.9, 0],
            position: { $keyframes: [{ t: 0, v: [7.5, 4.0, 10.0] }, { t: threeDur, v: [-5.0, 2.4, 7.0], ease: 'easeInOutCubic' }] },
          },
          { id: 'light-ambient', type: 'light3d', kind: 'ambient', intensity: 0.25 },
          { id: 'light-key', type: 'light3d', kind: 'directional', position: [4, 8, 5], intensity: 2.2, castShadow: true },
          { id: 'light-rim', type: 'light3d', kind: 'point', position: [-3, 2.5, -2.5], color: '#22D3EE', intensity: 25, distance: 12 },
          {
            id: 'floor',
            type: 'mesh3d',
            geometry: { type: 'cylinder', radiusTop: 2.2, radiusBottom: 2.3, height: 0.2, segments: 96 },
            position: [0, -0.1, 0],
            material: { color: '#161C2E', metalness: 0.2, roughness: 0.55 },
            receiveShadow: true,
          },
          {
            id: 'gem',
            type: 'model3d',
            asset: 'product',
            position: [0, 1.0, 0],
            scale: [0.75, 0.75, 0.75],
            animation: { clip: 'spin', loop: true },
            castShadow: true,
          },
          {
            id: 'sparks',
            type: 'particles3d',
            count: 700,
            seed: 11,
            position: [0, 1.1, 0],
            emitter: { shape: 'sphere', size: 0.9 },
            lifetime: { min: 1.0, max: 2.5 },
            speed: { min: 0.3, max: 1.0 },
            gravity: [0, 0.25, 0],
            size: { start: 0.09, end: 0.0 },
            color: { start: '#FFD23F', end: '#FF5A1F' },
            additive: true,
          },
        ],
      },
      heading('three-heading', 'Three.js · glTF · Camera · Light · Particles', px, W),
    ],
  };

  // ---------------------------------------------------------------- Outro
  const outro = {
    id: 'scene-outro',
    type: 'group',
    timing: win('outro'),
    transition: { in: { type: 'fade', duration: tdF }, out: { type: 'fade', duration: tdF } },
    children: [
      {
        id: 'outro-logo',
        type: 'svg',
        asset: 'logo',
        x: W / 2 - px(80),
        y: px(250),
        width: px(160),
        height: px(160),
        scale: { $spring: { from: { x: 0.6, y: 0.6 }, to: { x: 1, y: 1 }, at: 0, stiffness: 120, damping: 10 } },
      },
      {
        id: 'outro-title',
        type: 'text',
        text: 'Rendered by an agent.',
        fontFamily: 'Inter',
        fontSize: px(96),
        fontWeight: 700,
        letterSpacing: px(-2),
        fill: '#F5F7FF',
        x: px(120),
        y: px(450),
        width: W - px(240),
        textAlign: 'center',
        textAnimation: { unit: 'word', start: 0, stagger: Math.max(1, local('outro', 0.08)), duration: local('outro', 0.25), ease: 'easeOutCubic', from: { opacity: 0, y: px(40) } },
      },
      {
        id: 'outro-url',
        type: 'text',
        text: 'github.com/deltatree/agentic-video-engine',
        fontFamily: 'JetBrains Mono',
        fontSize: px(34),
        fill: '#8A93B2',
        x: px(120),
        y: px(600),
        width: W - px(240),
        textAlign: 'center',
        opacity: { $keyframes: [{ t: local('outro', 0.3), v: 0 }, { t: local('outro', 0.5), v: 1 }] },
      },
    ],
  };

  // ---------------------------------------------------------------- Hintergrund-Shader und Color Grading
  // Dauerhafter Hintergrund als einfacher Verlauf; der SkSL-Shader läuft nur im Intro,
  // weil ein bildfüllender Shader auf der CPU (CanvasKit) etwa 3 s je 1080p-Frame kostet.
  const background = {
    id: 'bg',
    type: 'rect',
    width: W,
    height: H,
    fill: { type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, stops: [{ offset: 0, color: '#090B13' }, { offset: 1, color: '#161029' }] },
  };
  const grade = {
    id: 'grade',
    type: 'layer',
    width: W,
    height: H,
    effects: [
      { type: 'color-grade', exposure: 0.05, contrast: 1.08, saturation: 1.12, temperature: 0.08, tint: 0.0 },
      { type: 'vignette', amount: 0.35, softness: 0.6 },
    ],
    children: [],
  };
  const captions = {
    id: 'captions',
    type: 'subtitles',
    track: 'subs',
    style: 'word-highlight',
    fontSize: px(40),
    fontWeight: 600,
    color: '#FFFFFF',
    highlightColor: '#FFD23F',
    position: 'bottom',
    maxWidth: px(1500),
    safeArea: 0.1,
    box: { color: '#000000B0', paddingX: px(18), paddingY: px(10), radius: px(12) },
  };

  // ---------------------------------------------------------------- Audio und Untertitel
  const lines = v.seconds >= 30 ? LINES_FULL : LINES_SHORT;
  const voiceSources = Object.entries(lines).map(([scene, text]) => ({ id: `vo-${scene}`, voice: { provider: v.voiceProvider, voice: 'en-us', text } }));
  const voiceClips = Object.keys(lines).map((scene) => ({ id: `vo-clip-${scene}`, source: `vo-${scene}`, start: win(scene).from + tdF }));
  const cues = Object.entries(lines).map(([scene, text]) => ({ start: win(scene).from + tdF, end: win(scene).from + win(scene).duration - tdF, text }));
  const transitions = ['motion', 'data', 'media', 'three', 'outro'];
  const audio = [{ id: 'song', asset: 'music' }, { id: 'whoosh-sfx', asset: 'whoosh' }, ...voiceSources];
  const tracks = [
    { id: 'voice', kind: 'audio', role: 'voiceover', clips: voiceClips, volume: 1.0 },
    { id: 'music-track', kind: 'audio', role: 'music', clips: [{ id: 'music-clip', source: 'song', start: 0, duration: f(D), volume: 0.5, fadeIn: tdF, fadeOut: f(Math.max(0.5, 0.03 * D)) }], ducking: { by: 'voice', amount: -10 } },
    { id: 'sfx', kind: 'audio', role: 'sfx', clips: transitions.map((scene) => ({ id: `whoosh-${scene}`, source: 'whoosh-sfx', start: Math.max(0, win(scene).from - Math.round(tdF / 2)), volume: 0.7 })) },
    { id: 'subs', kind: 'subtitle', language: 'en', cues },
  ];
  const markers = Object.keys(SCENES).map((name) => ({ id: `scene-${name}`, time: win(name).from, label: name }));

  return { background, grade, scenes: { intro, motion, data, media, three, outro }, captions, audio, tracks, markers, win, tdF };
}

function heading(id, text, px, W) {
  return {
    id,
    type: 'text',
    text,
    fontFamily: 'Inter',
    fontSize: px(64),
    fontWeight: 700,
    letterSpacing: px(-1),
    fill: '#F5F7FF',
    x: px(120),
    y: px(110),
    width: W - px(240),
    textAnimation: { unit: 'word', start: 0, stagger: 2, duration: 8, ease: 'easeOutCubic', from: { opacity: 0, x: px(-30) } },
  };
}

function caption(id, text, x, y, px) {
  return { id, type: 'text', text, fontFamily: 'JetBrains Mono', fontSize: px(26), fill: '#8A93B2', x, y };
}

function hexagon(cx, cy, r) {
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [Math.round((cx + r * Math.cos(a)) * 100) / 100, Math.round((cy + r * Math.sin(a)) * 100) / 100];
  });
}

/** SkSL-Hintergrund: weiche, wandernde Farbwellen (Shader-Bestandteil). */
const BG_SKSL = `uniform float time;
uniform float2 resolution;
uniform float3 accent;
half4 main(float2 coord) {
  float2 uv = coord / resolution;
  float w = 0.5 + 0.5 * sin(uv.x * 5.0 + time * 0.7 + sin(uv.y * 4.0 - time * 0.5) * 1.5);
  float g = smoothstep(1.2, 0.0, distance(uv, float2(0.5 + 0.2 * sin(time * 0.3), 0.45)));
  float3 base = mix(float3(0.035, 0.043, 0.075), float3(0.09, 0.06, 0.17), uv.y);
  float3 c = base + accent * 0.10 * w * g + float3(0.05, 0.12, 0.2) * (1.0 - w) * g * 0.5;
  return half4(half3(c), 1.0);
}`;

/**
 * HTML/CSS-UI: eine App-Karte mit Schaltern und Fortschrittsbalken, nur CSS-Animationen (keine Skripte).
 * Die Karte fährt ohne `scale` ein: Eine Skalierungs-Animation um weitere animierte Elemente liefert im
 * Browser-Renderer je nach vorher gerenderten Frames andere Pixel (Produktfehler, siehe Bericht).
 */
const UI_HTML = `<div class="card">
  <div class="bar"><span></span><span></span><span></span><b>render-queue.app</b></div>
  <h2>Render queue</h2>
  <div class="job"><p>intro.mp4</p><div class="track"><div class="fill f1"></div></div></div>
  <div class="job"><p>chart-scene.mp4</p><div class="track"><div class="fill f2"></div></div></div>
  <div class="job"><p>outro-4k.mov</p><div class="track"><div class="fill f3"></div></div></div>
  <div class="row"><span>Deterministic</span><div class="toggle t1"><i></i></div></div>
  <div class="row"><span>Second worker</span><div class="toggle t2"><i></i></div></div>
  <div class="badge">✓ frame hashes match</div>
</div>`;

function uiCss(S, seconds) {
  const p = (n) => `${Math.round(n * S * 100) / 100}px`;
  const d = (fraction) => `${(seconds * fraction).toFixed(3)}s`;
  return `
html, body { margin: 0; background: transparent; }
.card { box-sizing: border-box; width: 100%; height: 100%; padding: ${p(28)}; border-radius: ${p(28)};
  background: linear-gradient(160deg, #1B2238 0%, #111626 100%); border: ${p(2)} solid #2A3352;
  font-family: Inter, sans-serif; color: #F5F7FF; animation: pop ${d(0.15)} cubic-bezier(.2,.9,.3,1.2) both; }
.bar { display: flex; gap: ${p(8)}; align-items: center; margin-bottom: ${p(18)}; }
.bar span { width: ${p(14)}; height: ${p(14)}; border-radius: 50%; background: #FF5F57; }
.bar span:nth-child(2) { background: #FEBC2E; } .bar span:nth-child(3) { background: #28C840; }
.bar b { margin-left: ${p(12)}; font-weight: 500; font-size: ${p(18)}; color: #8A93B2; }
h2 { margin: 0 0 ${p(18)}; font-size: ${p(36)}; font-weight: 700; }
.job p { margin: ${p(10)} 0 ${p(6)}; font-size: ${p(20)}; color: #C9D1EA; font-family: 'JetBrains Mono', monospace; }
.track { height: ${p(14)}; border-radius: ${p(7)}; background: #242C45; overflow: hidden; }
.fill { height: 100%; border-radius: ${p(7)}; background: linear-gradient(90deg, #22D3EE, #8B5CF6); transform-origin: left; animation: grow ${d(0.5)} ease-out both; }
.f2 { animation-delay: ${d(0.1)}; } .f3 { animation-delay: ${d(0.2)}; background: linear-gradient(90deg, #FF5A1F, #FFB347); }
.row { display: flex; justify-content: space-between; align-items: center; margin-top: ${p(20)}; font-size: ${p(22)}; }
.toggle { width: ${p(64)}; height: ${p(34)}; border-radius: ${p(17)}; background: #2A3352; position: relative; animation: on ${d(0.08)} linear both; }
.toggle i { position: absolute; top: ${p(4)}; left: ${p(4)}; width: ${p(26)}; height: ${p(26)}; border-radius: 50%; background: #fff; animation: slide ${d(0.08)} ease-out both; }
.t1, .t1 i { animation-delay: ${d(0.45)}; } .t2, .t2 i { animation-delay: ${d(0.6)}; }
.badge { margin-top: ${p(24)}; display: inline-block; padding: ${p(10)} ${p(18)}; border-radius: ${p(999)}; background: #22C55E22; color: #4ADE80; font-weight: 600; font-size: ${p(22)}; animation: fadein ${d(0.1)} ease-out both; animation-delay: ${d(0.7)}; }
@keyframes pop { from { transform: translateY(${p(40)}); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes on { from { background: #2A3352; } to { background: #22C55E; } }
@keyframes slide { from { transform: translateX(0); } to { transform: translateX(${p(30)}); } }
@keyframes fadein { from { opacity: 0; transform: translateY(${p(10)}); } to { opacity: 1; transform: none; } }
`;
}

/**
 * Die 21 Bestandteile aus Abschnitt 50 mit ihrer Fundstelle im Projekt.
 * `where` ist ein Pfad, den der Test im gespeicherten Projekt nachprüft.
 */
export const COMPONENTS = [
  { name: 'animiertes Intro', where: [{ node: 'scene-intro' }, { node: 'intro-logo', prop: 'scale' }], note: 'Szene 0–15 %: Logo mit Feder-Animation, Titel Zeichen für Zeichen' },
  { name: 'professionelle Typografie', where: [{ node: 'intro-title', prop: 'textAnimation' }, { node: 'intro-tagline', prop: 'letterSpacing' }], note: 'Inter 800/500, Tracking, OpenType-Features, JetBrains Mono' },
  { name: 'SVG Logo', where: [{ node: 'intro-logo', prop: 'asset' }, { node: 'outro-logo' }], note: 'Asset logo (image/svg+xml)' },
  { name: '2D Motion Graphics', where: [{ node: 'motion-wave', prop: 'trimEnd' }, { node: 'motion-hexagon' }, { node: 'motion-orbit', prop: 'motionPath' }], note: 'Pfad mit Trim, Polygon mit Expression, Bewegungspfad, Federn' },
  { name: 'Datenvisualisierung', where: [{ node: 'data-bars', prop: 'component' }, { node: 'data-line' }], note: 'BarChart und LineChart' },
  { name: 'HTML/CSS UI Animation', where: [{ node: 'ui-card', prop: 'css' }], note: 'html-Node, CSS-@keyframes auf virtueller Zeit' },
  { name: 'Three.js 3D Szene', where: [{ node: 'stage' }], note: 'scene3d (Three.js, WebGL2/SwiftShader)' },
  { name: 'glTF Modell', where: [{ node: 'gem', prop: 'asset' }], note: 'model3d mit Clip "spin" aus product.glb' },
  { name: 'Kameraanimation', where: [{ node: 'cam', prop: 'position' }], note: 'camera3d mit Keyframes' },
  { name: 'Licht', where: [{ node: 'light-key' }, { node: 'light-rim' }, { node: 'light-ambient' }], note: 'directional, point, ambient' },
  { name: 'Partikel', where: [{ node: 'sparks' }, { node: 'intro-particles' }], note: 'particles3d und particles (2D)' },
  { name: 'Shader/Postprocessing', where: [{ node: 'intro-shader', prop: 'sksl' }, { node: 'stage', prop: 'postprocessing' }], note: 'SkSL-Hintergrund, Bloom und Vignette in 3D' },
  { name: 'eingebettetes Video', where: [{ node: 'media-video', prop: 'asset' }], note: 'video-Node mit clip.mp4' },
  { name: 'Bilder', where: [{ node: 'media-photo', prop: 'asset' }], note: 'image-Node mit photo.png, Ken-Burns-Zoom' },
  { name: 'Voiceover', where: [{ track: 'voice' }, { audio: 'vo-intro' }], note: 'Sprachsynthese (voice-Quelle) auf Spur voice' },
  { name: 'Musik', where: [{ track: 'music-track' }], note: 'music.wav mit Ducking unter der Stimme' },
  { name: 'Soundeffekte', where: [{ track: 'sfx' }], note: 'whoosh.wav an jedem Szenenwechsel' },
  { name: 'animierte Untertitel', where: [{ node: 'captions', prop: 'style' }, { track: 'subs' }], note: 'subtitles-Node, Stil word-highlight' },
  { name: 'Übergänge', where: [{ node: 'scene-motion', prop: 'transition' }, { node: 'scene-data', prop: 'transition' }], note: 'slide, wipe, iris, zoom, blur, fade' },
  { name: 'Color Grading', where: [{ node: 'grade', prop: 'effects' }], note: 'layer mit color-grade und vignette über allen Szenen' },
  { name: 'Outro', where: [{ node: 'scene-outro' }], note: 'Szene 85–100 % mit Logo, Titel, URL, Ausblendung' },
];
