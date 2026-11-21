// @ts-check
/**
 * Runs a TypeScript script from `scripts/`: bundles it with esbuild (same
 * toolchain as the extension, no extra runtime) and executes it with Node.
 *
 * Usage: node scripts/run.mjs <entry.ts> [...args]
 */
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

import * as esbuild from 'esbuild';

const [entry, ...args] = process.argv.slice(2);
if (entry === undefined) {
  console.error('Usage: node scripts/run.mjs <entry.ts> [...args]');
  process.exit(1);
}

const outfile = join(
  'node_modules',
  '.cache',
  'codegraph-scripts',
  `${basename(entry, '.ts')}.cjs`,
);

await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  // Resolved at runtime from node_modules (dynamic requires / optional binary).
  external: ['playwright-core'],
  logLevel: 'warning',
});

// --expose-gc lets the stress test measure retained memory after a forced GC.
const result = spawnSync(
  process.execPath,
  ['--expose-gc', '--enable-source-maps', '--max-old-space-size=8192', outfile, ...args],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
