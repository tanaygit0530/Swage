import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { UndoResult } from '../../src/changeset/apply';
import type { SwageTestApi } from '../../src/extension';
import type { FileSettleResult } from '../../src/review/vscode/controller';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * Per-file review in a real VS Code (review upgrade, steps 3 and 9): a scripted run edits four
 * files; one is accepted as a file, one rejected, one accepted block by block, one rejected;
 * the disk is checked after every step; then each apply is undone in reverse order, across a
 * reload of the undo history.
 */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const activeDiffPath = (): string | undefined => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input.modified.path.slice(1) : undefined;
};

suite('Swage per-file review', () => {
  test('accept a file, reject a file, accept one block, then undo each apply in order', async () => {
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
    void api.startRun('Add a config command; test, document and mention it in the README.');
    await waitFor(() => api.review.current !== undefined, 'the review');
    const session = api.review.current;
    assert.ok(session);
    assert.deepStrictEqual(session.openFiles(), files);
    // The first file in path order opens by itself.
    await waitFor(() => activeDiffPath() === 'README.md', 'the first diff');

    // Open one file: the diff pair is the original and the staged text.
    await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
    await waitFor(() => activeDiffPath() === 'app/cli.py', 'the cli diff');
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff);
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(input.original)).getText(),
      original['app/cli.py'],
    );
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(input.modified)).getText(),
      session.preview('app/cli.py').content,
    );

    // Accept file: only app/cli.py is written; the next pending file opens.
    const accepted = await vscode.commands.executeCommand<FileSettleResult>(
      'swage.review.acceptFile',
      { path: 'app/cli.py' },
    );
    assert.deepStrictEqual(accepted, {
      ok: true,
      path: 'app/cli.py',
      how: 'applied',
      next: 'docs/cli.md',
    });
    assert.ok(read('app/cli.py').includes('def config_command'));
    for (const f of ['README.md', 'docs/cli.md', 'tests/test_cli.py'])
      assert.strictEqual(read(f), original[f], `${f} untouched`);
    await waitFor(() => activeDiffPath() === 'docs/cli.md', 'auto-advance to docs');
    assert.strictEqual(session.status('app/cli.py'), 'applied');

    // Reject file: docs stays byte-identical; on to the tests.
    const rejected = await vscode.commands.executeCommand<FileSettleResult>(
      'swage.review.rejectFile',
      { path: 'docs/cli.md' },
    );
    assert.strictEqual(rejected.ok && rejected.how, 'discarded');
    assert.strictEqual(read('docs/cli.md'), original['docs/cli.md']);
    await waitFor(() => activeDiffPath() === 'tests/test_cli.py', 'auto-advance to tests');

    // README: accept one block, reject the other, then Accept file applies exactly that block.
    const [b1, b2] = session.file('README.md')?.blocks ?? [];
    assert.ok(b1 && b2, 'two README blocks');
    assert.ok(
      await vscode.commands.executeCommand('swage.review.acceptBlock', {
        path: 'README.md',
        blockId: b1.id,
      }),
    );
    assert.ok(
      await vscode.commands.executeCommand('swage.review.rejectBlock', {
        path: 'README.md',
        blockId: b2.id,
      }),
    );
    assert.strictEqual(session.status('README.md'), 'partial');
    await vscode.commands.executeCommand('swage.review.acceptFile', { path: 'README.md' });
    assert.ok(read('README.md').startsWith('# Swage demo workspace (with a config command)\n'));
    assert.ok(!read('README.md').includes('Run `config`'), 'the rejected block is not applied');

    // The last file: rejecting it ends the review.
    await vscode.commands.executeCommand('swage.review.rejectFile', { path: 'tests/test_cli.py' });
    await waitFor(() => api.review.current === undefined, 'the review to end');
    assert.strictEqual(read('tests/test_cli.py'), original['tests/test_cli.py']);
    assert.ok(
      !vscode.window.tabGroups.all.some((g) =>
        g.tabs.some(
          (t) =>
            t.input instanceof vscode.TabInputTextDiff &&
            t.input.modified.scheme === 'swage-staged',
        ),
      ),
      'the Swage diff tabs are closed',
    );

    // Undo each apply in reverse order; the history survives a reload in between.
    const undo = (): Thenable<UndoResult> =>
      vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', { force: false });
    assert.ok((await undo()).ok);
    assert.strictEqual(read('README.md'), original['README.md']);
    assert.ok(read('app/cli.py').includes('def config_command'), 'cli is still applied');
    api.review.reloadFromStorage();
    assert.ok((await undo()).ok);
    for (const f of files) assert.strictEqual(read(f), original[f], `${f} restored`);
  });
});
