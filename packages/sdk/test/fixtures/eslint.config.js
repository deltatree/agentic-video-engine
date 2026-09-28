// TSX-Fixtures gehören zu keinem tsconfig-Projekt. Sie werden daher ohne Typinformation geprüft.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/*.js'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
);
