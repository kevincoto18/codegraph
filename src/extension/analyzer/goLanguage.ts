/**
 * Definition of the Go language (without its parser, which lives in
 * `goParser.ts`). A Go package is a folder: files of the same folder see each
 * other, and an import path is matched to a workspace folder by its suffix.
 */
import type { LanguageDefinition } from './language';

/**
 * First segments of standard-library import paths that could otherwise match
 * a workspace folder (`net/http` and an `http` folder).
 */
const STANDARD_LIBRARY_ROOTS: ReadonlySet<string> = new Set([
  'archive',
  'bufio',
  'bytes',
  'cmp',
  'compress',
  'container',
  'context',
  'crypto',
  'database',
  'debug',
  'embed',
  'encoding',
  'errors',
  'expvar',
  'flag',
  'fmt',
  'go',
  'hash',
  'html',
  'image',
  'index',
  'io',
  'iter',
  'log',
  'maps',
  'math',
  'mime',
  'net',
  'os',
  'path',
  'plugin',
  'reflect',
  'regexp',
  'runtime',
  'slices',
  'sort',
  'strconv',
  'strings',
  'sync',
  'syscall',
  'testing',
  'text',
  'time',
  'unicode',
  'unique',
  'unsafe',
]);

/**
 * Finds the workspace folder an import path refers to: the longest folder
 * that the path ends with (`example.com/app/internal/db` → `internal/db`).
 * Standard-library paths are never matched.
 *
 * @param specifier - Import path as written.
 * @param packages - Folders that contain Go files.
 * @returns The folder, or `null` for external packages.
 */
export function resolveGoPackage(specifier: string, packages: ReadonlySet<string>): string | null {
  const first = specifier.split('/')[0] ?? '';
  if (!first.includes('.') && STANDARD_LIBRARY_ROOTS.has(first)) {
    return null;
  }
  let best: string | null = null;
  for (const folder of packages) {
    if (folder === '' || (specifier !== folder && !specifier.endsWith(`/${folder}`))) {
      continue;
    }
    if (best === null || folder.length > best.length) {
      best = folder;
    }
  }
  return best;
}

/** Go: `.go` files. */
export const GO_LANGUAGE: LanguageDefinition = {
  id: 'go',
  displayName: 'Go',
  extensions: ['.go'],
  version: 1,
  listImportCandidates: () => [],
  resolvePackage: resolveGoPackage,
};
