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

/** Namespace of the virtual module that loads the analyzer bundle. */
const ANALYSIS_LOADER_NAMESPACE = 'analysis-loader';

/**
 * Keeps the analyzer out of the main bundle. `import('./analysis')` is
 * resolved to a tiny virtual module that `require`s `dist/analysis.js` at
 * runtime, so the TypeScript compiler embedded in the analyzer is only parsed
 * when a graph is first opened. (A plain external `import()` would load the
 * CommonJS bundle without its named exports.)
 * @type {import('esbuild').Plugin}
 */
const externalAnalysisPlugin = {
  name: 'external-analysis',
  setup(build) {
    build.onResolve({ filter: /^\.\/analysis$/ }, () => ({
      path: 'analysis',
      namespace: ANALYSIS_LOADER_NAMESPACE,
    }));
    build.onLoad({ filter: /.*/, namespace: ANALYSIS_LOADER_NAMESPACE }, () => ({
      contents: "module.exports = require('./analysis.js');",
      loader: 'js',
    }));
    build.onResolve({ filter: /^\.\/analysis\.js$/ }, () => ({
      path: './analysis.js',
      external: true,
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const commonOptions = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...commonOptions,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'dist/extension.js',
    plugins: [externalAnalysisPlugin],
  },
  {
    ...commonOptions,
    entryPoints: ['src/extension/analysis.ts'],
    outfile: 'dist/analysis.js',
  },
  {
    ...commonOptions,
    entryPoints: ['src/extension/parseWorker.ts'],
    outfile: 'dist/parseWorker.js',
  },
];

/**
 * Runs one-off builds of both bundles or starts watch mode, depending on CLI flags.
 * @returns {Promise<void>}
 */
async function main() {
  if (isWatch) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
