import * as assert from 'assert';
import * as vscode from 'vscode';

const POLL_MS = 300;
const WAIT_VALID_MS = 5000;
const WAIT_INVALID_MS = 20000;
const WAIT_AFTER_EDIT_MS = 5000;
const WAIT_SCHEMA_MS = 15000;

const ROW_BAD_EMAIL = 87;
const ROW_BAD_AGE = 99;

const INVALID_CSV_CONTENT = `name,age,city
Alice,30,London
Bob,25
Carol,35,Berlin
`;

const VALID_CSV_CONTENT = `name,age,city
Alice,30,London
Bob,25,Paris
Carol,35,Berlin
`;

function getDiagnosticsForUri(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (diags: vscode.Diagnostic[]) => boolean,
  timeoutMs: number
): Promise<vscode.Diagnostic[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const diags = getDiagnosticsForUri(uri);
    if (predicate(diags)) {
      return diags;
    }
    await sleep(POLL_MS);
  }
  return getDiagnosticsForUri(uri);
}

suite('CSVLinter E2E', () => {
  test('valid CSV has no diagnostics', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'valid.csv');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    await sleep(WAIT_VALID_MS);
    const diagnostics = getDiagnosticsForUri(uri);
    assert.strictEqual(
      diagnostics.length,
      0,
      `Expected no diagnostics for valid.csv, got: ${diagnostics.map((d) => d.message).join('; ')}`
    );
  });

  test('invalid CSV has at least one diagnostic', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'invalid.csv');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const diagnostics = await waitForDiagnostics(
      uri,
      (diags) => diags.length >= 1,
      WAIT_INVALID_MS
    );
    assert.ok(
      diagnostics.length >= 1,
      `Expected at least one diagnostic for invalid.csv after ${WAIT_INVALID_MS}ms, got: ${diagnostics.length}`
    );
  });

  test('editing invalid row to valid updates linter state', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'invalid_editable.csv');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(INVALID_CSV_CONTENT, 'utf-8'));

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    await waitForDiagnostics(uri, (diags) => diags.length >= 1, WAIT_INVALID_MS);

    const invalidLineIndex = 2;
    const line = doc.lineAt(invalidLineIndex);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, line.range, 'Bob,25,Paris');

    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied, 'edit should be applied');

    const diagnosticsAfterEdit = await waitForDiagnostics(
      uri,
      (diags) => diags.length === 0,
      WAIT_AFTER_EDIT_MS
    );
    assert.strictEqual(
      diagnosticsAfterEdit.length,
      0,
      `Expected no diagnostics after fixing row, got: ${diagnosticsAfterEdit.map((d) => d.message).join('; ')}`
    );
  });

  test('schema inference reports bad email and bad age on expected rows', async () => {
    const config = vscode.workspace.getConfiguration('csvlinter');
    const initialInferSchema = config.get<boolean>('inferSchema', false);
    await config.update('inferSchema', true, vscode.ConfigurationTarget.Workspace);

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'workspace folder should be open');

      const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'schema_inference.csv');
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      const diagnostics = await waitForDiagnostics(
        uri,
        (diags) => diags.length >= 2,
        WAIT_SCHEMA_MS
      );
      assert.ok(
        diagnostics.length >= 2,
        `Expected at least 2 diagnostics (bad email row ${ROW_BAD_EMAIL}, bad age row ${ROW_BAD_AGE}), got: ${diagnostics.length}`
      );

      const lineNumbers = diagnostics.map((d) => d.range.start.line);
      assert.ok(
        lineNumbers.includes(ROW_BAD_EMAIL),
        `Expected a diagnostic on row ${ROW_BAD_EMAIL} (bad email), got lines: ${lineNumbers.join(', ')}`
      );
      assert.ok(
        lineNumbers.includes(ROW_BAD_AGE),
        `Expected a diagnostic on row ${ROW_BAD_AGE} (bad age), got lines: ${lineNumbers.join(', ')}`
      );
    } finally {
      await config.update('inferSchema', initialInferSchema, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('schema off: no inference errors on schema_inference.csv', async () => {
    const config = vscode.workspace.getConfiguration('csvlinter');
    const initialInferSchema = config.get<boolean>('inferSchema', false);
    await config.update('inferSchema', false, vscode.ConfigurationTarget.Workspace);
    await sleep(500);

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspaceFolder, 'workspace folder should be open');

      const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'schema_inference.csv');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await sleep(300);

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      await sleep(WAIT_VALID_MS);
      const diagnostics = getDiagnosticsForUri(uri);
      assert.strictEqual(
        diagnostics.length,
        0,
        `With inferSchema false, expected no diagnostics (structural only), got: ${diagnostics.map((d) => d.message).join('; ')}`
      );
    } finally {
      await config.update('inferSchema', initialInferSchema, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('lint on save triggers diagnostics', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'valid_save_test.csv');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(VALID_CSV_CONTENT, 'utf-8'));

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    await sleep(WAIT_VALID_MS);
    assert.strictEqual(getDiagnosticsForUri(uri).length, 0, 'Expected no diagnostics before edit');

    const lineToBreak = doc.lineAt(2);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, lineToBreak.range, 'Bob,25');

    const applied = await vscode.workspace.applyEdit(edit);
    assert.ok(applied, 'edit should be applied');

    const docEdited = await vscode.workspace.openTextDocument(uri);
    await docEdited.save();

    const diagnostics = await waitForDiagnostics(
      uri,
      (diags) => diags.length >= 1,
      WAIT_AFTER_EDIT_MS
    );
    assert.ok(
      diagnostics.length >= 1,
      `Expected at least one diagnostic after save, got: ${diagnostics.length}`
    );
  });

  test('unsaved buffer with invalid CSV shows diagnostics', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'csv',
      content: INVALID_CSV_CONTENT,
    });
    await vscode.window.showTextDocument(doc);

    const diagnostics = await waitForDiagnostics(
      doc.uri,
      (diags) => diags.length >= 1,
      WAIT_INVALID_MS
    );
    assert.ok(
      diagnostics.length >= 1,
      `Expected at least one diagnostic for unsaved invalid CSV, got: ${diagnostics.length}`
    );
  });

  test('multiple open files: only invalid has diagnostics', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const validUri = vscode.Uri.joinPath(workspaceFolder.uri, 'valid.csv');
    const invalidUri = vscode.Uri.joinPath(workspaceFolder.uri, 'invalid.csv');

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(validUri));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(invalidUri));

    await sleep(WAIT_VALID_MS);
    const validDiags = getDiagnosticsForUri(validUri);
    const invalidDiags = await waitForDiagnostics(
      invalidUri,
      (diags) => diags.length >= 1,
      WAIT_INVALID_MS
    );

    assert.strictEqual(
      validDiags.length,
      0,
      `Expected no diagnostics for valid.csv, got: ${validDiags.map((d) => d.message).join('; ')}`
    );
    assert.ok(
      invalidDiags.length >= 1,
      `Expected at least one diagnostic for invalid.csv, got: ${invalidDiags.length}`
    );
  });

  test('diagnostics have non-empty messages', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'invalid.csv');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const diagnostics = await waitForDiagnostics(
      uri,
      (diags) => diags.length >= 1,
      WAIT_INVALID_MS
    );
    diagnostics.forEach((d, i) => {
      assert.ok(d.message.length > 0, `Diagnostic ${i} should have non-empty message`);
    });
    const messages = diagnostics.map((d) => d.message).join(' ');
    assert.ok(
      /column|row|invalid|expected|number|count/i.test(messages),
      `Expected diagnostic messages to mention structure (column/row/invalid/expected/number/count), got: ${messages}`
    );
  });

  test('header-only CSV has consistent diagnostic behavior', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'workspace folder should be open');

    const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'header_only.csv');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    await sleep(WAIT_VALID_MS);
    const diagnostics = getDiagnosticsForUri(uri);
    diagnostics.forEach((d) => {
      assert.ok(d.message.length > 0, 'Each diagnostic should have a message');
    });
  });

  test('redownload command is registered', async () => {
    const commands = await vscode.commands.getCommands();
    assert.ok(
      commands.includes('csvlinter.redownloadLinter'),
      'csvlinter.redownloadLinter should be registered'
    );
  });
});
