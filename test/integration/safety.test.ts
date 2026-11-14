import * as assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import type { FileSettleResult } from '../../src/review/vscode/controller';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * Safety rules of the review (review upgrade, step 8): nothing is written before Accept; a file
 * altered after the write (here by a save participant acting as a formatter) is reported and
 * never re-applied; a file changed on disk since staging is refused as a conflict.
 */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Swage review safety', () => {
  test('reports a file a formatter altered after Accept, and refuses a conflict', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
    const files = ['README.md', 'app/cli.py', 'docs/cli.md', 'tests/test_cli.py'];
    const original = Object.fromEntries(files.map((f) => [f, read(f)]));
    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'four-file-edit');
    assert.ok(scenario);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
    void api.startRun('Add a config command.');
    await waitFor(() => api.review.current !== undefined, 'the review');
    // Nothing is written before an Accept.
    for (const f of files) assert.strictEqual(read(f), original[f], `${f} before Accept`);

    // A "formatter": a save participant that appends a line to app/cli.py.
    let saves = 0;
    const formatter = vscode.workspace.onWillSaveTextDocument((e) => {
      if (!e.document.uri.fsPath.endsWith(path.join('app', 'cli.py'))) return;
      saves++;
      const end = e.document.lineAt(e.document.lineCount - 1).range.end;
      e.waitUntil(Promise.resolve([vscode.TextEdit.insert(end, '\n# formatted\n')]));
    });
    try {
      const r = await vscode.commands.executeCommand<FileSettleResult>('swage.review.acceptFile', {
        path: 'app/cli.py',
      });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(api.review.lastAltered, ['app/cli.py']);
      // Reported, not re-applied: the formatter's line stays, and it ran once (no loop).
      assert.ok(read('app/cli.py').endsWith('# formatted\n'));
      assert.ok(read('app/cli.py').includes('def config_command'));
      assert.strictEqual(saves, 1);
    } finally {
      formatter.dispose();
    }

    // A file changed on disk since staging: refused as a conflict, nothing written.
    writeFileSync(path.join(root, 'docs/cli.md'), `${original['docs/cli.md']}\nEdited by hand.\n`);
    const conflict = await vscode.commands.executeCommand<FileSettleResult>(
      'swage.review.acceptFile',
      {
        path: 'docs/cli.md',
        ask: false,
      },
    );
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(!conflict.ok && conflict.reason, 'conflict');
    assert.strictEqual(read('docs/cli.md'), `${original['docs/cli.md']}\nEdited by hand.\n`);
    // Re-staging from the new content makes it reviewable again.
    const restaged = await vscode.commands.executeCommand<FileSettleResult>(
      'swage.review.acceptFile',
      {
        path: 'docs/cli.md',
        restageOnConflict: true,
      },
    );
    assert.strictEqual(restaged.ok, false);
    assert.strictEqual(api.review.current?.status('docs/cli.md'), 'pending');

    // Reject the rest: those files stay byte-identical.
    await vscode.commands.executeCommand('swage.review.discard');
    assert.strictEqual(read('README.md'), original['README.md']);
    assert.strictEqual(read('tests/test_cli.py'), original['tests/test_cli.py']);
    // Clean up for the other suites.
    await vscode.commands.executeCommand('swage.undoLastChangeSet', { force: true });
    writeFileSync(path.join(root, 'docs/cli.md'), original['docs/cli.md'] ?? '');
    assert.strictEqual(read('app/cli.py'), original['app/cli.py']);
  });
});
