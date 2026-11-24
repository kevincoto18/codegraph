/**
 * Path prefixes of the workspace folders when several are open
 * (multi-root): each folder's files appear under a top-level folder named
 * after it, so one graph can show them all. Pure, so it is unit-tested.
 */
import type { RelPath } from '../shared';

/** Characters that cannot be part of a path segment. */
const INVALID_SEGMENT_CHARACTERS = /[/\\]+/g;

/**
 * Chooses the prefix of each workspace folder. A single folder has no prefix
 * (paths stay as they always were); several folders get their names, made
 * unique (`api`, `api-2`).
 *
 * @param names - Workspace folder names, in workspace order.
 * @returns One prefix per folder (empty for a single folder).
 */
export function assignRootPrefixes(names: readonly string[]): string[] {
  if (names.length <= 1) {
    return names.map(() => '');
  }
  const used = new Set<string>();
  return names.map((name, index) => {
    const base =
      name.replace(INVALID_SEGMENT_CHARACTERS, '-').trim() || `folder${String(index + 1)}`;
    let prefix = base;
    for (let suffix = 2; used.has(prefix); suffix += 1) {
      prefix = `${base}-${String(suffix)}`;
    }
    used.add(prefix);
    return prefix;
  });
}

/**
 * Adds a folder prefix to a folder-relative path.
 *
 * @param prefix - Folder prefix (empty for a single folder).
 * @param filePath - Path relative to the folder.
 * @returns The workspace path.
 */
export function addRootPrefix(prefix: string, filePath: RelPath): RelPath {
  return prefix === '' ? filePath : `${prefix}/${filePath}`;
}

/**
 * Finds the folder of a workspace path and the path inside it.
 *
 * @param filePath - Workspace path.
 * @param prefixes - Folder prefixes, as returned by {@link assignRootPrefixes}.
 * @returns The folder index and the folder-relative path, or `null` when no folder matches.
 */
export function splitRootPrefix(
  filePath: RelPath,
  prefixes: readonly string[],
): { readonly index: number; readonly path: RelPath } | null {
  if (prefixes.length === 1 && prefixes[0] === '') {
    return { index: 0, path: filePath };
  }
  const slash = filePath.indexOf('/');
  const head = slash === -1 ? filePath : filePath.slice(0, slash);
  const index = prefixes.indexOf(head);
  if (index === -1) {
    return null;
  }
  return { index, path: slash === -1 ? '' : filePath.slice(slash + 1) };
}

/** URI path of a Windows file (`/c:/...`), whose letter case does not matter. */
const WINDOWS_DRIVE_PATH = /^\/[a-zA-Z]:(\/|$)/;

/**
 * Path of a URI relative to a folder URI. Windows paths are compared without
 * regard to letter case (`/c:/Users/...` and `/C:/users/...` are the same
 * file), as file searches may report another casing than the workspace folder.
 *
 * @param rootPath - URI path of the folder.
 * @param path - URI path of a file or folder.
 * @returns The POSIX path relative to the folder, or `null` when the path is
 *   the folder itself or outside it.
 */
export function relativeUriPath(rootPath: string, path: string): string | null {
  const root = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
  const ignoreCase =
    WINDOWS_DRIVE_PATH.test(rootPath) &&
    WINDOWS_DRIVE_PATH.test(path) &&
    root.toLowerCase().length === root.length &&
    path.toLowerCase().length === path.length;
  const comparableRoot = ignoreCase ? root.toLowerCase() : root;
  const comparablePath = ignoreCase ? path.toLowerCase() : path;
  if (!comparablePath.startsWith(`${comparableRoot}/`)) {
    return null;
  }
  const relative = path.slice(root.length + 1).replace(/\/+$/, '');
  return relative === '' ? null : relative;
}

/**
 * Picks the folder that contains a path, preferring the deepest one when
 * folders are nested (a folder and one of its subfolders both opened).
 *
 * @param path - POSIX path of the file (URI path).
 * @param roots - POSIX paths of the workspace folders.
 * @returns The index of the containing folder, or `-1`.
 */
export function findContainingRoot(path: string, roots: readonly string[]): number {
  let best = -1;
  roots.forEach((root, index) => {
    if (
      relativeUriPath(root, path) !== null &&
      (best === -1 || root.length > (roots[best] ?? '').length)
    ) {
      best = index;
    }
  });
  return best;
}
