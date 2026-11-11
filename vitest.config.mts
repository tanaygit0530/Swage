import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/retrieval-eval/**/*.test.ts',
      'test/mcp/**/*.test.ts',
      'test/fake-model/**/*.test.ts',
      'test/agent/**/*.test.ts',
      'test/rehearsal/**/*.test.ts',
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
        'src/inline/**/*.ts',
        'src/resilience/**/*.ts',
        'src/doctor/**/*.ts',
      ],
      // controller.ts and the vscode folders need VS Code, main.tsx a browser; the integration test and F5 cover them.
      exclude: [
        'src/**/index.ts',
        'src/agent/controller.ts',
        'src/review/vscode/**',
        'src/inline/vscode/**',
        'src/resilience/vscode/**',
        'src/doctor/vscode.ts',
        'src/ui/webview/main.tsx',
      ],
      reporter: ['text', 'text-summary', 'json-summary'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
