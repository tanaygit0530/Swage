import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import type { InlineCommandResult } from '../../src/inline/vscode/controller';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios, type Scenario } from '../fake-model/scenario';

/**
 * Task C in VS Code (blueprint sections 8 and 10): the primary model is unreachable, the inline
 * edit is repeated, Swage switches to the fallback with no click, the diff appears, Reject all,
 * and the file is unchanged. The profiles come from swage.models, changed at run time.
 */

const FLAGS = 'app/flags.py';
const TASK_A =
  "In get_debug_flag, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

suite('Swage fallback (Task C)', () => {
  let api: SwageTestApi;
  let root = '';
  let original: unknown;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    api = (await ext.activate()) as SwageTestApi;
    assert.ok(api);
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    original = vscode.workspace.getConfiguration('swage').inspect('models')?.workspaceValue;
    const scenarios = new Map(
      loadScenarios(path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios')).map((s) => [
        s.name,
        s,
      ]),
    );
    const edit = scenarios.get('inline-logic-docstring') as Scenario;
    const down: Scenario = { name: 'primary-down', steps: [{ error: 401 }] };
    await api.resetRuntime();
    api.setSdkFactory(
      (mcp) =>
        new FakeTrueForge({
          scenario: edit,
          scenarios: { 'swage-fake/primary-down': down, 'swage-fake/inline-logic-docstring': edit },
          mcp,
        }).sdk,
    );
    await vscode.workspace.getConfiguration('swage').update(
      'models',
      [
        { name: 'primary', label: 'Gemini', trueforgeModel: 'swage-fake/primary-down' },
        { name: 'fallback-1', label: 'Groq', trueforgeModel: 'swage-fake/inline-logic-docstring' },
      ],
      vscode.ConfigurationTarget.Workspace,
    );
    const start = Date.now();
    while (api.models.router?.primary.trueforgeModel !== 'swage-fake/primary-down') {
      if (Date.now() - start > 10_000) throw new Error('profiles not reloaded');
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration('swage')
      .update('models', original, vscode.ConfigurationTarget.Workspace);
    await api.resetRuntime();
  });

  test('the primary fails (401), the inline edit falls back with no click, Reject all leaves the file unchanged', async () => {
    const before = readFileSync(path.join(root, FLAGS), 'utf8');
    const doc = await vscode.workspace.openTextDocument(path.join(root, FLAGS));
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(8, 4, 8, 4);
    assert.strictEqual(api.models.router?.active.name, 'primary');

    const result = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
      instruction: TASK_A,
    });
    assert.strictEqual(result.kind, 'review', result.message);
    assert.strictEqual(api.models.router?.active.name, 'fallback-1');
    assert.strictEqual(api.models.router?.lastFailure('primary')?.failure.reason, 'returned 401');
    const session = api.review.current;
    assert.ok(session);
    assert.strictEqual(session.preview(FLAGS).blocks.length, 2);

    // Task C: Reject all, then close; git status stays clean because nothing was written.
    assert.ok(await vscode.commands.executeCommand('swage.review.rejectFile', { path: FLAGS }));
    assert.ok(await vscode.commands.executeCommand('swage.review.discard'));
    assert.strictEqual(readFileSync(path.join(root, FLAGS), 'utf8'), before);

    // The organiser changes the primary: the new model is used at once, nothing else to do.
    await vscode.workspace.getConfiguration('swage').update(
      'models',
      [
        { name: 'primary', trueforgeModel: 'swage-fake/inline-logic-docstring' },
        { name: 'fallback-1', label: 'Groq', trueforgeModel: 'swage-fake/primary-down' },
      ],
      vscode.ConfigurationTarget.Workspace,
    );
    const t0 = Date.now();
    while (api.models.router?.primary.trueforgeModel !== 'swage-fake/inline-logic-docstring') {
      if (Date.now() - t0 > 10_000) throw new Error('profiles not reloaded');
      await new Promise((r) => setTimeout(r, 50));
    }
    api.models.router?.setActive('primary');
    const back = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    back.selection = new vscode.Selection(8, 4, 8, 4);
    assert.strictEqual(api.models.router?.active.label, 'Fake'); // label from the provider part
    const again = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
      instruction: TASK_A,
    });
    assert.strictEqual(again.kind, 'review', again.message);
    assert.strictEqual(api.models.router?.active.name, 'primary');
    assert.ok(await vscode.commands.executeCommand('swage.review.discard'));
  });
});
