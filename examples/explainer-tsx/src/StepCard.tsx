/**
 * Eigene Komponente: eine nummerierte Karte für einen Schritt. Komponenten im TSX-SDK sind
 * einfache Funktionen, die Elemente zurückgeben; OpenVideo sieht danach nur noch Nodes.
 */
import { Circle, Group, Rect, Text, ref, type SdkElement } from '@agentic-video/sdk';

/** Props von {@link StepCard}. */
export interface StepCardProps {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly x: number;
  readonly y: number;
  /** Start der Karte auf der Zeitachse ihres Elternteils, z. B. "1.5s". */
  readonly from: string;
}

/** Breite und Höhe jeder Karte in Pixeln. */
export const CARD_WIDTH = 480;
export const CARD_HEIGHT = 300;

/**
 * Nummerierte Karte mit Titel und Text, die von unten einfährt.
 *
 * @example
 * ```tsx
 * <StepCard id="step-1" index={1} title="Connect" body="Link your sources." x={120} y={400} from="1s" />
 * ```
 */
export function StepCard(props: StepCardProps): SdkElement {
  const { id } = props;
  return (
    <Group id={id} x={props.x} y={props.y} timing={{ from: props.from }} transition={{ in: { type: 'slide-up', duration: '0.5s', ease: 'easeOutCubic' } }}>
      <Rect id={`${id}-card`} width={CARD_WIDTH} height={CARD_HEIGHT} cornerRadius={28} fill={ref('theme.colors.surface')} shadow={{ color: '#0B1F1C22', blur: 30, offsetY: 12 }} />
      <Circle id={`${id}-dot`} x={40} y={40} radius={36} fill={ref('theme.colors.primary')} />
      <Text id={`${id}-number`} text={String(props.index)} x={40} y={52} width={72} textAlign="center" fontSize={40} fontWeight={800} fill="#FFFFFF" />
      <Text id={`${id}-title`} text={props.title} x={40} y={140} width={CARD_WIDTH - 80} fontSize={44} fontWeight={700} fill={ref('theme.colors.text')} />
      <Text id={`${id}-body`} text={props.body} x={40} y={206} width={CARD_WIDTH - 80} fontSize={26} lineHeight={1.35} fill={ref('theme.colors.muted')} />
    </Group>
  );
}
