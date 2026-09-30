/**
 * `createNodeEnvironment` reicht `allowHtmlScripts` an die Browser-Backends durch (D1, ADR 0008).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { createNodeEnvironment, renderFrame } from '@agentic-video/render';

/** Ein HTML-Layer, dessen Skript die ganze Fläche rot färbt. */
const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 64,
      height: 32,
      fps: 30,
      duration: '1s',
      background: '#000000',
      nodes: [{ id: 'probe', type: 'html', width: 64, height: 32, html: "<script>document.documentElement.style.background='#ff0000'</script>" }],
    },
  ],
};

async function centerPixel(allowHtmlScripts: boolean | undefined): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), 'ov-node-env-'));
  const env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new MemoryStore()), ...(allowHtmlScripts === undefined ? {} : { allowHtmlScripts }) });
  try {
    const { image } = await renderFrame(env, project, { compositionId: 'main', frame: 0, useCache: false });
    const o = (16 * 64 + 32) * 4;
    return [...image.data.slice(o, o + 4)];
  } finally {
    await env.dispose();
  }
}

describe('createNodeEnvironment: allowHtmlScripts', () => {
  it('sperrt HTML-Skripte standardmäßig', async () => {
    expect(await centerPixel(undefined)).toEqual([0, 0, 0, 255]);
  }, 60_000);

  it('führt HTML-Skripte mit allowHtmlScripts: true aus, aber nur mit OS-Sandbox (Story 16.1)', async () => {
    const result = await centerPixel(true).then(
      (pixel) => ({ pixel }),
      (error: unknown) => ({ error }),
    );
    // Ohne OS-Sandbox (z. B. als root) bricht der Browser-Host ab, statt Skripte ungeschützt auszuführen.
    if ('error' in result) expect(result.error).toMatchObject({ diagnostic: { code: 'OV_BROWSER_NO_OS_SANDBOX' } });
    else expect(result.pixel).toEqual([255, 0, 0, 255]);
  }, 60_000);
});
