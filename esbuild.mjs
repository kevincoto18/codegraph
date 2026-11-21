// @ts-check
/**
 * Build script for the extension host bundle (`dist/extension.js`).
 *
 * Flags:
 *   --watch       Rebuild on file changes.
 *   --production  Minify and drop source maps.
 */
import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

/**
 * Runs a one-off build or starts watch mode depending on CLI flags.
 * @returns {Promise<void>}
 */
async function main() {
  if (isWatch) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }
  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
