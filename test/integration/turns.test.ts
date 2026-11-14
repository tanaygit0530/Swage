import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/** Per-turn review (review upgrade, step 5): a second turn parks the first, which comes back. */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Swage per-turn review', () => {
  test('a newer turn parks the earlier review, which can be resumed and settled on its own', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    const scenarios = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    );
    const scenario = scenarios.find((s) => s.name === 'four-file-edit');
    assert.ok(scenario);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);

    void api.startRun('First turn: add a config command.');
    await waitFor(() => api.review.current !== undefined, 'the first review');
    const first = api.review.current?.taskId ?? '';
    await waitFor(() => api.runState() === 'paused', 'the first run to pause');

    void api.startRun('Second turn: the same again.');
    await waitFor(() => (api.review.current?.taskId ?? first) !== first, 'the second review');
    const second = api.review.current?.taskId ?? '';
    assert.deepStrictEqual(
      api.review.turns().map((t) => [t.taskId, t.current]),
      [
        [second, true],
        [first, false],
      ],
    );

    // Review the first turn again: its review is current; discarding it brings the second back.
    assert.strictEqual(await api.review.resumeTurn(first), true);
    assert.strictEqual(api.review.current?.taskId, first);
    assert.ok(await vscode.commands.executeCommand('swage.review.discard'));
    await waitFor(() => api.review.current?.taskId === second, 'the second turn to come back');
    assert.strictEqual(await api.review.resumeTurn(first), false, 'the first turn is settled');
    assert.ok(await vscode.commands.executeCommand('swage.review.discard'));
    assert.strictEqual(api.review.current, undefined);
  });
});
