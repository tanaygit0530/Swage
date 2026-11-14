import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * Drives the real review UI into the states documented in docs/images, in a dark and a light
 * theme, and hands each one to scripts/screenshots.mjs, which captures the window over the
 * DevTools protocol. Runs only through `npm run screenshots`. The demo workspace holds no secrets.
 */

const dir = process.env['SWAGE_SHOT_DIR'] ?? '';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The states, in capture order (scripts/screenshots.mjs reads the same list). */
export const THEMES = [
  ['dark', 'Default Dark Modern'],
  ['light', 'Default Light Modern'],
] as const;

async function tidy(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
}

async function shot(name: string): Promise<void> {
  await tidy();
  await sleep(1800);
  writeFileSync(path.join(dir, `${name}.ready`), '');
  const done = path.join(dir, `${name}.done`);
  for (let i = 0; i < 300 && !existsSync(done); i++) await sleep(100);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !predicate(); i++) await sleep(50);
}

suite('screenshots', () => {
  test('review UI', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    const api = (await ext?.activate()) as SwageTestApi;
    const scenario = loadScenarios(
      path.join(ext?.extensionPath ?? '', 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'four-file-edit');
    if (!scenario) throw new Error('scenario missing');

    for (const [theme, themeName] of THEMES) {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', themeName, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await api.resetRuntime();
      api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
      void api.startRun('Add a config command; test, document and mention it in the README.');
      await waitFor(() => api.review.current !== undefined);
      const session = api.review.current;
      if (!session) throw new Error('no review');
      await vscode.commands.executeCommand('swage.review.focus');
      await vscode.commands.executeCommand('swage.review.expandAll');

      // 1. The inline red and green diff with the per-change controls, the tree and status bar.
      await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
      await shot(`review-diff-${theme}`);

      // 2. Per-file controls on a partly reviewed file: one change accepted, one rejected.
      const [b1, b2] = session.file('README.md')?.blocks ?? [];
      await vscode.commands.executeCommand('swage.review.openFile', { path: 'README.md' });
      await vscode.commands.executeCommand('swage.review.acceptBlock', {
        path: 'README.md',
        blockId: b1?.id,
      });
      await vscode.commands.executeCommand('swage.review.rejectBlock', {
        path: 'README.md',
        blockId: b2?.id,
      });
      await shot(`review-file-controls-${theme}`);

      // 3. A comment on diff lines for the agent.
      await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'swage-staged');
      const editor = vscode.window.activeTextEditor;
      const block = session.preview('app/cli.py').blocks[0];
      if (editor && block) {
        editor.selection = new vscode.Selection(block.start, 0, block.start + 1, 0);
        const thread =
          await vscode.commands.executeCommand<vscode.CommentThread>('swage.review.addComment');
        await vscode.commands.executeCommand('swage.review.saveComment', {
          thread,
          text: 'Name it show-config, to match the other commands.',
        });
      }
      await shot(`review-comment-${theme}`);

      // 4. One file accepted: the tree shows it applied, the next file opens by itself.
      await vscode.commands.executeCommand('swage.review.clearComments');
      await vscode.commands.executeCommand('swage.review.acceptFile', { path: 'app/cli.py' });
      await shot(`review-applied-${theme}`);

      await vscode.commands.executeCommand('swage.review.discard');
      await vscode.commands.executeCommand('swage.undoLastChangeSet', { force: true });
    }
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
  });
});
