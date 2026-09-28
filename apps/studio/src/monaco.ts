/**
 * Monaco mit Workern (Vite) und JSON-Schema-Validierung für `project.json`.
 * Wird erst geladen, wenn der Code-Tab offen ist.
 */
import { SCHEMA_ID, buildJsonSchema } from '@agentic-video/core';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

globalThis.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Das Schema kommt aus derselben Quelle wie `openvideo.schema.json` (buildJsonSchema).
monaco.json.jsonDefaults.setDiagnosticsOptions({
  validate: true,
  enableSchemaRequest: false,
  schemas: [{ uri: SCHEMA_ID, fileMatch: ['*project.json'], schema: buildJsonSchema() }],
});

monaco.editor.defineTheme('openvideo', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#14161B' },
});

export { monaco };
