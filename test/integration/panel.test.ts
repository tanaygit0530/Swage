import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SwageTestApi } from '../../src/extension';
import type { HostToWebview } from '../../src/ui/protocol';
import { FakeTrueForge } from '../agent/fakeTrueForge';
import { loadScenarios } from '../fake-model/scenario';

/**
 * The redesigned panel's host paths in a real VS Code (redesign steps 4 and 6): Planning mode
 * pauses on the plan, nothing is staged before Approve, the files-changed bar follows the
 * review, Accept all applies through the atomic apply, and the toast's Undo restores the files.
 */

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite('Swage agent panel', () => {
  test('Planning: approve the plan, Accept all from the bar, then Undo', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
    const before = read('app/cli.py');
    const posts: HostToWebview[] = [];
    const sub = api.onPanelPost((m) => posts.push(m));
    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'three-file-edit');
    assert.ok(scenario);
    await api.resetRuntime();
    api.setSdkFactory(
      (mcp) =>
        new FakeTrueForge({
          scenario,
          mcp,
          gated: ['submit_change_set', 'run_command', 'declare_context'],
        }).sdk,
    );
    try {
      void api.startRun('Add a config command; test and document it.', 'planning');
      await waitFor(
        () => posts.some((p) => p.type === 'plan' && p.awaiting === true),
        'the plan card',
      );
      assert.strictEqual(
        posts.some((p) => p.type === 'edit'),
        false,
        'nothing is staged before Approve',
      );

      void api.decidePlan(true);
      await waitFor(() => api.review.current !== undefined, 'the review');
      await waitFor(
        () => posts.some((p) => p.type === 'changes' && p.phase === 'review'),
        'the bar in review',
      );
      const bar = [...posts].reverse().find((p) => p.type === 'changes');
      assert.ok(bar?.type === 'changes');
      assert.deepStrictEqual(
        bar.files.map((f) => f.path),
        ['app/cli.py', 'docs/cli.md', 'tests/test_cli.py'],
      );
      assert.ok(posts.some((p) => p.type === 'walkthrough'));
      assert.strictEqual(read('app/cli.py'), before, 'nothing written before Accept all');

      await api.panelMessage({ type: 'acceptAll' });
      const applied = posts.find((p) => p.type === 'applied');
      assert.ok(applied?.type === 'applied');
      assert.strictEqual(applied.files, 3);
      assert.ok(read('app/cli.py').includes('def config_command'));
      // The review finished: the bar empties.
      assert.ok(posts.some((p) => p.type === 'changes' && p.phase === 'none'));

      await api.panelMessage({ type: 'undo' });
      await waitFor(() => read('app/cli.py') === before, 'the undo');
    } finally {
      sub.dispose();
    }
  });

  test('Reject all from the bar discards the change set and leaves the workspace unchanged', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    const api = (await ext.activate()) as SwageTestApi;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const before = readFileSync(path.join(root, 'app/cli.py'), 'utf8');
    const scenario = loadScenarios(
      path.join(ext.extensionPath, 'test', 'fake-model', 'scenarios'),
    ).find((s) => s.name === 'three-file-edit');
    assert.ok(scenario);
    await api.resetRuntime();
    api.setSdkFactory((mcp) => new FakeTrueForge({ scenario, mcp }).sdk);
    void api.startRun('Add a config command; test and document it.');
    await waitFor(() => api.review.current !== undefined, 'the review');
    await api.panelMessage({ type: 'rejectAll' });
    assert.strictEqual(api.review.current, undefined);
    assert.strictEqual(readFileSync(path.join(root, 'app/cli.py'), 'utf8'), before);
  });
});
