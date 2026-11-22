/**
 * Entry point of the analyzer bundle (`dist/analysis.js`).
 *
 * @remarks The analyzer embeds the TypeScript compiler (~10 MB of
 * JavaScript). It is built as a separate bundle and loaded with a dynamic
 * `import()` the first time a graph is opened, so VS Code does not even parse
 * it when the extension activates.
 */
import { join } from 'node:path';

import { parseSource } from './analyzer/parser';
import type { ParsePool } from './parsePool';
import { createParsePool } from './parsePool';

export { ANALYSIS_CACHE_KEY, GraphService } from './graphService';

/** File name of the parser worker bundle, next to this bundle in `dist/`. */
const PARSE_WORKER_FILE = 'parseWorker.js';

/**
 * Creates a worker pool sized for this machine, running the parser worker
 * bundle that sits next to the analyzer bundle.
 *
 * @returns The pool, or `null` on single-core machines.
 */
export function createDefaultParsePool(): ParsePool | null {
  return createParsePool(join(__dirname, PARSE_WORKER_FILE), parseSource);
}
