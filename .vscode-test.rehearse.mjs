import { defineConfig } from '@vscode/test-cli';

// The rehearsal (scripts/rehearse.mjs run): a test VS Code on the Flask clone, the real extension,
// the running TrueForge and real models. No sdkFactory: nothing is scripted.
export default defineConfig({
  files: 'out/test/rehearse/**/*.test.js',
  version: 'stable',
  workspaceFolder: process.env.REHEARSE_DIR,
  launchArgs: ['--disable-extensions'],
  env: {
    SWAGE_TEST_API: '1',
    REHEARSE_OUT: process.env.REHEARSE_OUT ?? '',
    REHEARSE_TASKS: process.env.REHEARSE_TASKS ?? '',
    REHEARSE_RUNS_A: process.env.REHEARSE_RUNS_A ?? '5',
    REHEARSE_RUNS_B: process.env.REHEARSE_RUNS_B ?? '3',
    REHEARSE_RUNS_C: process.env.REHEARSE_RUNS_C ?? '3',
    REHEARSE_FALLBACK_MODEL: process.env.REHEARSE_FALLBACK_MODEL ?? '',
    REHEARSE_TRUEFORGE: process.env.REHEARSE_TRUEFORGE ?? '',
  },
  mocha: { ui: 'tdd', timeout: 0 },
});
