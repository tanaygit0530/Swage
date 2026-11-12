import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import type { InlineCommandResult } from '../../src/inline/vscode/controller';
import type { ApplyCommandResult } from '../../src/review/vscode/controller';
import type { UndoResult } from '../../src/changeset/apply';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * Undo after a window reload (blueprint section 8; a penalty risk if it fails): two change sets
 * are applied, the in-memory undo history is dropped exactly as a reload drops it, and both are
 * undone from the checkpoints in global storage.
 */
suite('Swage undo after a reload', () => {
  test('two applied change sets are undone after the history is reloaded from storage', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const file = path.join(root, 'app', 'flags.py');
    const read = (): string => readFileSync(file, 'utf8');
    const scenarios = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    );
    const original = read();

    const applyScenario = async (
      name: string,
      line: number,
      instruction: string,
    ): Promise<void> => {
      const scenario = scenarios.find((s) => s.name === name);
      assert.ok(scenario, name);
      await api.resetRuntime();
      api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      editor.selection = new vscode.Selection(line - 1, 4, line - 1, 4);
      const r = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
        instruction,
      });
      assert.strictEqual(r.kind, 'review', r.message);
      await vscode.commands.executeCommand('swage.review.acceptAll');
      const applied = await vscode.commands.executeCommand<ApplyCommandResult>(
        'swage.review.apply',
        {
          confirmPending: false,
        },
      );
      assert.ok(applied.ok, JSON.stringify(applied));
    };

    await applyScenario('inline-rename', 23, 'Rename legacy_name to identity');
    const afterFirst = read();
    await applyScenario('inline-delete', 15, 'Remove the print');
    assert.notStrictEqual(read(), afterFirst);

    // A window reload: the in-memory history is gone; only global storage remains.
    api.review.reloadFromStorage();
    const u1 = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    assert.ok(u1.ok, JSON.stringify(u1));
    assert.strictEqual(read(), afterFirst);
    api.review.reloadFromStorage();
    const u2 = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    assert.ok(u2.ok, JSON.stringify(u2));
    assert.strictEqual(read(), original);
    const u3 = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    assert.ok(!u3.ok && u3.error.code === 'nothing_to_undo');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.resetRuntime();
  });
});
