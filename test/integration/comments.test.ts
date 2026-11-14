import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import type { HostToWebview } from '../../src/ui/protocol';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/** Comments on diff lines go to the agent with the next request (review upgrade, step 6). */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Swage review comments', () => {
  test('a comment on selected diff lines is sent with the next request, then cleared', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'three-file-edit');
    assert.ok(scenario);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
    const posts: HostToWebview[] = [];
    const sub = api.onPanelPost((m) => posts.push(m));
    try {
      void api.startRun('Add a config command.');
      await waitFor(() => api.review.current !== undefined, 'the review');
      await vscode.commands.executeCommand('swage.review.openFile', { path: 'app/cli.py' });
      await waitFor(
        () => vscode.window.activeTextEditor?.document.uri.scheme === 'swage-staged',
        'the staged editor',
      );
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      const block = api.review.current?.preview('app/cli.py').blocks[0];
      assert.ok(block);
      editor.selection = new vscode.Selection(block.start, 0, block.start + 1, 0);
      const thread =
        await vscode.commands.executeCommand<vscode.CommentThread>('swage.review.addComment');
      assert.ok(thread, 'a comment box opens on the selection');
      assert.strictEqual(thread.range?.start.line, block.start);
      await vscode.commands.executeCommand('swage.review.saveComment', {
        thread,
        text: 'Name the command show-config instead.',
      });
      const chip = posts.filter((p) => p.type === 'comments').at(-1);
      assert.ok(chip?.type === 'comments');
      assert.strictEqual(chip.items.length, 1);
      assert.strictEqual(chip.items[0]?.path, 'app/cli.py');

      // The next request carries the comment (file, lines, quoted code, text); the chip clears.
      await vscode.commands.executeCommand('swage.review.discard');
      // The first run finishes once its change set is discarded; then the next request goes.
      await waitFor(
        () => !['starting', 'running', 'paused'].includes(api.runState() ?? ''),
        'the first run to finish',
      );
      const before = posts.length;
      await api.panelMessage({ type: 'submit', text: 'Please address my comment.' });
      const user = posts.slice(before).find((p) => p.type === 'user');
      assert.ok(user?.type === 'user');
      assert.match(user.text, /^Please address my comment\.\n\nReview comments from the user/);
      assert.match(user.text, new RegExp(`- app/cli\\.py lines? ${block.start + 1}`));
      assert.match(user.text, /Name the command show-config instead\./);
      assert.match(user.text, /<<<CODE app\/cli\.py/);
      const last = posts.filter((p) => p.type === 'comments').at(-1);
      assert.ok(last?.type === 'comments');
      assert.strictEqual(last.items.length, 0);
      await waitFor(() => api.review.current !== undefined, 'the second review');
      await vscode.commands.executeCommand('swage.review.discard');
    } finally {
      sub.dispose();
    }
  });
});
