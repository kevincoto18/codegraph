/**
 * Pure helpers for collapsing file and folder containers and re-routing edges
 * to the nodes that remain visible.
 */
import type { CollapseMode, EdgeKind, GraphEdge, GraphSnapshot } from '../shared';
import { createEdgeId } from '../shared';
import type { CodeGraphFlowNode } from './flowTypes';
import type { FolderTree } from './folders';
import { getAllFolderIds, getAncestorFolderIds } from './folders';

/** In `auto` mode, above this many functions every file starts collapsed. */
export const AUTO_COLLAPSE_FUNCTION_THRESHOLD = 400;

/** An edge between visible nodes, possibly standing for several model edges. */
export interface RoutedEdge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly source: string;
  readonly target: string;
  /** Number of model edges merged into this one. */
  readonly count: number;
}

/**
 * Decides which files start collapsed.
 *
 * @param snapshot - Graph snapshot.
 * @param mode - `always` collapses every file, `never` none, and `auto` every
 *   file only when the graph has more functions than `threshold`.
 * @param threshold - Function count above which `auto` collapses everything.
 * @returns Ids of the files to collapse initially.
 */
export function getInitialCollapsedFileIds(
  snapshot: GraphSnapshot,
  mode: CollapseMode,
  threshold: number = AUTO_COLLAPSE_FUNCTION_THRESHOLD,
): Set<string> {
  if (mode === 'never') {
    return new Set();
  }
  if (mode === 'auto') {
    const functionCount = snapshot.nodes.filter((node) => node.kind === 'function').length;
    if (functionCount <= threshold) {
      return new Set();
    }
  }
  return getAllFileIds(snapshot);
}

/**
 * Decides which files and folders start collapsed: every folder (the graph
 * opens at the top level) plus the files chosen by the collapse mode.
 *
 * @param snapshot - Graph snapshot.
 * @param mode - Collapse mode of files (see {@link getInitialCollapsedFileIds}).
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @returns Ids of the containers to collapse initially.
 */
export function getInitialCollapsedIds(
  snapshot: GraphSnapshot,
  mode: CollapseMode,
  folderTree: FolderTree | null,
): Set<string> {
  const collapsed = getInitialCollapsedFileIds(snapshot, mode);
  if (folderTree !== null) {
    for (const folderId of folderTree.folders.keys()) {
      collapsed.add(folderId);
    }
  }
  return collapsed;
}

/**
 * Lists every collapsible container: all files and, with folder view, all folders.
 *
 * @param snapshot - Graph snapshot.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @returns Ids of every file and folder.
 */
export function getAllContainerIds(
  snapshot: GraphSnapshot,
  folderTree: FolderTree | null,
): Set<string> {
  const ids = getAllFileIds(snapshot);
  if (folderTree !== null) {
    for (const folderId of getAllFolderIds(folderTree)) {
      ids.add(folderId);
    }
  }
  return ids;
}

/**
 * Finds the containers to open for the next level: every visible collapsed
 * folder or, when no folder is collapsed, every visible collapsed file that
 * has functions.
 *
 * @param nodes - Nodes currently displayed.
 * @returns Ids to remove from the collapsed set (empty if everything is open).
 */
export function getNextLevelToExpand(nodes: readonly CodeGraphFlowNode[]): string[] {
  const folders = nodes.filter((node) => node.type === 'folder' && node.data.collapsed);
  if (folders.length > 0) {
    return folders.map((node) => node.id);
  }
  return nodes
    .filter((node) => node.type === 'file' && node.data.collapsed && node.data.functionCount > 0)
    .map((node) => node.id);
}

/**
 * Lists the containers that must be expanded so nodes become visible: the
 * file of each function and every folder above each file.
 *
 * @param snapshot - Graph snapshot.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @param nodeIds - Nodes to reveal.
 * @returns Ids of the files and folders to expand.
 */
export function getIdsToReveal(
  snapshot: GraphSnapshot,
  folderTree: FolderTree | null,
  nodeIds: Iterable<string>,
): Set<string> {
  const fileIdOfFunction = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      fileIdOfFunction.set(node.id, node.fileId);
    }
  }
  const reveal = new Set<string>();
  for (const nodeId of nodeIds) {
    const fileId = fileIdOfFunction.get(nodeId);
    if (fileId !== undefined) {
      reveal.add(fileId);
    }
    if (folderTree !== null) {
      for (const folderId of getAncestorFolderIds(folderTree, fileId ?? nodeId)) {
        reveal.add(folderId);
      }
    }
  }
  return reveal;
}

/** Most nodes "Expand all" opens; drawing more makes the webview unresponsive. */
export const EXPAND_ALL_NODE_BUDGET = 15_000;

/** Outcome of {@link planExpandAll}. */
export interface ExpandAllPlan {
  /** Collapsed containers after expanding. */
  readonly collapsedIds: Set<string>;
  /** `false` when the budget stopped the expansion before everything was open. */
  readonly complete: boolean;
}

/**
 * Opens containers level by level (folders first, then files) until
 * everything is open or the number of drawn nodes would exceed a budget.
 *
 * @param snapshot - Graph snapshot.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @param collapsedIds - Currently collapsed containers.
 * @param budget - Maximum number of nodes to draw.
 * @returns The new collapsed set and whether everything could be opened.
 */
export function planExpandAll(
  snapshot: GraphSnapshot,
  folderTree: FolderTree | null,
  collapsedIds: ReadonlySet<string>,
  budget: number = EXPAND_ALL_NODE_BUDGET,
): ExpandAllPlan {
  const functionCount = new Map<string, number>();
  const rootFileIds: string[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind === 'file') {
      functionCount.set(node.id, node.functionIds.length);
      rootFileIds.push(node.id);
    }
  }
  // Files without functions cost nothing to open.
  const collapsed = new Set([...collapsedIds].filter((id) => functionCount.get(id) !== 0));

  /**
   * Lists the visible containers and counts the visible nodes.
   *
   * @returns Visible collapsed folders, visible collapsed files and the node count.
   */
  const inspect = (): { folders: string[]; files: string[]; visible: number } => {
    const folders: string[] = [];
    const files: string[] = [];
    let visible = 0;
    /**
     * Counts a visible file and its visible functions.
     *
     * @param fileId - File id.
     */
    const visitFile = (fileId: string): void => {
      visible += 1;
      if (collapsed.has(fileId)) {
        files.push(fileId);
      } else {
        visible += functionCount.get(fileId) ?? 0;
      }
    };
    /**
     * Counts a visible folder and, if open, its content.
     *
     * @param tree - Folder hierarchy.
     * @param folderId - Folder id.
     */
    const visitFolder = (tree: FolderTree, folderId: string): void => {
      visible += 1;
      if (collapsed.has(folderId)) {
        folders.push(folderId);
        return;
      }
      const folder = tree.folders.get(folderId);
      folder?.folderIds.forEach((childId) => {
        visitFolder(tree, childId);
      });
      folder?.fileIds.forEach(visitFile);
    };
    if (folderTree === null) {
      rootFileIds.forEach(visitFile);
    } else {
      folderTree.rootFolderIds.forEach((folderId) => {
        visitFolder(folderTree, folderId);
      });
      folderTree.rootFileIds.forEach(visitFile);
    }
    return { folders, files, visible };
  };

  /**
   * Counts the nodes that opening a container adds.
   *
   * @param id - Folder or file id.
   * @returns Number of newly visible nodes.
   */
  const costOf = (id: string): number => {
    const folder = folderTree?.folders.get(id);
    return folder === undefined
      ? (functionCount.get(id) ?? 0)
      : folder.folderIds.length + folder.fileIds.length;
  };

  for (;;) {
    const { folders, files, visible } = inspect();
    const level =
      folders.length > 0 ? folders : files.filter((id) => (functionCount.get(id) ?? 0) > 0);
    if (level.length === 0) {
      return { collapsedIds: collapsed, complete: true };
    }
    let total = visible;
    for (const id of level) {
      total += costOf(id);
      if (total > budget) {
        return { collapsedIds: collapsed, complete: false };
      }
      collapsed.delete(id);
    }
  }
}

/**
 * Returns a copy of a set with one id toggled.
 *
 * @param ids - Current set.
 * @param id - Id to add or remove.
 * @returns A new set.
 */
export function toggleId(ids: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

/**
 * Lists the ids of every file node in a snapshot.
 *
 * @param snapshot - Graph snapshot.
 * @returns File ids.
 */
export function getAllFileIds(snapshot: GraphSnapshot): Set<string> {
  return new Set(snapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.id));
}

/**
 * Re-routes model edges to visible nodes, merging edges that end up with the
 * same kind and endpoints and dropping edges that collapse into a single node.
 *
 * @param edges - Model edges.
 * @param resolveVisibleId - Maps a model node id to the id of the visible node
 *   that represents it, or `undefined` if the node is not rendered at all.
 * @returns Routed edges in first-seen order.
 */
export function routeEdges(
  edges: readonly GraphEdge[],
  resolveVisibleId: (nodeId: string) => string | undefined,
): RoutedEdge[] {
  const routed = new Map<string, RoutedEdge>();
  for (const edge of edges) {
    const source = resolveVisibleId(edge.source);
    const target = resolveVisibleId(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const id = createEdgeId(edge.kind, source, target);
    const existing = routed.get(id);
    routed.set(id, { id, kind: edge.kind, source, target, count: (existing?.count ?? 0) + 1 });
  }
  return [...routed.values()];
}
