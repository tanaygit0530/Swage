import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import type { ApplyCommandResult } from '../../src/review/vscode/controller';
import type { UndoResult } from '../../src/changeset/apply';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * The review flow inside a real VS Code (blueprint section 8): a scripted fake-model task edits
 * three files, the user accepts one block and rejects another, applies, undoes, and undoes again.
 */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Swage review flow', () => {
  test('edits three files; accept one block, reject another; apply; undo; undo again', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi | undefined;
    assert.ok(api, 'test API missing: SWAGE_TEST_API is not set');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
    const original = {
      cli: read('app/cli.py'),
      test: read('tests/test_cli.py'),
      docs: read('docs/cli.md'),
    };

    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'three-file-edit');
    assert.ok(scenario);
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
    void api.startRun(
      'Add a config command that prints the configuration with secrets masked; test and document it.',
    );

    // The agent submits; the Review view opens with three files of one block each.
    await waitFor(() => api.review.current !== undefined, 'the review to open');
    const session = api.review.current;
    assert.ok(session);
    const files = session.files();
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ['app/cli.py', 'tests/test_cli.py', 'docs/cli.md'],
    );
    for (const f of files) assert.strictEqual(f.blocks.length, 1, f.path);
    assert.strictEqual(api.runState(), 'paused');

    // The staged side of the diff shows the proposal; a rejected block drops out of it live.
    const staged = (p: string): vscode.Uri =>
      vscode.Uri.from({ scheme: 'swage-staged', path: `/${p}`, query: session.taskId });
    assert.ok(
      (await vscode.workspace.openTextDocument(staged('app/cli.py')))
        .getText()
        .includes('def config_command'),
    );
    const cliBlock = files[0]?.blocks[0]?.id ?? '';
    const docsBlock = files[2]?.blocks[0]?.id ?? '';
    assert.strictEqual(
      await vscode.commands.executeCommand('swage.review.acceptBlock', {
        path: 'app/cli.py',
        blockId: cliBlock,
      }),
      true,
    );
    assert.strictEqual(
      await vscode.commands.executeCommand('swage.review.rejectBlock', {
        path: 'docs/cli.md',
        blockId: docsBlock,
      }),
      true,
    );
    assert.strictEqual(session.preview('docs/cli.md').content, original.docs);
    await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });

    // Nothing is on disk before Apply.
    assert.strictEqual(read('app/cli.py'), original.cli);

    const applied = (await vscode.commands.executeCommand('swage.review.apply', {
      confirmPending: false,
    })) as ApplyCommandResult;
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.deepStrictEqual(applied.ok ? applied.files : [], ['app/cli.py']);
    assert.ok(read('app/cli.py').includes('def config_command'), 'accepted block applied');
    assert.strictEqual(read('docs/cli.md'), original.docs, 'rejected block not applied');
    assert.strictEqual(read('tests/test_cli.py'), original.test, 'pending block not applied');

    // Apply resumes the agent with allow; the run finishes.
    await waitFor(() => api.runState() === 'done', 'the run to finish');
    assert.strictEqual(api.review.current, undefined);

    // The undo history is persisted in global storage.
    const cpFile = api.review.checkpointPath() ?? '';
    assert.strictEqual(
      (JSON.parse(readFileSync(cpFile, 'utf8')) as { history: unknown[] }).history.length,
      1,
    );

    const undo = (await vscode.commands.executeCommand('swage.undoLastChangeSet', {
      force: false,
    })) as UndoResult;
    assert.ok(undo.ok, JSON.stringify(undo));
    assert.strictEqual(read('app/cli.py'), original.cli, 'undo restored the original');
    assert.strictEqual(
      (JSON.parse(readFileSync(cpFile, 'utf8')) as { history: unknown[] }).history.length,
      0,
    );

    const again = (await vscode.commands.executeCommand('swage.undoLastChangeSet', {
      force: false,
    })) as UndoResult;
    assert.strictEqual(again.ok, false);
    assert.strictEqual(again.ok ? '' : again.error.code, 'nothing_to_undo');
    assert.strictEqual(read('app/cli.py'), original.cli);
  });
});
