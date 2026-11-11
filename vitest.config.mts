import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/retrieval-eval/**/*.test.ts',
      'test/mcp/**/*.test.ts',
      'test/fake-model/**/*.test.ts',
      'test/agent/**/*.test.ts',
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
        'src/agent/**/*.ts',
        'src/ui/**/*.ts',
        'src/review/**/*.ts',
      ],
      // controller.ts needs VS Code and main.tsx a browser; both are covered by the integration test and F5.
      exclude: ['src/**/index.ts', 'src/agent/controller.ts', 'src/ui/webview/main.tsx'],
      reporter: ['text', 'text-summary', 'json-summary'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
