// @ts-check
/**
 * Integration tests run in a real VS Code window by `@vscode/test-cli`
 * (`npm run test:integration`): it downloads VS Code once into `.vscode-test/`,
 * opens each workspace with the built extension and runs the compiled tests.
 */
import { defineConfig } from '@vscode/test-cli';

/** Options shared by every run. */
const mocha = { ui: 'tdd', timeout: 120_000 };

export default defineConfig([
  {
    label: 'single-folder',
    files: 'dist-test/integration/singleFolder.test.js',
    workspaceFolder: './samples/demo-project',
    mocha,
  },
  {
    label: 'multi-root',
    files: 'dist-test/integration/multiRoot.test.js',
    workspaceFolder: './src/test/fixtures/multi-root.code-workspace',
    mocha,
  },
]);
