import root from '../../eslint.config.js';
export default [
  ...root,
  {
    files: ['templates/**/*.tsx', 'templates/**/*.ts'],
    languageOptions: { parserOptions: { project: ['./tsconfig.templates.json'], tsconfigRootDir: import.meta.dirname } },
  },
];
