// @ts-check
/**
 * Build script for the extension host bundle (`dist/extension.js`).
 *
 * Flags:
 *   --watch       Rebuild on file changes.
 *   --production  Minify and drop source maps.
 */
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Tree-sitter engine and grammars copied next to the analyzer bundles. */
const GRAMMAR_FILES = ['tree-sitter.wasm', 'tree-sitter-python.wasm'];

/** Folder of the prebuilt grammars in `@vscode/tree-sitter-wasm`. */
const GRAMMAR_SOURCE = join('node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');

/**
 * Copies the Tree-sitter `.wasm` files to `dist/grammars`.
 * @returns {Promise<void>}
 */
async function copyGrammars() {
  const missing = GRAMMAR_FILES.filter((file) => !existsSync(join(GRAMMAR_SOURCE, file)));
  if (missing.length > 0) {
    throw new Error(
      `Tree-sitter grammars not found (${missing.join(', ')}) in ${GRAMMAR_SOURCE}. Run "npm install" to install @vscode/tree-sitter-wasm.`,
    );
  }
  await mkdir(join('dist', 'grammars'), { recursive: true });
  await Promise.all(
    GRAMMAR_FILES.map((file) =>
      copyFile(join(GRAMMAR_SOURCE, file), join('dist', 'grammars', file)),
    ),
  );
}

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
    await copyGrammars();
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    return;
  }
  await Promise.all([...builds.map((options) => esbuild.build(options)), copyGrammars()]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
