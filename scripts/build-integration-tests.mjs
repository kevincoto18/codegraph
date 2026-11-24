// @ts-check
/**
 * Compiles the integration tests (`src/test/integration/*.test.ts`) to
 * `dist-test/integration`, where `.vscode-test.mjs` runs them inside VS Code.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import * as esbuild from 'esbuild';

/** Folder of the integration test sources. */
const SOURCE_DIRECTORY = join('src', 'test', 'integration');

const entryPoints = (await readdir(SOURCE_DIRECTORY))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => join(SOURCE_DIRECTORY, file));

await esbuild.build({
  entryPoints,
  outdir: join('dist-test', 'integration'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'info',
});
