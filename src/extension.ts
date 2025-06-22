// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import * as childProcess from "child_process";
import * as tar from "tar";

const GITHUB_REPO = "csvlinter/csvlinter";
const LINTER_BINARY_NAME = "csvlinter";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

let diagnosticCollection: vscode.DiagnosticCollection;

export async function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection("csv");
  context.subscriptions.push(diagnosticCollection);

  const linterPath = await getLinterPath(context);
  if (!linterPath) {
    vscode.window.showErrorMessage(
      "Failed to download and setup CSVlinter. Please check the extension logs."
    );
    return;
  }

  if (
    vscode.window.activeTextEditor &&
    isCsvFile(vscode.window.activeTextEditor.document)
  ) {
    lintDocument(vscode.window.activeTextEditor.document, linterPath);
  }

  // Lint on open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      if (isCsvFile(document)) {
        await lintDocument(document, linterPath);
      }
    })
  );

  // Lint on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (isCsvFile(document)) {
        await lintDocument(document, linterPath);
      }
    })
  );

  console.log("CSVLinter extension is now active!");
}

async function lintDocument(document: vscode.TextDocument, linterPath: string) {
  const command = `"${linterPath}" validate "${document.uri.fsPath}" --format json`;

  childProcess.exec(command, (error, stdout, stderr) => {
    diagnosticCollection.clear();
    if (error && stdout) {
      // linter exits with error code on validation fail
      try {
        const results = JSON.parse(stdout);
        if (results.errors && results.errors.length > 0) {
          const diagnostics = results.errors.map((err: any) => {
            const line = err.line_number > 0 ? err.line_number - 1 : 0; // VSCode is 0-indexed
            const range = new vscode.Range(line, 0, line, Number.MAX_VALUE);
            const message = `${err.message} [${err.type}]`;
            return new vscode.Diagnostic(
              range,
              message,
              vscode.DiagnosticSeverity.Error
            );
          });
          diagnosticCollection.set(document.uri, diagnostics);
        }
      } catch (e) {
        console.error("Failed to parse linter output:", e);
        vscode.window.showErrorMessage("Error parsing linter output.");
      }
    } else if (stderr) {
      console.error(`Linter execution error: ${stderr}`);
      vscode.window.showErrorMessage(`Linter error: ${stderr}`);
    } else {
      // Clear diagnostics if the file is valid
      diagnosticCollection.set(document.uri, []);
    }
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
    console.log(`Linter already exists at: ${binaryPath}`);
    return binaryPath;
  }

  vscode.window.showInformationMessage("Downloading CSVlinter...");
  try {
    await downloadAndExtractLinter(context);
    console.log(`Linter downloaded and extracted to: ${binaryPath}`);
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

  // After extraction, the binary is at the root of storagePath, move it.
  const extractedBinaryPath = path.join(storagePath, LINTER_BINARY_NAME);
  const finalBinaryPath = path.join(
    context.globalStorageUri.fsPath,
    LINTER_BINARY_NAME
  );
  await fs.promises.rename(extractedBinaryPath, finalBinaryPath);

  await fs.promises.unlink(downloadPath); // Clean up archive
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

  const assetName = `csvlinter-${platform}-${targetArch}.tar.gz`;

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
