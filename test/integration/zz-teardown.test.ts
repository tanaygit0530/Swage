import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';

/**
 * A root hook that runs after every suite (test files do not run in name order): closes the
 * Swage diffs the tests left open and waits until the user's diff settings are back, so the test
 * profile ends clean. The test VS Code keeps extension state in memory, so the restore a normal
 * VS Code does on its next start has nothing to read here.
 */
suiteTeardown(async () => {
  const api = (await vscode.extensions.getExtension('swage-dev.swage')?.activate()) as
    SwageTestApi | undefined;
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (let i = 0; i < 100 && (api?.review.diffView.pending.length ?? 0) > 0; i++)
    await new Promise((r) => setTimeout(r, 50));
});
