import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';
import { userDataArgs } from './scripts/vscode-user-data.mjs';

// Each run gets a fresh copy of the demo workspace, because the review tests apply edits to it.
const workspace = mkdtempSync(path.join(tmpdir(), 'swage-it-'));
cpSync('test/fake-model/demo', workspace, { recursive: true });

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: 'stable',
  launchArgs: userDataArgs(),
  workspaceFolder: workspace,
  env: { SWAGE_TEST_API: '1' },
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
});
