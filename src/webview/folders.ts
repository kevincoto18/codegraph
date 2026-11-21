/**
 * Folder hierarchy of the graph: folders become nested containers of files,
 * so large projects can be explored level by level.
 */
import type { FolderViewMode, GraphNode, RelPath } from '../shared';

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
}

/** Raw folder before compaction. */
interface RawFolder {
  readonly folders: Set<RelPath>;
  readonly fileIds: string[];
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

/**
 * Builds the folder hierarchy of the file nodes of a graph.
 *
 * @param nodes - Graph nodes (only file nodes are used).
 * @returns The folder tree.
 */
export function buildFolderTree(nodes: readonly GraphNode[]): FolderTree {
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
    while (folder.fileIds.length === 0 && folder.folders.size === 1) {
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
    folders.set(id, {
      id,
      path,
      label,
      parentId,
      folderIds: childIds,
      fileIds: folder.fileIds,
      fileCount,
    });
    return id;
  };

  const root = raw.get('') ?? { folders: new Set<RelPath>(), fileIds: [] };
  const rootFolderIds = sortedChildren(root.folders).map((path) => emit(path, null, ''));
  return { folders, rootFolderIds, rootFileIds: root.fileIds, folderOfFile };
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
