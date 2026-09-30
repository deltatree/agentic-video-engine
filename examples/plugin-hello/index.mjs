// Beispiel-Plugin für OpenVideo (Story 21.1): je eine Erweiterung jeder Art.
// Einbinden im Projekt: settings.plugins: ["./plugins/hello/index.mjs"]
// Laden mit: openvideo render --trusted (oder OPENVIDEO_ALLOW_PLUGINS=1)
// Rechte:   OPENVIDEO_PLUGIN_PERMISSIONS=fs:read,fs:write (für den Exporter)

/** Kleinster CSV-Parser für den Asset Loader (Kommas, keine Anführungszeichen). */
function parseCsv(text) {
  const lines = text.split(/\r?\n/u).filter((l) => l.trim() !== '');
  const header = (lines[0] ?? '').split(',').map((c) => c.trim());
  return { header, rows: lines.length - 1 };
}

/** Container „OVHF“ (OpenVideo Hello Frames): Kopfzeile als JSON, danach die PNGs mit Längenpräfix. */
function packFrames(meta, pngs) {
  const head = new TextEncoder().encode(`OVHF1 ${JSON.stringify(meta)}\n`);
  const size = head.length + pngs.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(size);
  out.set(head, 0);
  let at = head.length;
  for (const png of pngs) {
    new DataView(out.buffer).setUint32(at, png.length, false);
    out.set(png, at + 4);
    at += 4 + png.length;
  }
  return out;
}

/** @type {import('@agentic-video/core').Plugin} */
const plugin = {
  name: 'hello',
  version: '1.0.0',
  // Nur für den Exporter: Frames lesen, Ausgabe schreiben. Ohne diese Rechte lädt das Plugin nicht.
  permissions: ['fs:read', 'fs:write'],
  setup(ctx) {
    // Agent Tool → Operation `plugin.hello.greet` in API, MCP und `openvideo op`.
    ctx.registerAgentTool({
      name: 'hello.greet',
      description: 'Return a greeting for a name (example plugin tool).',
      inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'], additionalProperties: false },
      handler: async (input) => ({ greeting: `Hello, ${input.name}!` }),
    });

    // Codec → Render-Profil `codec: "plugin:x264-fast"` (mp4/mov).
    ctx.registerCodec({
      id: 'x264-fast',
      formats: ['mp4', 'mov'],
      license: 'GPL-2.0-or-later (libx264)',
      encoderArgs: ({ quality }) => ['-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(Math.round(40 - 0.25 * quality))],
    });

    // Exporter → Render-Profil `format: "plugin:hello-frames"` (eigene Bildfolge in einer Datei).
    ctx.registerExporter({
      id: 'hello-frames',
      description: 'All frames as PNG in one .ovhf file (example exporter).',
      extension: 'ovhf',
      async export({ framesDir, frameCount, width, height, fps, outPath }) {
        const pngs = [];
        for (let i = 0; i < frameCount; i++) pngs.push(await ctx.readFile(`${framesDir}/frame-${String(i).padStart(6, '0')}.png`));
        await ctx.writeFile(outPath, packFrames({ width, height, fps, frames: frameCount }, pngs));
      },
    });

    // Asset Loader → `.csv`-Dateien als Assets vom Typ `data` mit Metadaten.
    ctx.registerAssetLoader({
      id: 'hello-csv',
      extensions: ['csv'],
      type: 'data',
      inspect: async (bytes) => parseCsv(new TextDecoder().decode(bytes)),
    });

    // Studio Panel → Tab „Plugins“ im Studio (Modul relativ zu dieser Datei).
    ctx.registerStudioPanel({ id: 'hello-panel', title: 'Hello', module: './panel.mjs' });
  },
};

export default plugin;
