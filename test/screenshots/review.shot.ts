import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * Drives the real UI into the states documented in docs/images, and hands each one to
 * scripts/screenshots.mjs, which captures the window over the DevTools protocol.
 * Runs only through `npm run screenshots`.
 */

const dir = process.env['SWAGE_SHOT_DIR'] ?? '';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function tidy(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
}

/** Widens the Swage sidebar so the tree and panel are readable (the command acts on the focused part). */
async function widenSidebar(): Promise<void> {
  await vscode.commands.executeCommand('swage.agentView.focus');
  for (let i = 0; i < 6; i++)
    await vscode.commands.executeCommand('workbench.action.increaseViewWidth');
}

async function shot(name: string): Promise<void> {
  await tidy();
  await sleep(1500);
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
    ).find((s) => s.name === 'three-file-edit');
    if (!scenario) throw new Error('scenario missing');
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('swage.openAgent');
    void api.startRun(
      'Add a config command that prints the configuration as JSON, masking secrets. Test and document it.',
    );
    await waitFor(() => api.review.current !== undefined);
    const session = api.review.current;
    if (!session) throw new Error('no review');

    await vscode.commands.executeCommand('swage.review.focus');
    await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
    await widenSidebar();
    await shot('review-diff');

    const [cli, , docs] = session.files();
    await vscode.commands.executeCommand('swage.review.acceptBlock', {
      path: 'app/cli.py',
      blockId: cli?.blocks[0]?.id,
    });
    await vscode.commands.executeCommand('swage.review.rejectBlock', {
      path: 'docs/cli.md',
      blockId: docs?.blocks[0]?.id,
    });
    await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
    await shot('review-decisions');

    await vscode.commands.executeCommand('swage.review.discard');
  });
});
