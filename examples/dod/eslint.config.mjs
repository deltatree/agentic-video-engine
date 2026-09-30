// Der Definition-of-Done-Test liegt außerhalb der Pakete; er bekommt ein eigenes tsconfig-Projekt.
import root from '../../eslint.config.js';
export default [
  ...root,
  {
    files: ['*.test.ts'],
    languageOptions: { parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname } },
  },
];
