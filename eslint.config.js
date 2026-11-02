// Standalone flat config: no `any`, no unused vars, type-only imports, `.js` suffixes on relative imports
// (CONTRIBUTING.md, "Rules the tree enforces"). It imports no shared configuration package, because the
// private-dependency guard forbids non-public dependencies. Test files are linted like every other file.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// A relative specifier must end in an explicit runtime extension.
const RELATIVE_WITHOUT_EXTENSION = String.raw`/^\.{1,2}\/(?!.*\.(?:js|mjs|cjs|json|css)$)/`;
const SUFFIX_MESSAGE = 'Relative imports must use an explicit .js suffix (CONTRIBUTING.md).';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.turbo/**', 'artifacts/**'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: `ImportDeclaration[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
        {
          selector: `ExportNamedDeclaration[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
        {
          selector: `ExportAllDeclaration[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
        {
          selector: `ImportExpression[source.value=${RELATIVE_WITHOUT_EXTENSION}]`,
          message: SUFFIX_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  }
);
