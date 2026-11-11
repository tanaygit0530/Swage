import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { CheckResult } from '../../src/doctor/checks';

/** Swage: Doctor inside VS Code (blueprint F8): every check reports, with a fix for each problem. */
suite('Swage Doctor', () => {
  test('runs every check and reports pass, warn, fail or skip with a fix hint', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext);
    await ext.activate();
    const results = await vscode.commands.executeCommand<CheckResult[]>('swage.doctor', {
      show: false,
    });
    const ids = results.map((r) => r.id);
    for (const id of ['node', 'trueforge', 'mcp', 'ripgrep', 'python', 'pytest', 'trust'])
      assert.ok(ids.includes(id), `${id} missing: ${ids.join(', ')}`);
    assert.ok(
      ids.some((i) => i.startsWith('probe:')),
      'a model probe per profile',
    );
    for (const r of results) {
      assert.ok(['pass', 'warn', 'fail', 'skip'].includes(r.status), r.id);
      if (r.status === 'fail') assert.ok(r.fix, `${r.id} has no fix hint`);
    }
    // The test workspace is trusted, and VS Code ships ripgrep.
    assert.strictEqual(results.find((r) => r.id === 'trust')?.status, 'pass');
    assert.strictEqual(results.find((r) => r.id === 'ripgrep')?.status, 'pass');
  });
});
