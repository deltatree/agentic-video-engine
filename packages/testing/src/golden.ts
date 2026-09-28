/**
 * Golden-Image-Tests: vergleicht ein Bild mit einer gespeicherten PNG-Datei.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OpenVideoError, type RgbaImage } from '@agentic-video/core';
import { decodePng, encodePng } from '@agentic-video/png';
import { compareImages, type CompareOptions, type CompareResult } from './images.js';

function sidePaths(goldenPath: string): { actual: string; diff: string } {
  const base = goldenPath.replace(/\.png$/iu, '');
  return { actual: `${base}.actual.png`, diff: `${base}.diff.png` };
}

/**
 * Vergleicht `image` mit der PNG-Datei `goldenPath`.
 *
 * - Mit `UPDATE_GOLDENS=1` schreibt die Funktion die Datei neu und besteht.
 * - Fehlt die Datei, schreibt sie `<name>.actual.png` und wirft `OV_TEST_GOLDEN_MISSING`.
 * - Weicht das Bild ab, schreibt sie `<name>.actual.png` und `<name>.diff.png` neben das
 *   Golden und wirft `OV_TEST_GOLDEN_MISMATCH`.
 * - Besteht der Vergleich, löscht sie alte `.actual.png`- und `.diff.png`-Dateien.
 *
 * @example
 * ```ts
 * expectGolden(frame, new URL('./golden/title.png', import.meta.url).pathname);
 * ```
 */
export function expectGolden(image: RgbaImage, goldenPath: string, options: CompareOptions = {}): CompareResult {
  const side = sidePaths(goldenPath);
  if (process.env['UPDATE_GOLDENS'] === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, encodePng(image));
    rmSync(side.actual, { force: true });
    rmSync(side.diff, { force: true });
    return compareImages(image, image, options);
  }
  if (!existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(side.actual, encodePng(image));
    throw new OpenVideoError({
      code: 'OV_TEST_GOLDEN_MISSING',
      errorClass: 'GoldenError',
      problem: `Golden image ${goldenPath} does not exist.`,
      details: { actual: side.actual },
      suggestions: ['Run the test with UPDATE_GOLDENS=1 to create it.', `Inspect ${side.actual} before you keep the new golden.`],
    });
  }
  const expected = decodePng(readFileSync(goldenPath));
  const result = compareImages(image, expected, options);
  if (result.pass) {
    rmSync(side.actual, { force: true });
    rmSync(side.diff, { force: true });
    return result;
  }
  writeFileSync(side.actual, encodePng(image));
  writeFileSync(side.diff, encodePng(result.diffImage));
  throw new OpenVideoError({
    code: 'OV_TEST_GOLDEN_MISMATCH',
    errorClass: 'GoldenError',
    problem: `Image differs from golden ${goldenPath}: ${String(result.diffPixels)} pixels differ, max channel delta ${String(result.maxDelta)}.`,
    details: { diffPixels: result.diffPixels, maxDelta: result.maxDelta, actual: side.actual, diff: side.diff, width: image.width, height: image.height, goldenWidth: expected.width, goldenHeight: expected.height },
    suggestions: [`Inspect ${side.diff} (red = differing pixels).`, 'If the change is intended, run the test with UPDATE_GOLDENS=1 and review the new golden.'],
  });
}
