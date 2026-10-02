import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import regexp from 'eslint-plugin-regexp';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const codeFiles = ['src/**/*.ts', 'tests/**/*.{mjs,ts}', 'scripts/**/*.mjs'];
const typedFiles = ['src/**/*.ts', 'tests/**/*.ts'];

export default defineConfig(
  // The negative import fixture is compiled only against the installed tarball by test:package.
  globalIgnores(['**/node_modules/**', '**/coverage/**', '**/dist/**', 'tests/installed-declarations.ts']),
  {
    files: [...codeFiles, '*.config.mjs'],
    extends: [eslint.configs.recommended, comments.recommended, regexp.configs['flat/recommended']],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/no-use': ['error', { allow: ['eslint-disable-next-line'] }],
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      'no-duplicate-imports': 'error',
      'sort-imports': ['error', { ignoreDeclarationSort: true, allowSeparatedGroups: true }],
      eqeqeq: 'error',
      'no-eval': 'error',
      // DOM declarations support Solid's types; browser runtime globals remain unavailable.
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'location',
        'localStorage',
        'sessionStorage',
      ],
      'no-var': 'error',
      'prefer-const': 'error',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  {
    files: typedFiles,
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/consistent-type-exports': ['error', { fixMixedExportsWithInlineTypeSpecifier: true }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-use-before-define': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': { descriptionFormat: '^ -- .+$' },
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': true,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowNullableObject: false,
          allowAny: false,
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    // Tests supply deliberately partial SDK doubles and Promise-returning async stubs.
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as' }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // The Node test runner owns registration and completion of these promises.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: false,
          allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'it', 'describe'], package: 'node:test' }],
        },
      ],
    },
  },
  prettier,
  { rules: { curly: 'error' } },
);
