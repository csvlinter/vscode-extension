import * as assert from 'assert';
import * as path from 'path';
import {
  parseLinterErrors,
  syntheticCsvFilename,
  isCsvFile,
  getReleaseAssetName,
  parseReleaseAssetUrl,
  shouldUseStdin,
  buildLintArgs,
  interpretLinterOutput,
  handleLinterClose,
  truncateForLog,
  getLinterBinaryName,
  getLinterBinaryPath,
  getLinterPath,
} from './utils';

suite('utils', () => {
  suite('parseLinterErrors', () => {
    test('extracts errors from top-level errors array', () => {
      const raw = `{"errors":[{"line_number":2,"message":"bad"}]}`;
      const result = parseLinterErrors(raw);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].line, 1);
      assert.strictEqual(result[0].message, 'bad');
    });

    test('extracts from validation.errors', () => {
      const raw = `{"validation":{"errors":[{"line":3,"message":"x"}]}}`;
      const result = parseLinterErrors(raw);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].line, 2);
      assert.strictEqual(result[0].message, 'x');
    });

    test('extracts from results.errors', () => {
      const raw = `{"results":{"errors":[{"line_number":1,"description":"d"}]}}`;
      const result = parseLinterErrors(raw);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].line, 0);
      assert.strictEqual(result[0].message, 'd');
    });

    test('uses first {...} block when output has prefix', () => {
      const raw = `some banner\n{"errors":[{"line_number":1,"message":"err"}]}`;
      const result = parseLinterErrors(raw);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].message, 'err');
    });

    test('line index is never negative', () => {
      const raw = `{"errors":[{"line_number":0,"message":"z"}]}`;
      const result = parseLinterErrors(raw);
      assert.strictEqual(result[0].line, 0);
    });

    test('falls back to description when message missing', () => {
      const raw = `{"errors":[{"line_number":1,"description":"desc"}]}`;
      const result = parseLinterErrors(raw);
      assert.strictEqual(result[0].message, 'desc');
    });

    test('returns empty array when no errors key', () => {
      const raw = `{"other":[]}`;
      const result = parseLinterErrors(raw);
      assert.deepStrictEqual(result, []);
    });

    test('throws when no JSON object in output', () => {
      assert.throws(() => parseLinterErrors('no braces here'), /No JSON object found/);
    });

    test('throws on invalid JSON', () => {
      assert.throws(() => parseLinterErrors('{ invalid }'), SyntaxError);
    });
  });

  suite('syntheticCsvFilename', () => {
    test('returns name unchanged when already ending in .csv', () => {
      assert.strictEqual(syntheticCsvFilename('file.csv'), 'file.csv');
    });

    test('appends .csv when extension missing', () => {
      assert.strictEqual(syntheticCsvFilename('file'), 'file.csv');
    });

    test('uses untitled.csv for empty string', () => {
      assert.strictEqual(syntheticCsvFilename(''), 'untitled.csv');
    });
  });

  suite('isCsvFile', () => {
    test('true when languageId is csv', () => {
      assert.strictEqual(isCsvFile({ languageId: 'csv', fileName: 'foo.txt' }), true);
    });

    test('true when fileName ends with .csv', () => {
      assert.strictEqual(isCsvFile({ languageId: 'plaintext', fileName: 'data.csv' }), true);
    });

    test('false when neither', () => {
      assert.strictEqual(isCsvFile({ languageId: 'plaintext', fileName: 'data.txt' }), false);
    });
  });

  suite('getReleaseAssetName', () => {
    test('returns darwin-amd64 for darwin x64', () => {
      assert.strictEqual(getReleaseAssetName('darwin', 'x64'), 'csvlinter-darwin-amd64.tar.gz');
    });

    test('returns darwin-arm64 for darwin arm64', () => {
      assert.strictEqual(getReleaseAssetName('darwin', 'arm64'), 'csvlinter-darwin-arm64.tar.gz');
    });

    test('returns windows-amd64 for win32 x64', () => {
      assert.strictEqual(getReleaseAssetName('win32', 'x64'), 'csvlinter-windows-amd64.tar.gz');
    });

    test('returns null for unsupported arch', () => {
      assert.strictEqual(getReleaseAssetName('darwin', 'ia32'), null);
    });
  });

  suite('shouldUseStdin', () => {
    test('true when not on disk', () => {
      assert.strictEqual(shouldUseStdin(false, undefined), true);
    });
    test('true when text override provided even on disk', () => {
      assert.strictEqual(shouldUseStdin(true, 'a,b'), true);
    });
    test('false when on disk and no text override', () => {
      assert.strictEqual(shouldUseStdin(true, undefined), false);
    });
  });

  suite('buildLintArgs', () => {
    test('file path when useStdin false', () => {
      const args = buildLintArgs({
        useStdin: false,
        filePath: '/path/to/file.csv',
        filenameForDiag: 'file.csv',
        inferSchema: false,
      });
      assert.deepStrictEqual(args, ['validate', '--format', 'json', '/path/to/file.csv']);
    });
    test('stdin and filename when useStdin true', () => {
      const args = buildLintArgs({
        useStdin: true,
        filePath: '/path/to/file.csv',
        filenameForDiag: 'untitled.csv',
        inferSchema: false,
      });
      assert.deepStrictEqual(args, [
        'validate',
        '--format',
        'json',
        '--filename',
        'untitled.csv',
        '-',
      ]);
    });
    test('includes --infer-schema when inferSchema true', () => {
      const args = buildLintArgs({
        useStdin: false,
        filePath: '/x.csv',
        filenameForDiag: 'x.csv',
        inferSchema: true,
      });
      assert.deepStrictEqual(args, ['validate', '--format', 'json', '--infer-schema', '/x.csv']);
    });
  });

  suite('interpretLinterOutput', () => {
    test('fatal when code > 1', () => {
      const r = interpretLinterOutput(2, '', '');
      assert.strictEqual(r.kind, 'fatal');
    });
    test('empty when no stdout or stderr', () => {
      const r = interpretLinterOutput(0, '', '');
      assert.strictEqual(r.kind, 'empty');
    });
    test('empty when code null and no output', () => {
      const r = interpretLinterOutput(null, '  ', '');
      assert.strictEqual(r.kind, 'empty');
    });
    test('diagnostics when valid JSON errors', () => {
      const raw = '{"errors":[{"line_number":1,"message":"bad"}]}';
      const r = interpretLinterOutput(0, raw, '');
      assert.strictEqual(r.kind, 'diagnostics');
      if (r.kind === 'diagnostics') {
        assert.strictEqual(r.errors.length, 1);
        assert.strictEqual(r.errors[0].line, 0);
        assert.strictEqual(r.errors[0].message, 'bad');
      }
    });
    test('uses stderr when stdout empty', () => {
      const raw = '{"errors":[{"line_number":2,"message":"x"}]}';
      const r = interpretLinterOutput(0, '', raw);
      assert.strictEqual(r.kind, 'diagnostics');
      if (r.kind === 'diagnostics') {
        assert.strictEqual(r.errors[0].line, 1);
        assert.strictEqual(r.errors[0].message, 'x');
      }
    });
    test('parse_error when JSON invalid', () => {
      const r = interpretLinterOutput(0, 'not json', '');
      assert.strictEqual(r.kind, 'parse_error');
      if (r.kind === 'parse_error') {
        assert.strictEqual(r.message, 'not json');
      }
    });
    test('parse_error uses stderr when present', () => {
      const r = interpretLinterOutput(0, 'x', 'error from linter');
      assert.strictEqual(r.kind, 'parse_error');
      if (r.kind === 'parse_error') {
        assert.strictEqual(r.message, 'error from linter');
      }
    });
    test('exit code 1 still returns diagnostics', () => {
      const raw = '{"errors":[{"line_number":1,"message":"err"}]}';
      const r = interpretLinterOutput(1, raw, '');
      assert.strictEqual(r.kind, 'diagnostics');
    });
  });

  suite('handleLinterClose', () => {
    test('calls onFatal when code > 1', () => {
      let called: number | null = null;
      handleLinterClose(2, '', '', {
        onFatal: (c) => (called = c),
        onEmpty: () => assert.fail('onEmpty'),
        onParseError: () => assert.fail('onParseError'),
        onDiagnostics: () => assert.fail('onDiagnostics'),
      });
      assert.strictEqual(called, 2);
    });

    test('calls onEmpty when no output', () => {
      let emptyCalled = false;
      handleLinterClose(0, '', '', {
        onFatal: () => assert.fail('onFatal'),
        onEmpty: () => (emptyCalled = true),
        onParseError: () => assert.fail('onParseError'),
        onDiagnostics: () => assert.fail('onDiagnostics'),
      });
      assert.strictEqual(emptyCalled, true);
    });

    test('calls onParseError when JSON invalid', () => {
      let message = '';
      handleLinterClose(0, 'not json', '', {
        onFatal: () => assert.fail('onFatal'),
        onEmpty: () => assert.fail('onEmpty'),
        onParseError: (m) => (message = m),
        onDiagnostics: () => assert.fail('onDiagnostics'),
      });
      assert.strictEqual(message, 'not json');
    });

    test('calls onDiagnostics with parsed errors', () => {
      const raw = '{"errors":[{"line_number":1,"message":"bad"}]}';
      let errors: { line: number; message: string }[] = [];
      handleLinterClose(0, raw, '', {
        onFatal: () => assert.fail('onFatal'),
        onEmpty: () => assert.fail('onEmpty'),
        onParseError: () => assert.fail('onParseError'),
        onDiagnostics: (e) => (errors = e),
      });
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].line, 0);
      assert.strictEqual(errors[0].message, 'bad');
    });
  });

  suite('truncateForLog', () => {
    test('returns string unchanged when within maxLen', () => {
      assert.strictEqual(truncateForLog('abc', 5), 'abc');
      assert.strictEqual(truncateForLog('', 200), '');
    });
    test('truncates and appends ... when over maxLen', () => {
      assert.strictEqual(truncateForLog('abcdef', 3), 'abc...');
      assert.strictEqual(truncateForLog('x'.repeat(300), 200), 'x'.repeat(200) + '...');
    });
  });

  suite('getLinterBinaryName', () => {
    test('returns csvlinter.exe for win32', () => {
      assert.strictEqual(getLinterBinaryName('win32'), 'csvlinter.exe');
    });
    test('returns csvlinter for darwin', () => {
      assert.strictEqual(getLinterBinaryName('darwin'), 'csvlinter');
    });
    test('returns csvlinter for linux', () => {
      assert.strictEqual(getLinterBinaryName('linux'), 'csvlinter');
    });
  });

  suite('getLinterBinaryPath', () => {
    test('joins storage dir and binary name', () => {
      assert.strictEqual(
        getLinterBinaryPath('/tmp/storage', 'csvlinter'),
        '/tmp/storage/csvlinter'
      );
    });
    test('handles path segments (platform-agnostic)', () => {
      const dir = path.join('C:', 'Users', 'x', 'storage');
      const result = getLinterBinaryPath(dir, 'csvlinter.exe');
      assert.strictEqual(result, path.join(dir, 'csvlinter.exe'));
    });
  });

  suite('getLinterPath', () => {
    test('returns path when file already exists', async () => {
      const storageDir = '/tmp/csvlinter-storage';
      const binaryName = 'csvlinter';
      const pathReturned = await getLinterPath({
        storageDir,
        binaryName,
        fileExists: async (p) => p === '/tmp/csvlinter-storage/csvlinter',
        ensureDownloaded: () => assert.fail('should not download'),
      });
      assert.strictEqual(pathReturned, '/tmp/csvlinter-storage/csvlinter');
    });

    test('calls onFoundExisting when file exists', async () => {
      let calledWith = '';
      await getLinterPath({
        storageDir: '/storage',
        binaryName: 'csvlinter',
        fileExists: async () => true,
        ensureDownloaded: () => assert.fail('should not download'),
        onFoundExisting: (p) => (calledWith = p),
      });
      assert.strictEqual(calledWith, '/storage/csvlinter');
    });

    test('calls ensureDownloaded and returns path when file missing', async () => {
      let ensureDownloadedCalled = false;
      const pathReturned = await getLinterPath({
        storageDir: '/storage',
        binaryName: 'csvlinter',
        fileExists: async () => false,
        ensureDownloaded: async (binaryPath) => {
          ensureDownloadedCalled = true;
          assert.strictEqual(binaryPath, '/storage/csvlinter');
        },
      });
      assert.strictEqual(ensureDownloadedCalled, true);
      assert.strictEqual(pathReturned, '/storage/csvlinter');
    });

    test('returns null when ensureDownloaded throws', async () => {
      const pathReturned = await getLinterPath({
        storageDir: '/storage',
        binaryName: 'csvlinter',
        fileExists: async () => false,
        ensureDownloaded: async () => {
          throw new Error('Download failed');
        },
      });
      assert.strictEqual(pathReturned, null);
    });

    test('does not call onFoundExisting when downloading', async () => {
      let onFoundExistingCalled = false;
      await getLinterPath({
        storageDir: '/storage',
        binaryName: 'csvlinter',
        fileExists: async () => false,
        ensureDownloaded: async () => {},
        onFoundExisting: () => (onFoundExistingCalled = true),
      });
      assert.strictEqual(onFoundExistingCalled, false);
    });
  });

  suite('parseReleaseAssetUrl', () => {
    test('returns download URL when asset found', () => {
      const data = JSON.stringify({
        assets: [
          {
            name: 'csvlinter-darwin-amd64.tar.gz',
            browser_download_url: 'https://example.com/x.tar.gz',
          },
        ],
      });
      assert.strictEqual(
        parseReleaseAssetUrl(data, 'csvlinter-darwin-amd64.tar.gz'),
        'https://example.com/x.tar.gz'
      );
    });

    test('returns null when asset name not found', () => {
      const data = JSON.stringify({ assets: [] });
      assert.strictEqual(parseReleaseAssetUrl(data, 'missing.tar.gz'), null);
    });

    test('returns null when assets missing', () => {
      assert.strictEqual(parseReleaseAssetUrl('{}', 'any.tar.gz'), null);
    });

    test('throws on invalid JSON', () => {
      assert.throws(() => parseReleaseAssetUrl('not json', 'x.tar.gz'), SyntaxError);
    });
  });
});
