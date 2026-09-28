// Schreibt openvideo.schema.json aus dem gebauten Paket (FR-3).
import { writeFileSync } from 'node:fs';
import { buildJsonSchema } from '../dist/index.js';
writeFileSync(new URL('../openvideo.schema.json', import.meta.url), JSON.stringify(buildJsonSchema(), null, 2) + '\n');
