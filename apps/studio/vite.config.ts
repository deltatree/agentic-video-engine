// Build der Studio-App: Workspace-Pakete kommen direkt aus ihren Quellen (wie in Vitest).
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  // Relative Pfade: Das Studio läuft unter jeder Origin des Agent-Servers.
  base: './',
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@agentic-video\/([a-z0-9-]+)$/u, replacement: `${root}packages/$1/src/index.ts` }],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Monaco ist groß; die Warnung hilft hier nicht weiter.
    chunkSizeWarningLimit: 8000,
  },
  // Entwicklung: `openvideo serve` läuft auf Port 7788, das Studio spricht nur /v1/*.
  server: { proxy: { '/v1': 'http://127.0.0.1:7788' } },
});
