import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      '.vscode-test/**',
      '*.vsix',
      'test/retrieval-eval/fixture/**',
      'test/fake-model/demo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['esbuild.mjs', 'scripts/**', 'test/retrieval-eval/**'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
