import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';
import { userDataArgs } from './scripts/vscode-user-data.mjs';

// Used only by scripts/screenshots.mjs: a fresh demo workspace and the DevTools port for capture.
const workspace = mkdtempSync(path.join(tmpdir(), 'swage-shots-'));
cpSync('test/fake-model/demo', workspace, { recursive: true });

export default defineConfig({
  files: 'out/test/screenshots/**/*.shot.js',
  version: 'stable',
  workspaceFolder: workspace,
  launchArgs: [...userDataArgs(), '--remote-debugging-port=9339', '--disable-extensions'],
  env: { SWAGE_TEST_API: '1', SWAGE_SHOT_DIR: process.env.SWAGE_SHOT_DIR ?? '' },
  mocha: { ui: 'tdd', timeout: 180000 },
});
