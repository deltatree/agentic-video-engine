// Die Beispielprojekte (Story 19.7) liegen außerhalb der Pakete; sie bekommen ein eigenes tsconfig-Projekt.
// examples/dod hat eine eigene Konfiguration, examples/plugin-hello ist reines JavaScript.
import root from '../eslint.config.js';
export default [
  ...root,
  {
    files: ['example-test-utils.ts', '*/*.test.ts', 'explainer-tsx/src/**/*.ts', 'explainer-tsx/src/**/*.tsx'],
    languageOptions: { parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname } },
  },
];
