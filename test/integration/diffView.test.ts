import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * Spike for the review upgrade (step 0), kept as a test: a Swage diff opens in VS Code's inline
 * diff view without changing the user's setting for good, the diff pair is the original and the
 * staged text, and the CodeLens provider answers inside the diff's staged side.
 */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sideBySide = (): { effective: unknown; global: unknown } => {
  const c = vscode.workspace.getConfiguration('diffEditor');
  return {
    effective: c.get('renderSideBySide'),
    global: c.inspect('renderSideBySide')?.globalValue,
  };
};

suite('Swage diff view (spike)', () => {
  test('opens inline, shows original and staged text, lenses work, and the setting comes back', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    // Earlier tests may have left Swage diffs open: closing them must put the default back.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(
      () => api.review.diffView.pending.length === 0,
      'the restore after closing diffs',
    );
    // The test VS Code keeps extension state in memory, so a value an earlier, killed run left in
    // the test profile has no record to restore from: clear it before measuring.
    if (sideBySide().global !== undefined)
      await vscode.workspace
        .getConfiguration('diffEditor')
        .update('renderSideBySide', undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => sideBySide().global === undefined, 'a clean test profile');
    const before = sideBySide();
    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'three-file-edit');
    assert.ok(scenario);
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
    void api.startRun('Add a config command; test and document it.');
    await waitFor(() => api.review.current !== undefined, 'the review');
    const session = api.review.current;
    assert.ok(session);

    await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
    await waitFor(() => sideBySide().effective === false, 'the inline view');
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'a diff tab');
    const input = tab.input;
    assert.strictEqual(input.original.scheme, 'swage-base');
    assert.strictEqual(input.modified.scheme, 'swage-staged');
    const original = await vscode.workspace.openTextDocument(input.original);
    const staged = await vscode.workspace.openTextDocument(input.modified);
    assert.strictEqual(original.getText(), session.base('app/cli.py'));
    assert.strictEqual(staged.getText(), session.preview('app/cli.py').content);
    assert.notStrictEqual(original.getText(), staged.getText());

    const lenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        input.modified,
      )) ?? [];
    const titles = lenses.map((l) => l.command?.title ?? '');
    assert.ok(
      titles.some((t) => /Accept/.test(t)),
      `lenses: ${titles.join(' | ')}`,
    );

    // Step 2: the keyboard moves between changes and decides the one under the cursor.
    // In a diff tab the active text editor is its modified (staged) side.
    const editor = vscode.window.activeTextEditor;
    assert.strictEqual(editor?.document.uri.toString(), input.modified.toString());
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const first = session.preview('app/cli.py').blocks[0];
    assert.ok(first);
    const line = await vscode.commands.executeCommand<number>('swage.review.nextChange');
    assert.strictEqual(line, first.start);
    assert.strictEqual(await vscode.commands.executeCommand('swage.review.acceptChange'), true);
    assert.strictEqual(session.file('app/cli.py')?.blocks[0]?.state, 'accepted');
    assert.strictEqual(await vscode.commands.executeCommand('swage.review.rejectChange'), true);
    assert.strictEqual(session.file('app/cli.py')?.blocks[0]?.state, 'rejected');
    const counter = (
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        input.modified,
      )) ?? []
    ).map((l) => l.command?.title ?? '');
    assert.ok(
      counter.some((t) => /^1 of \d+ · \+\d+ -\d+/.test(t)),
      counter.join(' | '),
    );
    assert.ok(counter.includes('$(close) Rejected'), counter.join(' | '));

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => sideBySide().global === undefined, 'the setting to come back');
    assert.strictEqual(sideBySide().effective, before.effective);
    await vscode.commands.executeCommand('swage.review.discard');
  });
});
