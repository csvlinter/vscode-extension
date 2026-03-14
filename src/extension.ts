import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';
import * as tar from 'tar';
import {
  isCsvFile,
  isOnDisk,
  syntheticCsvFilename,
  getReleaseAssetName,
  getReleaseAssetUrl,
  getLinterBinaryName,
  getLinterPath,
  downloadFile,
  fileExists,
  shouldUseStdin,
  buildLintArgs,
  handleLinterClose,
  truncateForLog,
} from './utils';

const GITHUB_REPO = 'csvlinter/csvlinter';
const LINTER_BINARY_NAME = getLinterBinaryName(os.platform());
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

let diagnosticCollection: vscode.DiagnosticCollection;
let linterPath: string | null;
const pendingLintRequests: Map<string, NodeJS.Timeout> = new Map();

const outputChannel = vscode.window.createOutputChannel('CSVLinter');

const logger = (...args: string[]) => {
  if (vscode.workspace.getConfiguration('csvlinter').get('debug', false)) {
    outputChannel.appendLine(['[CSVLinter]', ...args].join(' '));
  }
};

export async function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('csv');
  context.subscriptions.push(diagnosticCollection);
  context.subscriptions.push(outputChannel);
  linterPath = await resolveLinterPath(context);

  if (!linterPath) {
    vscode.window.showErrorMessage(
      "CSVLinter binary not found. Please run the 'Re-download Linter' command."
    );
  }

  const redownloadCommand = vscode.commands.registerCommand(
    'csvlinter.redownloadLinter',
    async () => {
      vscode.window.showInformationMessage('Forcing re-download of the CSVLinter binary...');
      const binaryPath = path.join(context.globalStorageUri.fsPath, LINTER_BINARY_NAME);
      try {
        if (await fileExists(binaryPath)) {
          await fs.promises.unlink(binaryPath);
        }
        linterPath = await resolveLinterPath(context);

        if (linterPath) {
          vscode.window.showInformationMessage('CSVLinter has been successfully downloaded.');
          // Immediately try to lint the active file after a successful re-download.
          if (
            vscode.window.activeTextEditor &&
            isCsvFile(vscode.window.activeTextEditor.document)
          ) {
            lintDocument(vscode.window.activeTextEditor.document, linterPath);
          }
        } else {
          vscode.window.showErrorMessage('Failed to re-download CSVLinter.');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to re-download CSVLinter: ${err}`);
      }
    }
  );
  context.subscriptions.push(redownloadCommand);

  logger('Checking active editor on activation...');
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    if (linterPath && isCsvFile(activeEditor.document)) {
      logger('...linting initially active file.');
      lintDocument(activeEditor.document, linterPath);
    } else {
      logger(
        `...skipping initially active file. Linter ready: ${!!linterPath}, Is CSV: ${isCsvFile(activeEditor.document)}, LangID: ${activeEditor.document.languageId}`
      );
    }
  } else {
    logger('...no initially active editor.');
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      logger('onDidOpenTextDocument event fired for:', document.uri.fsPath);
      if (linterPath && isCsvFile(document)) {
        logger('...linting opened file.');
        const useStdin = !isOnDisk(document.uri.scheme);
        lintDocument(document, linterPath, useStdin ? document.getText() : undefined);
      } else {
        logger(
          `...skipping opened file. Linter ready: ${!!linterPath}, Is CSV: ${isCsvFile(document)}, LangID: ${document.languageId}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      logger('onDidChangeActiveTextEditor event fired.');
      if (editor) {
        if (linterPath && isCsvFile(editor.document)) {
          logger('...linting focused file.');
          const useStdin = !isOnDisk(editor.document.uri.scheme);
          lintDocument(
            editor.document,
            linterPath,
            useStdin ? editor.document.getText() : undefined
          );
        } else {
          logger(
            `...skipping focused file. Linter ready: ${!!linterPath}, Is CSV: ${isCsvFile(editor.document)}, LangID: ${editor.document.languageId}`
          );
        }
      } else {
        logger('...editor is undefined.');
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (linterPath && isCsvFile(document)) {
        logger('...linting on save.');
        await lintDocument(document, linterPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document;
      const key = document.uri.toString();

      if (pendingLintRequests.has(key)) {
        clearTimeout(pendingLintRequests.get(key)!);
      }

      const handle = setTimeout(() => {
        if (linterPath && isCsvFile(document)) {
          lintDocument(document, linterPath, document.getText());
        }
        pendingLintRequests.delete(key);
      }, 200);

      pendingLintRequests.set(key, handle);
    })
  );

  logger('CSVLinter extension is now active!!');
}

async function lintDocument(document: vscode.TextDocument, linterPath: string, text?: string) {
  const filePath = document.uri.fsPath || '';
  const useStdin = shouldUseStdin(isOnDisk(document.uri.scheme), text);
  const content = useStdin ? (text ?? document.getText()) : undefined;
  const filenameForDiag = useStdin
    ? syntheticCsvFilename(path.basename(document.fileName || 'untitled.csv'))
    : filePath;
  const inferSchema = vscode.workspace
    .getConfiguration('csvlinter')
    .get<boolean>('inferSchema', false);

  diagnosticCollection.delete(document.uri);
  logger('Linting document:', document.uri.fsPath, useStdin ? '(using stdin)' : '(using file)');

  const args = buildLintArgs({
    useStdin,
    filePath,
    filenameForDiag,
    inferSchema,
  });
  logger('Spawning linter with args:', JSON.stringify(args));
  const proc = childProcess.spawn(linterPath, args, { stdio: 'pipe' });

  if (useStdin) {
    const out = content ?? '';
    logger('Sending text to stdin (first 200 chars):', truncateForLog(out, 200));
    proc.stdin.write(out);
    proc.stdin.end();
  }

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => {
    stdout += d.toString();
    logger('Linter stdout chunk:', truncateForLog(d.toString(), 200));
  });
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    logger('Linter stderr chunk:', truncateForLog(d.toString(), 200));
  });

  proc.on('close', (code) => {
    logger('Linter process exited with code:', String(code));
    const raw = stdout.trim() || stderr.trim();
    logger('Linter raw output (first 500 chars):', truncateForLog(raw, 500));

    handleLinterClose(code, stdout, stderr, {
      onFatal: (c) =>
        vscode.window.showErrorMessage(`csvlinter failed (exit ${c}). See "CSV-Linter" output.`),
      onEmpty: () => diagnosticCollection.set(document.uri, []),
      onParseError: (message) => {
        const range = new vscode.Range(0, 0, 0, Number.MAX_VALUE);
        const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diagnosticCollection.set(document.uri, [diag]);
      },
      onDiagnostics: (errors) => {
        logger('Diagnostics to set:', JSON.stringify(errors, null, 2));
        const diagnostics = errors.map(
          (err) =>
            new vscode.Diagnostic(
              new vscode.Range(err.line, 0, err.line, Number.MAX_VALUE),
              err.message,
              vscode.DiagnosticSeverity.Error
            )
        );
        diagnosticCollection.set(document.uri, diagnostics);
      },
    });
  });
}

async function resolveLinterPath(context: vscode.ExtensionContext): Promise<string | null> {
  const storageDir = context.globalStorageUri.fsPath;
  return getLinterPath({
    storageDir,
    binaryName: LINTER_BINARY_NAME,
    fileExists,
    onFoundExisting: (p) => logger(`Linter already exists at: ${p}`),
    ensureDownloaded: async (binaryPath) => {
      vscode.window.showInformationMessage('Downloading CSVLinter...');
      await downloadAndExtractLinter(context);
      logger(`Linter downloaded and extracted to: ${binaryPath}`);
      if (os.platform() !== 'win32') {
        await fs.promises.chmod(binaryPath, 0o755);
      }
    },
  }).catch((err) => {
    console.error(err);
    vscode.window.showErrorMessage(`Failed to download linter: ${err}`);
    return null;
  });
}

async function downloadAndExtractLinter(context: vscode.ExtensionContext) {
  const assetName = getReleaseAssetName(os.platform(), os.arch());
  if (!assetName) {
    vscode.window.showErrorMessage(`Unsupported architecture: ${os.arch()}`);
    throw new Error('Unsupported architecture');
  }
  const assetUrl = await getReleaseAssetUrl(LATEST_RELEASE_URL, assetName);
  if (!assetUrl) {
    throw new Error('Could not find a compatible release asset.');
  }

  const storagePath = context.globalStorageUri.fsPath;
  if (!(await fileExists(storagePath))) {
    await fs.promises.mkdir(storagePath, { recursive: true });
  }

  const downloadPath = path.join(storagePath, 'linter.tar.gz');
  await downloadFile(assetUrl, downloadPath);

  const binaryDir = path.join(storagePath, 'bin');
  if (!(await fileExists(binaryDir))) {
    await fs.promises.mkdir(binaryDir, { recursive: true });
  }

  await tar.x({
    file: downloadPath,
    cwd: storagePath,
  });

  const extractedBinaryPath = path.join(storagePath, LINTER_BINARY_NAME);
  const finalBinaryPath = path.join(context.globalStorageUri.fsPath, LINTER_BINARY_NAME);
  await fs.promises.rename(extractedBinaryPath, finalBinaryPath);

  await fs.promises.unlink(downloadPath);
}

export function deactivate() {}
