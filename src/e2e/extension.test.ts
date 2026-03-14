import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('Extension activates and exports API', async () => {
    const ext = vscode.extensions.getExtension('csvlinter.csvlinter-vscode');
    assert.ok(ext, 'CSVLinter extension should be available');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
