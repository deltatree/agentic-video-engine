/**
 * Webfonts aus `/fonts.css` vor dem Zeichnen laden.
 */

/**
 * Lädt alle Schriften aus fonts.css. `fonts.ready` allein wartet nur auf bereits begonnene
 * Ladevorgänge, und `font-display: block` zeigt bis dahin keinen Text. Läuft vor
 * `onFrame`, damit auch Canvas-Text die Webfonts nutzt.
 *
 * @example
 * ```ts
 * await loadFonts(document);
 * ```
 */
export async function loadFonts(doc: Document): Promise<void> {
  await Promise.all(
    [...doc.fonts].map((face) =>
      face.load().catch((error: unknown) => {
        // Eine defekte Schrift fällt auf die nächste Familie zurück, wie im Browser üblich.
        return error;
      }),
    ),
  );
}
