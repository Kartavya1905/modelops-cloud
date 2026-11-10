// Flat ESLint config for the whole workspace.
// Type-aware rules use the TypeScript project service, which is why the workspace
// pins TypeScript 6.x (typescript-eslint does not support the TS 7 native compiler yet).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      '**/generated/**',
      '**/.venv/**',
      'packages/api-contract/src/schema.d.ts',
      '**/playwright-report/**', // generated HTML report (gitignored)
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // NestJS uses classes with only static/decorated members (modules).
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Allow React's idiomatic `onChange={(e) => setValue(e.target.value)}`.
      // `_name` marks an intentionally unused binding (e.g. a route param kept for documentation).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    // Response DTO classes exist for Swagger; services build them as plain object literals and
    // spread them freely. Nothing is ever constructed with `new`, so no prototype can be lost.
    files: ['apps/api/src/modules/**/*.service.ts'],
    rules: { '@typescript-eslint/no-misused-spread': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
