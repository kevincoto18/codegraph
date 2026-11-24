/**
 * Removes hidden files and functions from the graph before it is laid out:
 * test files, private functions, hidden folders and exclude patterns.
 */
import type { GraphEdge, GraphNode, GraphSnapshot, NodeFilters, RelPath } from '../shared';

/** Folder names whose files are always tests. */
const TEST_FOLDERS: ReadonlySet<string> = new Set(['__tests__', '__mocks__', 'test', 'tests']);

/** File names of tests: `*.test.ts`, `*.spec.js`, `test_x.py`, `x_test.py`, `conftest.py`. */
const TEST_FILE_PATTERN = /(\.(test|spec)\.[^./]+|^test_[^/]*\.py|_test\.py|^conftest\.py)$/i;

/** Result of {@link applyNodeFilters}. */
export interface NodeFilterResult {
  /** Graph without the hidden files and functions (the input itself when nothing is hidden). */
  readonly snapshot: GraphSnapshot;
  /** Number of files removed. */
  readonly hiddenFiles: number;
  /** Number of functions removed (including those of removed files). */
  readonly hiddenFunctions: number;
}

/** A folder of the workspace, for the folder filter list. */
export interface FolderEntry {
  /** Workspace-relative folder path. */
  readonly path: RelPath;
  /** Last path segment. */
  readonly name: string;
  /** Nesting level (0 for top-level folders). */
  readonly depth: number;
  /** Files inside the folder, including subfolders. */
  readonly fileCount: number;
}

/**
 * Tells whether a file is a test, by its name or by a folder it lives in.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns `true` for test files.
 */
export function isTestFile(filePath: RelPath): boolean {
  const segments = filePath.split('/');
  const fileName = segments.pop() ?? '';
  return TEST_FILE_PATTERN.test(fileName) || segments.some((segment) => TEST_FOLDERS.has(segment));
}

/**
 * Escapes the characters of a literal text that have a meaning in a regular expression.
 *
 * @param text - Literal text.
 * @returns The escaped text.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

/**
 * Converts the body of a glob (no anchoring) into a regular expression source.
 * Supports `**`, `*`, `?` and `{a,b}`.
 *
 * @param glob - Glob text.
 * @returns The regular expression source.
 */
function globToSource(glob: string): string {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob.charAt(index);
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      source += '.*';
      index += 2;
    } else if (char === '*') {
      source += '[^/]*';
      index += 1;
    } else if (char === '?') {
      source += '[^/]';
      index += 1;
    } else if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end === -1) {
        source += '\\{';
        index += 1;
      } else {
        const options = glob.slice(index + 1, end).split(',');
        source += `(?:${options.map(globToSource).join('|')})`;
        index = end + 1;
      }
    } else {
      source += escapeRegExp(char);
      index += 1;
    }
  }
  return source;
}

/**
 * Compiles an exclude pattern into a matcher of workspace-relative paths.
 *
 * A pattern without `/` matches a file or folder name at any depth
 * (`*.gen.ts`, `generated`); a pattern with `/` is matched from the
 * workspace root (`src/legacy`, `src/**\/fixtures`). Matching a folder hides
 * everything inside it.
 *
 * @param pattern - Glob pattern written by the user.
 * @returns The regular expression, or `null` for a blank pattern.
 */
export function compileExcludePattern(pattern: string): RegExp | null {
  let glob = pattern.trim().replace(/^\.?\//, '');
  while (glob.endsWith('/')) {
    glob = glob.slice(0, -1);
  }
  if (glob === '') {
    return null;
  }
  const prefix = glob.includes('/') ? '^' : '^(?:.*/)?';
  return new RegExp(`${prefix}${globToSource(glob)}(?:/.*)?$`);
}

/**
 * Tells whether filters hide something.
 *
 * @param filters - Node filters.
 * @returns `true` if at least one filter is active.
 */
export function hasActiveNodeFilters(filters: NodeFilters): boolean {
  return countActiveNodeFilters(filters) > 0;
}

/**
 * Counts the active filters (each hidden folder and pattern counts as one).
 *
 * @param filters - Node filters.
 * @returns Number of active filters, shown as a badge.
 */
export function countActiveNodeFilters(filters: NodeFilters): number {
  return (
    (filters.hideTests ? 1 : 0) +
    (filters.exportedOnly ? 1 : 0) +
    filters.hiddenFolders.length +
    filters.excludePatterns.length
  );
}

/**
 * Builds the predicate that decides whether a file is hidden.
 *
 * @param filters - Node filters.
 * @returns A function returning `true` for hidden file paths.
 */
function createFileHider(filters: NodeFilters): (filePath: RelPath) => boolean {
  const folderPrefixes = filters.hiddenFolders.map((folder) => `${folder}/`);
  const patterns = filters.excludePatterns
    .map(compileExcludePattern)
    .filter((pattern): pattern is RegExp => pattern !== null);
  return (filePath) =>
    (filters.hideTests && isTestFile(filePath)) ||
    folderPrefixes.some((prefix) => filePath.startsWith(prefix)) ||
    patterns.some((pattern) => pattern.test(filePath));
}

/**
 * Removes the files and functions hidden by the filters, with every edge
 * that touches them. Files keep only their visible functions.
 *
 * @param snapshot - Complete graph.
 * @param filters - Node filters.
 * @returns The filtered graph and how much was hidden.
 */
export function applyNodeFilters(snapshot: GraphSnapshot, filters: NodeFilters): NodeFilterResult {
  if (!hasActiveNodeFilters(filters)) {
    return { snapshot, hiddenFiles: 0, hiddenFunctions: 0 };
  }
  const isHiddenFile = createFileHider(filters);
  const hiddenFileIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'file' && isHiddenFile(node.filePath)) {
      hiddenFileIds.add(node.id);
    }
  }
  const hiddenIds = new Set<string>(hiddenFileIds);
  let hiddenFunctions = 0;
  for (const node of snapshot.nodes) {
    if (
      node.kind === 'function' &&
      (hiddenFileIds.has(node.fileId) || (filters.exportedOnly && !node.exported))
    ) {
      hiddenIds.add(node.id);
      hiddenFunctions += 1;
    }
  }
  if (hiddenIds.size === 0) {
    return { snapshot, hiddenFiles: 0, hiddenFunctions: 0 };
  }
  const nodes: GraphNode[] = [];
  for (const node of snapshot.nodes) {
    if (hiddenIds.has(node.id)) {
      continue;
    }
    if (node.kind === 'file' && node.functionIds.some((id) => hiddenIds.has(id))) {
      nodes.push({ ...node, functionIds: node.functionIds.filter((id) => !hiddenIds.has(id)) });
    } else {
      nodes.push(node);
    }
  }
  const edges: GraphEdge[] = snapshot.edges.filter(
    (edge) => !hiddenIds.has(edge.source) && !hiddenIds.has(edge.target),
  );
  return {
    snapshot: { version: snapshot.version, nodes, edges },
    hiddenFiles: hiddenFileIds.size,
    hiddenFunctions,
  };
}

/**
 * Lists every folder that contains files, parents before children, for the
 * folder filter.
 *
 * @param filePaths - Workspace-relative file paths.
 * @returns The folders sorted by path, with their recursive file counts.
 */
export function listFolders(filePaths: Iterable<RelPath>): FolderEntry[] {
  const counts = new Map<RelPath, number>();
  for (const filePath of filePaths) {
    const segments = filePath.split('/');
    segments.pop();
    for (let length = 1; length <= segments.length; length += 1) {
      const folder = segments.slice(0, length).join('/');
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, fileCount]) => {
      const segments = path.split('/');
      return {
        path,
        name: segments.at(-1) ?? path,
        depth: segments.length - 1,
        fileCount,
      };
    });
}

/**
 * Adds or removes a folder from the hidden folders. Hiding a folder drops
 * its hidden subfolders, which are redundant.
 *
 * @param hiddenFolders - Currently hidden folders.
 * @param folder - Folder to toggle.
 * @returns The new list.
 */
export function toggleHiddenFolder(hiddenFolders: readonly RelPath[], folder: RelPath): RelPath[] {
  if (hiddenFolders.includes(folder)) {
    return hiddenFolders.filter((item) => item !== folder);
  }
  const prefix = `${folder}/`;
  return [...hiddenFolders.filter((item) => !item.startsWith(prefix)), folder].sort();
}

/**
 * Tells whether a folder is hidden, directly or through a parent folder.
 *
 * @param hiddenFolders - Currently hidden folders.
 * @param folder - Folder to check.
 * @returns `'self'` when hidden directly, `'parent'` through a parent, otherwise `null`.
 */
export function folderHiddenState(
  hiddenFolders: readonly RelPath[],
  folder: RelPath,
): 'self' | 'parent' | null {
  if (hiddenFolders.includes(folder)) {
    return 'self';
  }
  return hiddenFolders.some((item) => folder.startsWith(`${item}/`)) ? 'parent' : null;
}
