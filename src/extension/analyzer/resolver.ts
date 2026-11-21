/**
 * Resolution of relative module specifiers against the set of known
 * workspace files. Performs no I/O.
 */
import { posix } from 'node:path';

import type { RelPath } from '../../shared';
import { SUPPORTED_EXTENSIONS } from './config';

/**
 * Maps a JavaScript extension written in a specifier to the TypeScript
 * extensions it may stand for (TS ESM convention: `import './a.js'` → `a.ts`).
 */
const JS_TO_TS_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
};

/**
 * Checks whether a module specifier is relative (`./x`, `../x`, `.`, `..`).
 *
 * @param specifier - Raw module specifier.
 * @returns `true` for relative specifiers; `false` for packages and aliases.
 */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

/**
 * Lists, in priority order, the file paths a resolved base path may refer to.
 *
 * @param basePath - Normalized workspace-relative path without guessing an extension.
 * @returns Candidate file paths: exact match, TS counterparts of a `.js`/`.jsx`
 *   specifier, the path plus each supported extension, then `index` files.
 */
export function buildCandidatePaths(basePath: RelPath): RelPath[] {
  const candidates: RelPath[] = [basePath];

  const writtenExtension = posix.extname(basePath);
  const tsCounterparts = JS_TO_TS_EXTENSIONS[writtenExtension] ?? [];
  const withoutExtension = basePath.slice(0, basePath.length - writtenExtension.length);
  candidates.push(...tsCounterparts.map((ext) => `${withoutExtension}${ext}`));

  candidates.push(...SUPPORTED_EXTENSIONS.map((ext) => `${basePath}${ext}`));
  candidates.push(...SUPPORTED_EXTENSIONS.map((ext) => `${basePath}/index${ext}`));
  return candidates;
}

/**
 * Resolves a relative import to a known workspace file.
 *
 * @param fromFile - Workspace-relative POSIX path of the importing file.
 * @param specifier - Raw module specifier written in the import.
 * @param knownFiles - Workspace-relative POSIX paths of every analyzable file.
 * @returns The imported file's path, or `null` if the specifier is not
 *   relative, points outside the workspace or matches no known file.
 */
export function resolveImport(
  fromFile: RelPath,
  specifier: string,
  knownFiles: ReadonlySet<RelPath>,
): RelPath | null {
  if (!isRelativeSpecifier(specifier)) {
    return null;
  }

  const basePath = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (basePath === '..' || basePath.startsWith('../')) {
    return null;
  }

  return buildCandidatePaths(basePath).find((candidate) => knownFiles.has(candidate)) ?? null;
}
