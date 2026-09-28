import root from '../../eslint.config.js';
// Das Studio hat eigenes JSX und Vite-Typen; es prüft gegen die eigene tsconfig.
export default [
  ...root,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'vite.config.ts'],
    languageOptions: { parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname } },
  },
];
