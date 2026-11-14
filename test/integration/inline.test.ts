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
 * swage.inlineEdit inside a real VS Code (blueprint sections 3 and 10, Task A): the scripted
 * inline agent edits the function around the cursor, the result opens as block review in the
 * editor, one block is rejected and one accepted, Apply writes only the accepted one, Undo
 * restores it. A second run is cancelled with swage.stop (Escape) mid-stream.
 */

const FLAGS = 'app/flags.py';
const TASK_A =
  "In get_debug_flag, treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Swage inline edit', () => {
  let api: SwageTestApi;
  let ext: vscode.Extension<unknown>;
  let root = '';
  const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');

  async function useScenario(name: string): Promise<void> {
    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === name);
    assert.ok(scenario, name);
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
  }

  async function openAt(line: number): Promise<vscode.TextEditor> {
    const doc = await vscode.workspace.openTextDocument(path.join(root, FLAGS));
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(line - 1, 4, line - 1, 4);
    return editor;
  }

  async function lensTitles(): Promise<string[]> {
    const session = api.review.current;
    assert.ok(session);
    const uri = vscode.Uri.from({
      scheme: 'swage-staged',
      path: `/${FLAGS}`,
      query: session.taskId,
    });
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      uri,
    );
    return lenses.map((l) => l.command?.title ?? '');
  }

  suiteSetup(async () => {
    const found = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(found);
    ext = found;
    const activated = (await ext.activate()) as SwageTestApi | undefined;
    assert.ok(activated, 'test API missing: SWAGE_TEST_API is not set');
    api = activated;
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  });

  test('Task A shape: two blocks in the editor; reject one, accept one, apply, undo', async () => {
    await useScenario('inline-logic-docstring');
    const original = read(FLAGS);
    await openAt(9); // inside get_debug_flag, no selection: the whole function is the target

    const result = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
      instruction: TASK_A,
    });
    assert.strictEqual(result.kind, 'review', result.message);
    assert.strictEqual(api.review.mode.mode, 'inline');
    // The review is in the editor: the active editor is the staged side of a native diff.
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.scheme, 'swage-staged');
    const titles = await lensTitles();
    assert.ok(
      titles.some((t) => t.startsWith('1 of 2 · +')),
      titles.join(' | '),
    );
    assert.ok(
      titles.some((t) => t.startsWith('2 of 2 · +')),
      titles.join(' | '),
    );
    for (const t of ['Accept all', 'Reject all', '$(check-all) Apply', 'Discard'])
      assert.ok(titles.includes(t), `${t} missing: ${titles.join(' | ')}`);
    assert.strictEqual(read(FLAGS), original, 'nothing is written before Apply');

    const session = api.review.current;
    assert.ok(session);
    const [doc, logic] = session.preview(FLAGS).blocks;
    await vscode.commands.executeCommand('swage.review.rejectBlock', {
      path: FLAGS,
      blockId: doc?.id,
    });
    await vscode.commands.executeCommand('swage.review.acceptBlock', {
      path: FLAGS,
      blockId: logic?.id,
    });
    const applied = await vscode.commands.executeCommand<ApplyCommandResult>('swage.review.apply', {
      confirmPending: false,
    });
    assert.ok(applied.ok, JSON.stringify(applied));
    const after = read(FLAGS);
    assert.ok(after.includes('{"0", "false", "no", "off", "n"}'), after);
    assert.ok(
      !after.includes('"off" and "n" are treated as false'),
      'the rejected docstring block stayed out',
    );
    assert.strictEqual(api.review.current, undefined);

    const undo = await vscode.commands.executeCommand<UndoResult>('swage.undoLastChangeSet', {
      force: false,
    });
    assert.ok(undo.ok, JSON.stringify(undo));
    assert.strictEqual(read(FLAGS), original);
  });

  test('one block still gets the per-block view with Accept all, Reject all and Apply', async () => {
    await useScenario('inline-rename');
    const original = read(FLAGS);
    await openAt(23);
    const result = await vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
      instruction: 'Rename legacy_name to identity',
    });
    assert.strictEqual(result.kind, 'review', result.message);
    const titles = await lensTitles();
    assert.ok(
      titles.some((t) => t.startsWith('1 of 1 · +1 -1')),
      titles.join(' | '),
    );
    for (const t of ['$(close) Reject', 'Accept all', 'Reject all', '$(check-all) Apply'])
      assert.ok(titles.includes(t), `${t} missing: ${titles.join(' | ')}`);
    assert.ok(await vscode.commands.executeCommand('swage.review.discard'));
    assert.strictEqual(read(FLAGS), original);
  });

  test('Escape (swage.stop) cancels mid-stream through the agent-mode path; file unchanged', async () => {
    await useScenario('inline-cancel');
    const original = read(FLAGS);
    await openAt(9);
    const running = vscode.commands.executeCommand<InlineCommandResult>('swage.inlineEdit', {
      instruction: TASK_A,
    });
    await waitFor(() => api.inline.running, 'the inline run to start');
    await new Promise((r) => setTimeout(r, 600)); // a few tokens stream
    await vscode.commands.executeCommand('swage.stop');
    const result = await running;
    assert.strictEqual(result.kind, 'cancelled');
    assert.strictEqual(result.message, 'Cancelled. Workspace unchanged.');
    assert.strictEqual(api.review.current, undefined);
    assert.strictEqual(read(FLAGS), original);
  });
});
