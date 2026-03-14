import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

export interface LinterError {
  line: number;
  message: string;
}

export function parseLinterErrors(raw: string): LinterError[] {
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new SyntaxError('No JSON object found in output');
  }
  const json = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  const errors = json.errors ?? json.validation?.errors ?? json.results?.errors ?? [];
  return errors.map(
    (err: { line_number?: number; line?: number; message?: string; description?: string }) => {
      const lineNum = err.line_number ?? err.line ?? 1;
      const lineIdx = Math.max(lineNum - 1, 0);
      const message = err.message ?? err.description ?? JSON.stringify(err);
      return { line: lineIdx, message };
    }
  );
}

export function syntheticCsvFilename(fileName: string): string {
  const base = fileName || 'untitled.csv';
  return base.endsWith('.csv') ? base : `${base}.csv`;
}

export function isCsvFile(doc: { languageId: string; fileName: string }): boolean {
  return doc.languageId === 'csv' || doc.fileName.endsWith('.csv');
}

export function isOnDisk(scheme: string): boolean {
  return scheme === 'file';
}

export function shouldUseStdin(isOnDisk: boolean, textOverride: string | undefined): boolean {
  return !isOnDisk || textOverride !== undefined;
}

export interface BuildLintArgsOptions {
  useStdin: boolean;
  filePath: string;
  filenameForDiag: string;
  inferSchema: boolean;
}

export function buildLintArgs(options: BuildLintArgsOptions): string[] {
  const { useStdin, filePath, filenameForDiag, inferSchema } = options;
  return [
    'validate',
    '--format',
    'json',
    ...(inferSchema ? ['--infer-schema'] : []),
    ...(useStdin ? ['--filename', filenameForDiag, '-'] : [filePath]),
  ];
}

export type LinterInterpretResult =
  | { kind: 'fatal' }
  | { kind: 'empty' }
  | { kind: 'parse_error'; message: string }
  | { kind: 'diagnostics'; errors: LinterError[] };

export function interpretLinterOutput(
  code: number | null,
  stdout: string,
  stderr: string
): LinterInterpretResult {
  if (code !== null && code > 1) {
    return { kind: 'fatal' };
  }
  const raw = stdout.trim() || stderr.trim();
  if (!raw) {
    return { kind: 'empty' };
  }
  try {
    const errors = parseLinterErrors(raw);
    return { kind: 'diagnostics', errors };
  } catch {
    const message = stderr.trim() || raw;
    return { kind: 'parse_error', message };
  }
}

export interface LinterCloseHandlers {
  onFatal: (code: number | null) => void;
  onEmpty: () => void;
  onParseError: (message: string) => void;
  onDiagnostics: (errors: LinterError[]) => void;
}

export function handleLinterClose(
  code: number | null,
  stdout: string,
  stderr: string,
  handlers: LinterCloseHandlers
): void {
  const result = interpretLinterOutput(code, stdout, stderr);
  if (result.kind === 'fatal') {
    handlers.onFatal(code);
    return;
  }
  if (result.kind === 'empty') {
    handlers.onEmpty();
    return;
  }
  if (result.kind === 'parse_error') {
    handlers.onParseError(result.message);
    return;
  }
  handlers.onDiagnostics(result.errors);
}

export function getReleaseAssetName(platform: string, arch: string): string | null {
  const goArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (goArch === null) {
    return null;
  }
  const targetPlatform = platform === 'win32' ? 'windows' : platform;
  return `csvlinter-${targetPlatform}-${goArch}.tar.gz`;
}

export function parseReleaseAssetUrl(data: string, assetName: string): string | null {
  const releaseInfo = JSON.parse(data);
  const asset = releaseInfo.assets?.find((a: { name: string }) => a.name === assetName);
  return asset?.browser_download_url ?? null;
}

const USER_AGENT = 'vscode-csvlinter-extension';

export function getReleaseAssetUrl(apiUrl: string, assetName: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const handleResponse = (data: string) => {
      try {
        resolve(parseReleaseAssetUrl(data, assetName));
      } catch {
        reject(new Error('Failed to parse release API response'));
      }
    };

    const request = (url: string) => {
      const req = https.get(
        url,
        { headers: { 'User-Agent': USER_AGENT } },
        (res: import('http').IncomingMessage) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            const location = res.headers.location;
            if (location) {
              request(location);
              return;
            }
            reject(new Error('Redirect without location for release API'));
            return;
          }
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => handleResponse(data));
        }
      );
      req.on('error', (err: Error) =>
        reject(new Error(`Failed to fetch releases: ${err.message}`))
      );
    };

    request(apiUrl);
  });
}

export function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(
        url,
        {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
        },
        (response: import('http').IncomingMessage) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            const location = response.headers.location;
            if (location) {
              downloadFile(location, dest).then(resolve).catch(reject);
              return;
            }
            reject(new Error('Redirect with no location header'));
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status code ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        }
      )
      .on('error', (err: Error) => {
        fs.unlink(dest, () => {});
        reject(new Error(err.message));
      });
  });
}

export function fileExists(filepath: string): Promise<boolean> {
  return fs.promises
    .access(path.resolve(filepath), fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export function truncateForLog(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

export function getLinterBinaryName(platform: string): string {
  return platform === 'win32' ? 'csvlinter.exe' : 'csvlinter';
}

export function getLinterBinaryPath(storageDir: string, binaryName: string): string {
  return path.join(storageDir, binaryName);
}

export interface GetLinterPathOptions {
  storageDir: string;
  binaryName: string;
  fileExists: (filepath: string) => Promise<boolean>;
  ensureDownloaded: (binaryPath: string) => Promise<void>;
  onFoundExisting?: (binaryPath: string) => void;
}

export async function getLinterPath(options: GetLinterPathOptions): Promise<string | null> {
  const { storageDir, binaryName, fileExists, ensureDownloaded, onFoundExisting } = options;
  const binaryPath = getLinterBinaryPath(storageDir, binaryName);
  if (await fileExists(binaryPath)) {
    onFoundExisting?.(binaryPath);
    return binaryPath;
  }
  try {
    await ensureDownloaded(binaryPath);
    return binaryPath;
  } catch {
    return null;
  }
}
