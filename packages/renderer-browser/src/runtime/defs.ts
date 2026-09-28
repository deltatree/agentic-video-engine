/**
 * SVG-Filterdefinitionen (`feColorMatrix`) in der Host-Seite für CSS- und Canvas-Filter.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function defsRoot(): SVGSVGElement {
  const existing = document.getElementById('ov-defs');
  if (existing instanceof SVGSVGElement) return existing;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'ov-defs';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0;';
  document.body.append(svg);
  return svg;
}

/** Entfernt alle Filterdefinitionen (zu Beginn jedes Layers). */
export function clearDefs(): void {
  defsRoot().replaceChildren();
}

/**
 * Legt je Farbmatrix einen SVG-Filter an; `idFor(i)` liefert die ID aus `cssFilter`.
 *
 * @example
 * ```ts
 * defineColorMatrices(style.colorMatrices, (i) => `ov-cm-0-${i}`);
 * ```
 */
export function defineColorMatrices(matrices: readonly (readonly number[])[], idFor: (index: number) => string): void {
  const defs = defsRoot();
  matrices.forEach((matrix, i) => {
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = idFor(i);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    filter.setAttribute('x', '-50%');
    filter.setAttribute('y', '-50%');
    filter.setAttribute('width', '200%');
    filter.setAttribute('height', '200%');
    const fe = document.createElementNS(SVG_NS, 'feColorMatrix');
    fe.setAttribute('type', 'matrix');
    fe.setAttribute('values', matrix.join(' '));
    filter.append(fe);
    defs.append(filter);
  });
}
