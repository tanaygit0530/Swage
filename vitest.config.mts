import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/retrieval-eval/**/*.test.ts',
      'test/mcp/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/changeset/**/*.ts',
        'src/safety/**/*.ts',
        'src/context/**/*.ts',
        'src/supervisor/**/*.ts',
        'src/client/**/*.ts',
        'src/mcp/**/*.ts',
      ],
      exclude: ['src/**/index.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
