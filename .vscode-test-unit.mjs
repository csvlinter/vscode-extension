import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@vscode/test-cli';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  files: 'out/utils.test.js',
  mocha: {
    timeout: 5_000,
  },
});
