/**
 * 3D Product Showcase: ein prozedural gebautes Produkt (Lautsprecher aus Grundkörpern)
 * dreht sich auf einem Podest, die Kamera fährt heran, Merkmale erscheinen daneben. 10 s, 1920×1080.
 *
 * Das Modell besteht nur aus eingebauten Geometrien (Zylinder, Torus, Kugel) – keine Modelldatei nötig.
 * Eigenes Modell: `<Model src="./assets/product.glb" />` statt `Product` einsetzen.
 *
 * Anpassen:
 * - Name und Merkmale in `COPY` ändern.
 * - Materialfarben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import {
  AmbientLight,
  Camera3D,
  Cylinder,
  DirectionalLight,
  Group,
  Group3D,
  PointLight,
  Rect,
  Scene,
  Sphere,
  Text,
  ThreeScene,
  Torus,
  animate,
  component,
  composition,
  keyframes,
  project,
  ref,
} from '@agentic-video/sdk';

const Badge = component('Badge');

const W = 1920;
const H = 1080;

const COPY = {
  eyebrow: 'NEW',
  name: 'Aura Speaker',
  tagline: '360° sound in a 12 cm cylinder.',
  features: ['Room-filling 360° audio', '20 h battery life', 'Recycled aluminium shell'],
} as const;

/** Das Produkt: Korpus, Stoffband, Deckel mit Leuchtring und Bedienknopf. */
const Product = (
  <Group3D id="product" position={[0, 0, 0]}>
    <Cylinder id="product-body" radiusTop={0.62} radiusBottom={0.66} height={1.9} segments={96} position={[0, 0.95, 0]} material={{ color: ref('theme.colors.surface'), metalness: 0.6, roughness: 0.35 }} castShadow />
    <Cylinder id="product-fabric" radiusTop={0.665} radiusBottom={0.68} height={1.2} segments={96} position={[0, 0.72, 0]} material={{ color: ref('theme.colors.primary'), metalness: 0, roughness: 1 }} castShadow />
    <Torus id="product-ring" radius={0.5} tube={0.035} position={[0, 1.905, 0]} rotationX={90} material={{ color: ref('theme.colors.accent'), emissive: ref('theme.colors.accent'), emissiveIntensity: 2.2 }} />
    <Sphere id="product-button" radius={0.12} segments={48} position={[0, 1.9, 0]} scale={[1, 0.35, 1]} material={{ color: ref('theme.colors.text'), metalness: 0.2, roughness: 0.3 }} />
  </Group3D>
);

export default project({
  metadata: { title: '3D Product Showcase', description: 'Procedural product on a turntable with feature call-outs.', tags: ['3d', 'product'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '10s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          <ThreeScene id="stage" camera="camera" background={ref('theme.colors.background')} shadows toneMapping="aces" environment={{ preset: 'studio', intensity: 0.35 }}>
            <Camera3D
              id="camera"
              fov={32}
              target={[-1.3, 1.0, 0.6]}
              position={keyframes([
                { t: 0, v: [4.4, 2.6, 7.6] },
                { t: '10s', v: [3.3, 2.1, 6.4], ease: 'easeInOutSine' },
              ])}
            />
            <AmbientLight id="ambient" intensity={0.35} />
            <DirectionalLight id="key" position={[4, 7, 5]} intensity={1.8} castShadow />
            <PointLight id="rim" position={[-3, 3, -3]} intensity={18} color={ref('theme.colors.secondary')} />
            {/* Drehteller: Podest und Produkt drehen sich einmal in 10 s. */}
            <Group3D id="turntable" rotation={animate([0, 0, 0], [0, 300, 0], { duration: '10s', ease: 'linear' })}>
              <Cylinder id="plinth" radiusTop={1.4} radiusBottom={1.5} height={0.18} segments={96} position={[0, -0.09, 0]} material={{ color: ref('theme.colors.surface'), metalness: 0.1, roughness: 0.6 }} receiveShadow />
              {Product}
            </Group3D>
          </ThreeScene>
          {/* Text links neben dem Produkt. */}
          <Group id="copy" x={140} y={300} timing={{ from: '0.6s' }} transition={{ in: { type: 'slide-right', duration: '0.6s', ease: 'easeOutCubic' } }}>
            <Badge id="copy-eyebrow" label={COPY.eyebrow} variant="accent" exit="none" />
            <Text id="copy-name" text={COPY.name} y={60} fontSize={112} fontWeight={800} letterSpacing={-3} fill={ref('theme.colors.text')} />
            <Text id="copy-tagline" text={COPY.tagline} y={200} fontSize={36} fill={ref('theme.colors.muted')} />
          </Group>
          {COPY.features.map((f, i) => (
            <Group id={`feature-${String(i + 1)}`} key={f} x={140} y={620 + i * 76} timing={{ from: `${String(2.6 + i * 0.6)}s` }} transition={{ in: { type: 'slide-right', duration: '0.45s', ease: 'easeOutCubic' } }}>
              <Rect id={`feature-${String(i + 1)}-dot`} y={14} width={16} height={16} cornerRadius={8} fill={ref('theme.colors.accent')} />
              <Text id={`feature-${String(i + 1)}-text`} text={f} x={40} fontSize={36} fontWeight={500} fill={ref('theme.colors.text')} />
            </Group>
          ))}
        </Scene>
      ),
    }),
  ],
});
