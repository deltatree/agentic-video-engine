/**
 * Element-Komponenten für alle Node-Typen. Jede Komponente liefert nur Daten
 * (`{ type, props }`); die Übersetzung in die IR macht `toIR`.
 *
 * Aliase (klein und dokumentiert, siehe README):
 * - `font` → `fontFamily` (Text, RichText, Subtitles, SubtitleTrack)
 * - `rotationX`, `rotationY`, `rotationZ` → `rotation` als Vektor in Grad (3D-Nodes)
 * - `src` bei Medien → Asset (automatisch deklariert, ID aus Dateiname, Typ aus Endung)
 * - `Circle radius` → Ellipse mit `width = height = 2 · radius`
 * - `RoundedRect radius` → `cornerRadius`
 * - `ThreeScene`/`BlenderScene` ohne Maße füllen die Composition.
 */
import type { AudioClip as IrAudioClip, AudioTrack as IrAudioTrack, BuiltinNodeType, Marker as IrMarker, NodeOf, SubtitleCue } from '@agentic-video/core';
import { createElement, type Child, type ElementFactory, type SdkElement } from './element.js';

/** Props, die jede Element-Komponente kennt. */
export interface BaseElementProps {
  readonly id?: string;
  readonly key?: string | number;
  readonly children?: Child;
}

/** Maske mit einem Element statt einer IR-Node. */
export interface ElementMask {
  readonly node: SdkElement;
  readonly mode?: 'alpha' | 'luminance';
  readonly invert?: boolean;
}

/** Props einer Node-Art: Felder der IR ohne `type`, `id`, `children`, `mask`; `O` wird optional. */
export type NodeProps<K extends BuiltinNodeType, O extends string = never> = Omit<NodeOf<K>, 'type' | 'id' | 'children' | 'mask' | O> &
  Partial<Pick<NodeOf<K>, Extract<keyof NodeOf<K>, O>>> &
  BaseElementProps & { readonly mask?: ElementMask };

/** Medien-Props: `asset` oder `src`. */
export type MediaProps<K extends BuiltinNodeType> = NodeProps<K, 'asset'> & { readonly src?: string };

/** 3D-Rotation je Achse in Grad (Alias für `rotation`). */
export interface Rotation3DProps {
  readonly rotationX?: number;
  readonly rotationY?: number;
  readonly rotationZ?: number;
}

/** Props mit Schrift-Alias `font`. */
export interface FontAliasProps {
  readonly font?: string;
}

function builtin<P extends object>(name: string): ElementFactory<P> {
  return (props: P) => createElement(name, props);
}

/** Fragment: gruppiert Kinder ohne eigene Node. @example <><Rect … /><Text … /></> */
export const Fragment: ElementFactory<{ readonly children?: Child }> = builtin('Fragment');

/**
 * Wurzel einer Szene. `background` setzt die Hintergrundfarbe der Composition.
 *
 * @example
 * ```tsx
 * <Scene background="#080A10"><Text text="Hi" /></Scene>
 * ```
 */
export const Scene: ElementFactory<{ readonly background?: string; readonly children?: Child }> = builtin('Scene');

/** Gruppe. @example <Group x={100}><Rect width={10} height={10} /></Group> */
export const Group: ElementFactory<NodeProps<'group'>> = builtin('Group');
/** Eigener Compositor-Layer. @example <Layer effects={[{ type: 'blur', radius: 4 }]}>…</Layer> */
export const Layer: ElementFactory<NodeProps<'layer'>> = builtin('Layer');
/** Rechteck. @example <Rect width={200} height={100} fill="#FF0000" /> */
export const Rect: ElementFactory<NodeProps<'rect'>> = builtin('Rect');
/** Rechteck mit Radius (`radius` → `cornerRadius`). @example <RoundedRect width={200} height={100} radius={16} /> */
export const RoundedRect: ElementFactory<NodeProps<'rect'> & { readonly radius?: number }> = builtin('RoundedRect');
/** Kreis (`radius` → Ellipse mit Breite und Höhe `2 · radius`; `x`/`y` ist die linke obere Ecke). @example <Circle radius={40} fill="#FFF" /> */
export const Circle: ElementFactory<Omit<NodeProps<'ellipse'>, 'width' | 'height'> & { readonly radius: number }> = builtin('Circle');
/** Ellipse. @example <Ellipse width={80} height={40} /> */
export const Ellipse: ElementFactory<NodeProps<'ellipse'>> = builtin('Ellipse');
/** Linie. @example <Line from={{ x: 0, y: 0 }} to={{ x: 100, y: 0 }} stroke="#FFF" /> */
export const Line: ElementFactory<NodeProps<'line'>> = builtin('Line');
/** Offene Linie. @example <Polyline points={[{ x: 0, y: 0 }, { x: 10, y: 10 }]} /> */
export const Polyline: ElementFactory<NodeProps<'polyline'>> = builtin('Polyline');
/** Polygon. @example <Polygon points={[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }]} /> */
export const Polygon: ElementFactory<NodeProps<'polygon'>> = builtin('Polygon');
/** SVG-Pfad. @example <Path d="M0 0 L10 10" stroke="#FFF" /> */
export const Path: ElementFactory<NodeProps<'path'>> = builtin('Path');
/** Text (`font` → `fontFamily`). @example <Text text="Hello" font="Inter" fontSize={64} /> */
export const Text: ElementFactory<NodeProps<'text'> & FontAliasProps> = builtin('Text');
/** Text mit Spans. @example <RichText spans={[{ text: 'Hi ', fontWeight: 700 }, { text: 'there' }]} /> */
export const RichText: ElementFactory<NodeProps<'rich-text'> & FontAliasProps> = builtin('RichText');
/** Bild (`src` → Asset). @example <Image src="./assets/logo.png" width={200} height={200} /> */
export const Image: ElementFactory<MediaProps<'image'>> = builtin('Image');
/** Video (`src` → Asset). @example <Video src="./assets/clip.mp4" width={1920} height={1080} /> */
export const Video: ElementFactory<MediaProps<'video'>> = builtin('Video');
/** Sprite aus einem Raster. @example <Sprite src="./assets/run.png" columns={8} rows={1} /> */
export const Sprite: ElementFactory<MediaProps<'sprite'>> = builtin('Sprite');
/** Alias von {@link Sprite}. @example <SpriteSheet src="./assets/run.png" columns={8} rows={1} /> */
export const SpriteSheet: ElementFactory<MediaProps<'sprite'>> = builtin('SpriteSheet');
/** Lottie-Animation. @example <Lottie src="./assets/intro.json" width={400} height={400} /> */
export const Lottie: ElementFactory<MediaProps<'lottie'>> = builtin('Lottie');
/** SVG aus Datei oder Markup. @example <Svg markup="<svg …/>" width={100} height={100} /> */
export const Svg: ElementFactory<MediaProps<'svg'>> = builtin('Svg');
/** Shader. @example <Shader width={100} height={100} sksl="half4 main(float2 p) { return half4(1); }" /> */
export const Shader: ElementFactory<NodeProps<'shader'>> = builtin('Shader');
/** 2D-Partikel. @example <Particles width={1920} height={1080} count={200} /> */
export const Particles: ElementFactory<NodeProps<'particles'>> = builtin('Particles');
/** HTML-Inhalt. @example <Html width={800} height={200} html="<h1>Hi</h1>" /> */
export const Html: ElementFactory<NodeProps<'html'>> = builtin('Html');
/** Untertitel aus einer bestehenden Spur. @example <Subtitles track="voice" style="karaoke" /> */
export const Subtitles: ElementFactory<NodeProps<'subtitles'> & FontAliasProps> = builtin('Subtitles');

/** Props von {@link SubtitleTrack}: Spurquelle plus Darstellung der `subtitles`-Node. */
export type SubtitleTrackProps = NodeProps<'subtitles', 'track'> &
  FontAliasProps & {
    readonly src?: string;
    readonly cues?: readonly SubtitleCue[];
    readonly language?: string;
    readonly fromAudio?: { readonly source: string; readonly provider: string };
  };

/**
 * Untertitel aus einer Datei: `src` → Asset + Subtitle-Track + `subtitles`-Node.
 *
 * @example
 * ```tsx
 * <SubtitleTrack src="./audio/voiceover.srt" style="word-highlight" />
 * ```
 */
export const SubtitleTrack: ElementFactory<SubtitleTrackProps> = builtin('SubtitleTrack');

/** Verschachtelte Composition. @example <CompositionRef composition="intro" /> */
export const CompositionRef: ElementFactory<NodeProps<'composition-ref'>> = builtin('CompositionRef');
/** Generische Komponente der Bibliothek. @example <Component component="LowerThird" props={{ title: 'Ada' }} /> */
export const Component: ElementFactory<NodeProps<'component'>> = builtin('Component');

/**
 * Fabrik für eine benannte Komponente. Node-Felder (id, x, timing …) bleiben an der Node,
 * alle anderen Props gehen nach `props`.
 *
 * @example
 * ```tsx
 * const LowerThird = component('LowerThird');
 * <LowerThird id="lt" title="Ada Lovelace" x={100} />
 * ```
 */
export function component(name: string): ElementFactory<Omit<NodeProps<'component'>, 'component'> & Readonly<Record<string, unknown>>> {
  return (props) => createElement('Component', { ...props, component: name });
}

/** Three.js-Szene (→ `scene3d`). @example <ThreeScene camera="cam"><Box /></ThreeScene> */
export const ThreeScene: ElementFactory<NodeProps<'scene3d', 'width' | 'height'>> = builtin('ThreeScene');
/** Blender-Szene (→ `blender`). @example <BlenderScene engine="cycles">…</BlenderScene> */
export const BlenderScene: ElementFactory<NodeProps<'blender', 'width' | 'height'>> = builtin('BlenderScene');

type Props3D<K extends BuiltinNodeType, O extends string = never> = NodeProps<K, O> & Rotation3DProps;

/** Kamera. @example <Camera3D id="cam" position={[0, 1, 5]} /> */
export const Camera3D: ElementFactory<Props3D<'camera3d'>> = builtin('Camera3D');
/** Umgebungslicht. @example <AmbientLight intensity={0.3} /> */
export const AmbientLight: ElementFactory<Omit<Props3D<'light3d'>, 'kind'>> = builtin('AmbientLight');
/** Richtungslicht. @example <DirectionalLight position={[5, 8, 3]} intensity={3} /> */
export const DirectionalLight: ElementFactory<Omit<Props3D<'light3d'>, 'kind'>> = builtin('DirectionalLight');
/** Punktlicht. @example <PointLight position={[0, 2, 0]} /> */
export const PointLight: ElementFactory<Omit<Props3D<'light3d'>, 'kind'>> = builtin('PointLight');
/** Spotlicht. @example <SpotLight position={[0, 5, 0]} angle={30} /> */
export const SpotLight: ElementFactory<Omit<Props3D<'light3d'>, 'kind'>> = builtin('SpotLight');
/** Himmelslicht. @example <HemisphereLight color="#FFFFFF" groundColor="#333333" /> */
export const HemisphereLight: ElementFactory<Omit<Props3D<'light3d'>, 'kind'>> = builtin('HemisphereLight');
/** Mesh mit eigener Geometrie. @example <Mesh geometry={{ type: 'box' }} /> */
export const Mesh: ElementFactory<Props3D<'mesh3d'>> = builtin('Mesh');

type PrimitiveProps<G extends string> = Omit<Props3D<'mesh3d'>, 'geometry'> & { readonly [K in G]?: number };

/** Quader. @example <Box width={1} height={1} depth={1} /> */
export const Box: ElementFactory<PrimitiveProps<'width' | 'height' | 'depth'>> = builtin('Box');
/** Kugel. @example <Sphere radius={0.5} /> */
export const Sphere: ElementFactory<PrimitiveProps<'radius' | 'segments'>> = builtin('Sphere');
/** Ebene. @example <Plane width={4} height={4} /> */
export const Plane: ElementFactory<PrimitiveProps<'width' | 'height'>> = builtin('Plane');
/** Zylinder. @example <Cylinder radiusTop={0.5} radiusBottom={0.5} height={2} /> */
export const Cylinder: ElementFactory<PrimitiveProps<'radiusTop' | 'radiusBottom' | 'height' | 'segments'>> = builtin('Cylinder');
/** Kegel. @example <Cone radius={0.5} height={1} /> */
export const Cone: ElementFactory<PrimitiveProps<'radius' | 'height' | 'segments'>> = builtin('Cone');
/** Torus. @example <Torus radius={1} tube={0.3} /> */
export const Torus: ElementFactory<PrimitiveProps<'radius' | 'tube'>> = builtin('Torus');
/** Torusknoten. @example <TorusKnot radius={1} tube={0.3} p={2} q={3} /> */
export const TorusKnot: ElementFactory<PrimitiveProps<'radius' | 'tube' | 'p' | 'q'>> = builtin('TorusKnot');
/** Kapsel. @example <Capsule radius={0.3} length={1} /> */
export const Capsule: ElementFactory<PrimitiveProps<'radius' | 'length'>> = builtin('Capsule');
/** 3D-Modell (`src` → Asset). @example <Model src="./assets/product.glb" rotationY={45} /> */
export const Model: ElementFactory<Props3D<'model3d', 'asset'> & { readonly src?: string }> = builtin('Model');
/** Instanzen. @example <Instances geometry={{ type: 'box' }} count={100} layout={{ type: 'grid', columns: 10, spacing: 1 }} /> */
export const Instances: ElementFactory<Props3D<'instances3d'>> = builtin('Instances');
/** 3D-Partikel. @example <Particles3D count={500} /> */
export const Particles3D: ElementFactory<Props3D<'particles3d'>> = builtin('Particles3D');
/** 3D-Gruppe. @example <Group3D position={[0, 1, 0]}>…</Group3D> */
export const Group3D: ElementFactory<Props3D<'group3d'>> = builtin('Group3D');

/** Props von {@link AudioTrack}. */
export type AudioTrackProps = Partial<Omit<IrAudioTrack, 'kind' | 'clips'>> & { readonly children?: Child };
/** Props von {@link AudioClip}: `src` → Audio-Asset oder `source` → vorhandene Quelle. */
export type AudioClipProps = Partial<Omit<IrAudioClip, 'id' | 'source'>> & { readonly id?: string; readonly src?: string; readonly source?: string };

/** Audiospur mit Clips (→ `composition.tracks`). @example <AudioTrack role="music"><AudioClip src="./music.mp3" start="0s" /></AudioTrack> */
export const AudioTrack: ElementFactory<AudioTrackProps> = builtin('AudioTrack');
/** Audio-Clip in einer {@link AudioTrack}. @example <AudioClip src="./vo.wav" start="1s" volume={0.8} /> */
export const AudioClip: ElementFactory<AudioClipProps> = builtin('AudioClip');
/** Marker (→ `composition.markers`). @example <Marker id="drop" time="4s" /> */
export const Marker: ElementFactory<Partial<IrMarker> & Pick<IrMarker, 'time'>> = builtin('Marker');
