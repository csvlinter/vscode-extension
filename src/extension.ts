import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import * as childProcess from "child_process";
import * as tar from "tar";

const GITHUB_REPO = "csvlinter/csvlinter";
const LINTER_BINARY_EXT = os.platform() === "win32" ? ".exe" : "";
const LINTER_BINARY_NAME = `csvlinter${LINTER_BINARY_EXT}`;
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

let diagnosticCollection: vscode.DiagnosticCollection;
let linterPath: string | null;
const pendingLintRequests: Map<string, NodeJS.Timeout> = new Map();

const outputChannel = vscode.window.createOutputChannel("CSVLinter");

const logger = (...args: string[]) => {
  if (vscode.workspace.getConfiguration("csvlinter").get("debug", false)) {
    outputChannel.appendLine(["[CSVLinter]", ...args].join(" "));
  }
};

export async function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection("csv");
  context.subscriptions.push(diagnosticCollection);
  context.subscriptions.push(outputChannel);
  linterPath = await getLinterPath(context);

  if (!linterPath) {
    vscode.window.showErrorMessage(
      "CSVLinter binary not found. Please run the 'Re-download Linter' command."
    );
  }

  const redownloadCommand = vscode.commands.registerCommand(
    "csvlinter.redownloadLinter",
    async () => {
      vscode.window.showInformationMessage(
        "Forcing re-download of the CSVLinter binary..."
      );
      const binaryPath = path.join(
        context.globalStorageUri.fsPath,
        LINTER_BINARY_NAME
      );
      try {
        if (await fileExists(binaryPath)) {
          await fs.promises.unlink(binaryPath);
        }
        linterPath = await getLinterPath(context);

        if (linterPath) {
          vscode.window.showInformationMessage(
            "CSVLinter has been successfully downloaded."
          );
          // Immediately try to lint the active file after a successful re-download.
          if (
            vscode.window.activeTextEditor &&
            isCsvFile(vscode.window.activeTextEditor.document)
          ) {
            lintDocument(vscode.window.activeTextEditor.document, linterPath);
          }
        } else {
          vscode.window.showErrorMessage("Failed to re-download CSVLinter.");
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to re-download CSVLinter: ${err}`
        );
      }
    }
  );
  context.subscriptions.push(redownloadCommand);

  // If the linter is ready, immediately lint the active document if it's a CSV.
  logger("Checking active editor on activation...");
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    if (linterPath && isCsvFile(activeEditor.document)) {
      logger("...linting initially active file.");
      lintDocument(activeEditor.document, linterPath);
    } else {
      logger(
        `...skipping initially active file. Linter ready: ${!!linterPath}, Is CSV: ${isCsvFile(
          activeEditor.document
        )}, LangID: ${activeEditor.document.languageId}`
      );
    }
  } else {
    logger("...no initially active editor.");
  }

  // Lint when a new file is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      logger("onDidOpenTextDocument event fired for:", document.uri.fsPath);
      if (linterPath && isCsvFile(document)) {
        logger("...linting opened file.");
        lintDocument(document, linterPath);
      } else {
        logger(
          `...skipping opened file. Linter ready: ${!!linterPath}, Is CSV: ${isCsvFile(
            document
          )}, LangID: ${document.languageId}`
        );
      }
    })
  );

  // Lint when an existing file is focused
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      logger("onDidChangeActiveTextEditor event fired.");
      if (editor) {
        if (linterPath && isCsvFile(editor.document)) {
          logger("...linting focused file.");
          lintDocument(editor.document, linterPath);
        } else {
          logger(
            `...skipping focused file. Linter ready: ${!!linterPath}, Is CSV: ${isCsvFile(
              editor.document
            )}, LangID: ${editor.document.languageId}`
          );
        }
      } else {
        logger("...editor is undefined.");
      }
    })
  );

  // Lint on future file saves
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (linterPath && isCsvFile(document)) {
        logger("...linting on save.");
        await lintDocument(document, linterPath);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document;
      const key = document.uri.toString();

      // debounce
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

  logger("CSVLinter extension is now active!!");
}

async function lintDocument(
  document: vscode.TextDocument,
  linterPath: string,
  text?: string
) {
  logger(
    "Linting document:",
    document.uri.fsPath,
    text ? "(using stdin)" : "(using file)"
  );
  diagnosticCollection.delete(document.uri);
  const args = [
    "validate",
    "--format",
    "json",
    ...(text
      ? ["--filename", document.uri.fsPath, "-"]
      : [document.uri.fsPath]),
  ];
  logger("Spawning linter with args:", JSON.stringify(args));
  const proc = childProcess.spawn(linterPath, args);

  if (text) {
    logger(
      "Sending text to stdin (first 200 chars):",
      text.slice(0, 200) + (text.length > 200 ? "..." : "")
    );
    proc.stdin.write(text);
    proc.stdin.end();
  }

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (d) => {
    stdout += d.toString();
    logger(
      "Linter stdout chunk:",
      d.toString().slice(0, 200) + (d.length > 200 ? "..." : "")
    );
  });
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    logger(
      "Linter stderr chunk:",
      d.toString().slice(0, 200) + (d.length > 200 ? "..." : "")
    );
  });

  proc.on("close", (code) => {
    logger("Linter process exited with code:", String(code));
    // Only treat codes >1 as catastrophic
    if (code && code > 1) {
      vscode.window.showErrorMessage(
        `csvlinter failed (exit ${code}). See "CSV-Linter" output.`
      );
      return;
    }

    // Some versions print JSON to stderr instead of stdout
    const raw = stdout.trim() || stderr.trim();
    logger(
      "Linter raw output (first 500 chars):",
      raw.slice(0, 500) + (raw.length > 500 ? "..." : "")
    );
    if (!raw) {
      vscode.window.showWarningMessage("CSVLinter produced no JSON output.");
      return;
    }

    let json: any;
    try {
      // If the linter ever adds banner text, grab the first {...} block
      const firstBrace = raw.indexOf("{");
      const lastBrace = raw.lastIndexOf("}");
      json = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch (e) {
      vscode.window.showErrorMessage(
        "CSVLinter output wasn't valid JSON (see Output)."
      );
      logger("Failed to parse linter output as JSON:", String(e), raw);
      return;
    }

    // Locate the errors array no matter how it's wrapped
    const errors =
      json.errors ?? json.validation?.errors ?? json.results?.errors ?? [];

    logger("Diagnostics to set:", JSON.stringify(errors, null, 2));
    const diagnostics = errors.map((err: any) => {
      const lineIdx = Math.max((err.line_number ?? err.line ?? 1) - 1, 0);
      const range = new vscode.Range(lineIdx, 0, lineIdx, Number.MAX_VALUE);
      const msg = err.message ?? err.description ?? JSON.stringify(err);
      return new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error);
    });

    diagnosticCollection.set(document.uri, diagnostics);
  });
}

function isCsvFile(document: vscode.TextDocument): boolean {
  return (
    document.languageId === "csv" || path.extname(document.fileName) === ".csv"
  );
}

async function getLinterPath(
  context: vscode.ExtensionContext
): Promise<string | null> {
  const binaryPath = path.join(
    context.globalStorageUri.fsPath,
    LINTER_BINARY_NAME
  );

  if (await fileExists(binaryPath)) {
    logger(`Linter already exists at: ${binaryPath}`);
    return binaryPath;
  }

  vscode.window.showInformationMessage("Downloading CSVLinter...");
  try {
    await downloadAndExtractLinter(context);
    logger(`Linter downloaded and extracted to: ${binaryPath}`);
    if (os.platform() !== "win32") {
      await fs.promises.chmod(binaryPath, 0o755); // Make executable
    }
    return binaryPath;
  } catch (err) {
    console.error(err);
    vscode.window.showErrorMessage(`Failed to download linter: ${err}`);
    return null;
  }
}

async function downloadAndExtractLinter(context: vscode.ExtensionContext) {
  const assetUrl = await getReleaseAssetUrl();
  if (!assetUrl) {
    throw new Error("Could not find a compatible release asset.");
  }

  const storagePath = context.globalStorageUri.fsPath;
  if (!(await fileExists(storagePath))) {
    await fs.promises.mkdir(storagePath, { recursive: true });
  }

  const downloadPath = path.join(storagePath, "linter.tar.gz");
  await downloadFile(assetUrl, downloadPath);

  const binaryDir = path.join(storagePath, "bin");
  if (!(await fileExists(binaryDir))) {
    await fs.promises.mkdir(binaryDir, { recursive: true });
  }

  await tar.x({
    file: downloadPath,
    cwd: storagePath,
  });

  const extractedBinaryPath = path.join(storagePath, LINTER_BINARY_NAME);
  const finalBinaryPath = path.join(
    context.globalStorageUri.fsPath,
    LINTER_BINARY_NAME
  );
  await fs.promises.rename(extractedBinaryPath, finalBinaryPath);

  await fs.promises.unlink(downloadPath);
}

async function getReleaseAssetUrl(): Promise<string | null> {
  const platform = os.platform();
  const arch = os.arch();
  let targetArch: string;

  // Map Node.js arch to Go arch
  if (arch === "x64") {
    targetArch = "amd64";
  } else if (arch === "arm64") {
    targetArch = "arm64";
  } else {
    vscode.window.showErrorMessage(`Unsupported architecture: ${arch}`);
    return null;
  }

  const targetPlatform = platform === "win32" ? "windows" : platform;
  const assetName = `csvlinter-${targetPlatform}-${targetArch}.tar.gz`;

  return new Promise((resolve, reject) => {
    https
      .get(
        LATEST_RELEASE_URL,
        { headers: { "User-Agent": "vscode-csvlinter-extension" } },
        (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            if (res.headers.location) {
              https
                .get(
                  res.headers.location,
                  { headers: { "User-Agent": "vscode-csvlinter-extension" } },
                  (res2) => {
                    let data = "";
                    res2.on("data", (chunk) => (data += chunk));
                    res2.on("end", () =>
                      handleReleaseApiResponse(data, assetName, resolve, reject)
                    );
                  }
                )
                .on("error", (err) =>
                  reject(`Failed to fetch releases (redirect): ${err.message}`)
                );
            } else {
              reject("Redirect without location for release API");
            }
            return;
          }

          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            handleReleaseApiResponse(data, assetName, resolve, reject)
          );
        }
      )
      .on("error", (err) => reject(`Failed to fetch releases: ${err.message}`));
  });
}

function handleReleaseApiResponse(
  data: string,
  assetName: string,
  resolve: (url: string | null) => void,
  reject: (reason?: any) => void
) {
  try {
    const releaseInfo = JSON.parse(data);
    const asset = releaseInfo.assets.find((a: any) => a.name === assetName);
    if (asset) {
      resolve(asset.browser_download_url);
    } else {
      reject(`Could not find asset: ${assetName}`);
    }
  } catch (e) {
    reject(`Failed to parse release API response: ${data}`);
  }
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "vscode-csvlinter-extension",
            Accept: "application/octet-stream",
          },
        },
        (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            if (response.headers.location) {
              downloadFile(response.headers.location, dest)
                .then(resolve)
                .catch(reject);
            } else {
              reject(new Error("Redirect with no location header"));
            }
            return;
          }
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Download failed with status code ${response.statusCode}`
              )
            );
            return;
          }
          response.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
        }
      )
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err.message);
      });
  });
}

function fileExists(filepath: string): Promise<boolean> {
  return fs.promises
    .access(path.resolve(filepath), fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export function deactivate() {}
