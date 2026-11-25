/**
 * Folder hierarchy of the graph: folders become nested containers of files,
 * so large projects can be explored level by level.
 */
import type { FolderViewMode, GraphNode, RelPath } from '../shared';
import { getLanguageBadge } from './languageBadge';

/** Prefix of folder node ids (file ids are plain paths, so they never clash). */
export const FOLDER_ID_PREFIX = 'folder:';

/** In `auto` mode, the folder view is used above this many files. */
export const AUTO_FOLDER_VIEW_FILE_THRESHOLD = 300;

/** One folder of the hierarchy. */
export interface FolderInfo {
  readonly id: string;
  /** Workspace-relative POSIX path of the folder. */
  readonly path: RelPath;
  /**
   * Displayed name, relative to the parent folder. Chains of folders without
   * files are compacted into one (`src/extension/analyzer`), like VS Code's
   * compact folders.
   */
  readonly label: string;
  /** Id of the parent folder, or `null` at the top level. */
  readonly parentId: string | null;
  /** Direct sub-folders, sorted by label. */
  readonly folderIds: readonly string[];
  /** Direct files, in graph order. */
  readonly fileIds: readonly string[];
  /** Number of files in the folder and all its sub-folders. */
  readonly fileCount: number;
  /** Workspace folder that contains this folder (multi-root), or `null` with one folder. */
  readonly workspaceRoot: string | null;
  /** Whether this folder is a workspace folder itself (multi-root top level). */
  readonly isWorkspaceRoot: boolean;
  /** Languages of a workspace folder's files (`TS`, `PY`…), most used first; empty for other folders. */
  readonly languages: readonly string[];
}

/** Folder hierarchy of a graph. */
export interface FolderTree {
  readonly folders: ReadonlyMap<string, FolderInfo>;
  /** Top-level folders, sorted by label. */
  readonly rootFolderIds: readonly string[];
  /** Files at the workspace root, in graph order. */
  readonly rootFileIds: readonly string[];
  /** Folder that directly contains each file (files at the root are absent). */
  readonly folderOfFile: ReadonlyMap<string, string>;
  /** Workspace folder names when several are open (multi-root); empty otherwise. */
  readonly workspaceRoots: readonly string[];
}

/** Raw folder before compaction. */
interface RawFolder {
  readonly folders: Set<RelPath>;
  readonly fileIds: string[];
}

/**
 * Formats a workspace path for display: in a multi-root workspace the
 * workspace folder is set apart (`api › src/app.ts`).
 *
 * @param path - Workspace path.
 * @param workspaceRoots - Workspace folder names (empty with one folder).
 * @returns The display path.
 */
export function formatWorkspacePath(path: RelPath, workspaceRoots: readonly string[]): string {
  const separator = path.indexOf('/');
  const root = separator === -1 ? path : path.slice(0, separator);
  if (workspaceRoots.length < 2 || !workspaceRoots.includes(root) || separator === -1) {
    return path;
  }
  return `${root} › ${path.slice(separator + 1)}`;
}

/**
 * Builds the id of a folder node.
 *
 * @param path - Workspace-relative folder path.
 * @returns The folder id.
 */
export function createFolderId(path: RelPath): string {
  return `${FOLDER_ID_PREFIX}${path}`;
}

/**
 * Checks whether a node id belongs to a folder.
 *
 * @param id - Node id.
 * @returns `true` for folder ids.
 */
export function isFolderId(id: string): boolean {
  return id.startsWith(FOLDER_ID_PREFIX);
}

/**
 * Decides whether the graph is shown by folders.
 *
 * @param mode - `always`, `never`, or `auto` (only for large graphs).
 * @param fileCount - Number of files in the graph.
 * @param threshold - File count above which `auto` enables the folder view.
 * @returns `true` if folders are rendered.
 */
export function isFolderViewEnabled(
  mode: FolderViewMode,
  fileCount: number,
  threshold: number = AUTO_FOLDER_VIEW_FILE_THRESHOLD,
): boolean {
  return mode === 'always' || (mode === 'auto' && fileCount > threshold);
}

/**
 * Returns the parent path of a workspace-relative path.
 *
 * @param path - File or folder path.
 * @returns The parent folder (`''` for the root).
 */
function parentPath(path: RelPath): RelPath {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? '' : path.slice(0, separator);
}

/** Badge labels grouped under one language in a workspace folder summary. */
const SUMMARY_LANGUAGE: Readonly<Record<string, string>> = { TSX: 'TS', JSX: 'JS' };

/**
 * Returns the first segment of a path.
 *
 * @param path - Workspace path.
 * @returns The top-level folder name (the whole path when it has no `/`).
 */
function firstSegment(path: RelPath): string {
  const separator = path.indexOf('/');
  return separator === -1 ? path : path.slice(0, separator);
}

/**
 * Lists the languages of each workspace folder, most used first.
 *
 * @param nodes - Graph nodes.
 * @param roots - Workspace folder names.
 * @returns Languages by workspace folder.
 */
function languagesByRoot(
  nodes: readonly GraphNode[],
  roots: ReadonlySet<string>,
): Map<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const node of nodes) {
    const root = firstSegment(node.filePath);
    if (node.kind !== 'file' || !roots.has(root)) {
      continue;
    }
    const badge = getLanguageBadge(node.filePath);
    if (badge.language === 'other') {
      continue;
    }
    const label = SUMMARY_LANGUAGE[badge.label] ?? badge.label;
    const perRoot = counts.get(root) ?? new Map<string, number>();
    perRoot.set(label, (perRoot.get(label) ?? 0) + 1);
    counts.set(root, perRoot);
  }
  return new Map(
    [...counts].map(([root, perRoot]) => [
      root,
      [...perRoot].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label]) => label),
    ]),
  );
}

/**
 * Builds the folder hierarchy of the file nodes of a graph.
 *
 * @param nodes - Graph nodes (only file nodes are used).
 * @param workspaceRoots - Workspace folder names when several are open: they
 *   are kept as their own top-level folders, never merged with a sub-folder.
 * @returns The folder tree.
 */
export function buildFolderTree(
  nodes: readonly GraphNode[],
  workspaceRoots: readonly string[] = [],
): FolderTree {
  const rootSet = new Set(workspaceRoots.length > 1 ? workspaceRoots : []);
  const languages = languagesByRoot(nodes, rootSet);
  const raw = new Map<RelPath, RawFolder>([['', { folders: new Set(), fileIds: [] }]]);
  /**
   * Returns the raw folder of a path, creating it and its ancestors.
   *
   * @param path - Folder path.
   * @returns The raw folder.
   */
  const ensure = (path: RelPath): RawFolder => {
    const existing = raw.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const created: RawFolder = { folders: new Set(), fileIds: [] };
    raw.set(path, created);
    ensure(parentPath(path)).folders.add(path);
    return created;
  };
  for (const node of nodes) {
    if (node.kind === 'file') {
      ensure(parentPath(node.filePath)).fileIds.push(node.id);
    }
  }

  const folders = new Map<string, FolderInfo>();
  const folderOfFile = new Map<string, string>();

  /**
   * Emits a folder (compacting chains of folders without files) and its
   * descendants.
   *
   * @param startPath - Path of the first folder of the chain.
   * @param parentId - Id of the emitted parent folder, or `null`.
   * @param parentEmittedPath - Path of the emitted parent (`''` at the top).
   * @returns The id of the emitted folder.
   */
  const emit = (
    startPath: RelPath,
    parentId: string | null,
    parentEmittedPath: RelPath,
  ): string => {
    let path = startPath;
    let folder = raw.get(path) ?? { folders: new Set<RelPath>(), fileIds: [] };
    while (!rootSet.has(path) && folder.fileIds.length === 0 && folder.folders.size === 1) {
      const [only] = folder.folders;
      if (only === undefined) {
        break;
      }
      path = only;
      folder = raw.get(path) ?? { folders: new Set<RelPath>(), fileIds: [] };
    }
    const id = createFolderId(path);
    const label = parentEmittedPath === '' ? path : path.slice(parentEmittedPath.length + 1);
    const childIds = sortedChildren(folder.folders).map((child) => emit(child, id, path));
    for (const fileId of folder.fileIds) {
      folderOfFile.set(fileId, id);
    }
    const fileCount =
      folder.fileIds.length +
      childIds.reduce((sum, childId) => sum + (folders.get(childId)?.fileCount ?? 0), 0);
    const root = firstSegment(path);
    const isWorkspaceRoot = rootSet.has(path);
    folders.set(id, {
      id,
      path,
      label,
      parentId,
      folderIds: childIds,
      fileIds: folder.fileIds,
      fileCount,
      workspaceRoot: rootSet.has(root) ? root : null,
      isWorkspaceRoot,
      languages: isWorkspaceRoot ? (languages.get(path) ?? []) : [],
    });
    return id;
  };

  const top = raw.get('') ?? { folders: new Set<RelPath>(), fileIds: [] };
  // Workspace folders keep the workspace order; other top-level folders are sorted.
  const topFolders = sortedChildren(top.folders).sort(
    (a, b) => rootOrder(a, workspaceRoots, rootSet) - rootOrder(b, workspaceRoots, rootSet),
  );
  const rootFolderIds = topFolders.map((path) => emit(path, null, ''));
  return {
    folders,
    rootFolderIds,
    rootFileIds: top.fileIds,
    folderOfFile,
    workspaceRoots: [...rootSet],
  };
}

/**
 * Position of a top-level folder: workspace folders in workspace order first.
 *
 * @param path - Top-level folder path.
 * @param order - Workspace folder names in workspace order.
 * @param roots - The same names, as a set (empty with one folder).
 * @returns A sort key.
 */
function rootOrder(path: RelPath, order: readonly string[], roots: ReadonlySet<string>): number {
  return roots.has(path) ? order.indexOf(path) : order.length;
}

/**
 * Sorts folder paths alphabetically.
 *
 * @param paths - Folder paths.
 * @returns A sorted copy.
 */
function sortedChildren(paths: ReadonlySet<RelPath>): RelPath[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * Lists the folders that contain a file, innermost first.
 *
 * @param tree - Folder tree.
 * @param fileId - File id.
 * @returns Folder ids from the file's folder up to the top level.
 */
export function getAncestorFolderIds(tree: FolderTree, fileId: string): string[] {
  const ancestors: string[] = [];
  let current = tree.folderOfFile.get(fileId);
  while (current !== undefined) {
    ancestors.push(current);
    current = tree.folders.get(current)?.parentId ?? undefined;
  }
  return ancestors;
}

/**
 * Lists every folder id of a tree.
 *
 * @param tree - Folder tree.
 * @returns Folder ids.
 */
export function getAllFolderIds(tree: FolderTree): Set<string> {
  return new Set(tree.folders.keys());
}
