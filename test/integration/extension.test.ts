import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXPECTED = [
  'swage.inlineEdit',
  'swage.openAgent',
  'swage.stop',
  'swage.reviewChanges',
  'swage.undoLastChangeSet',
  'swage.switchModel',
  'swage.doctor',
];

suite('Swage extension', () => {
  test('activates and registers every command', async () => {
    const ext = vscode.extensions.getExtension('swage-dev.swage');
    assert.ok(ext, 'extension swage-dev.swage not found');
    await ext.activate();
    const all = await vscode.commands.getCommands(true);
    for (const id of EXPECTED) {
      assert.ok(all.includes(id), `missing command ${id}`);
    }
  });
});
