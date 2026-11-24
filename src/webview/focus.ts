/**
 * Focus mode: the neighborhood of one file or function, N hops away.
 */
import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowNode } from './flowTypes';
import type { FolderTree } from './folders';
import { getAncestorFolderIds } from './folders';

/** Which neighbors to include. */
export type FocusDirection = 'both' | 'incoming' | 'outgoing';

/** All directions, in display order. */
export const FOCUS_DIRECTIONS: readonly FocusDirection[] = ['both', 'incoming', 'outgoing'];

/** Hops allowed in the focus depth selector. */
export const FOCUS_DEPTHS: readonly number[] = [1, 2, 3];

/** Parameters of a focus. */
export interface FocusOptions {
  /** Hops away from the focused node (1 = direct neighbors). */
  readonly depth: number;
  readonly direction: FocusDirection;
  /** Follow import edges. */
  readonly imports: boolean;
  /** Follow call edges. */
  readonly calls: boolean;
}

/** Nodes of the model in a focus neighborhood. */
export interface FocusResult {
  /** The focused node. */
  readonly focusId: string;
  /** Focused node, its neighbors, and the files that contain them. */
  readonly nodeIds: ReadonlySet<string>;
}

/**
 * Computes the neighborhood of a node. Focusing a file includes the calls of
 * its functions; every function found brings its file along, so the result
 * can be shown at any collapse level.
 *
 * @param snapshot - Graph snapshot.
 * @param focusId - Id of the focused file or function.
 * @param options - Depth, direction and edge kinds.
 * @returns The neighborhood (empty when the node does not exist).
 */
export function computeFocus(
  snapshot: GraphSnapshot,
  focusId: string,
  options: FocusOptions,
): FocusResult {
  const fileOf = new Map<string, string>();
  const functionsOf = new Map<string, readonly string[]>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      fileOf.set(node.id, node.fileId);
    } else {
      functionsOf.set(node.id, node.functionIds);
    }
  }
  if (!fileOf.has(focusId) && !functionsOf.has(focusId)) {
    return { focusId, nodeIds: new Set() };
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if ((edge.kind === 'import' && !options.imports) || (edge.kind === 'call' && !options.calls)) {
      continue;
    }
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }

  // A file stands for itself and its functions.
  const start = [focusId, ...(functionsOf.get(focusId) ?? [])];
  const reached = new Set(start);
  let frontier = start;
  for (let hop = 0; hop < options.depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const neighbors = [
        ...(options.direction === 'incoming' ? [] : (outgoing.get(id) ?? [])),
        ...(options.direction === 'outgoing' ? [] : (incoming.get(id) ?? [])),
      ];
      for (const neighbor of neighbors) {
        if (!reached.has(neighbor)) {
          reached.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  const nodeIds = new Set(reached);
  for (const id of reached) {
    const fileId = fileOf.get(id);
    if (fileId !== undefined) {
      nodeIds.add(fileId);
    }
  }
  return { focusId, nodeIds };
}

/**
 * Decides which displayed nodes are part of a focus, whatever is collapsed:
 * a collapsed file counts when one of its functions is in focus, and a folder
 * when it contains a file in focus.
 *
 * @param nodes - Displayed nodes.
 * @param focus - Focus neighborhood.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @returns Ids of the displayed nodes to keep highlighted.
 */
export function getFocusedDisplayIds(
  nodes: readonly CodeGraphFlowNode[],
  focus: FocusResult,
  folderTree: FolderTree | null,
): Set<string> {
  const focusedFolders = new Set<string>();
  if (folderTree !== null) {
    for (const id of focus.nodeIds) {
      for (const folderId of getAncestorFolderIds(folderTree, id)) {
        focusedFolders.add(folderId);
      }
    }
  }
  return new Set(
    nodes
      .filter((node) =>
        node.type === 'folder' ? focusedFolders.has(node.id) : focus.nodeIds.has(node.id),
      )
      .map((node) => node.id),
  );
}

/**
 * Lists the containers to open so the focus is visible: the focused node's
 * file (for a function) and the folders above the focused node and its
 * neighbor files. Neighbor files stay collapsed, to keep large
 * neighborhoods readable.
 *
 * @param snapshot - Graph snapshot.
 * @param focus - Focus neighborhood.
 * @param folderTree - Folder hierarchy, or `null` without folder view.
 * @returns Ids of the files and folders to expand.
 */
export function getFocusIdsToReveal(
  snapshot: GraphSnapshot,
  focus: FocusResult,
  folderTree: FolderTree | null,
): Set<string> {
  const reveal = new Set<string>();
  const focused = snapshot.nodes.find((node) => node.id === focus.focusId);
  if (focused?.kind === 'function') {
    reveal.add(focused.fileId);
  }
  if (folderTree !== null) {
    for (const id of focus.nodeIds) {
      for (const folderId of getAncestorFolderIds(folderTree, id)) {
        reveal.add(folderId);
      }
    }
  }
  return reveal;
}

/**
 * Chooses the nodes to frame when showing a focus: the focused node, the
 * neighbor functions and the neighbor files reached directly (imports). A
 * file that is in the focus only because one of its functions is, is left
 * out, so a large file does not make the view zoom out.
 *
 * @param snapshot - Graph snapshot.
 * @param focus - Focus neighborhood.
 * @returns Ids of the model nodes to frame.
 */
export function getFocusFitIds(snapshot: GraphSnapshot, focus: FocusResult): string[] {
  const filesWithFocusedFunctions = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function' && focus.nodeIds.has(node.id)) {
      filesWithFocusedFunctions.add(node.fileId);
    }
  }
  return [...focus.nodeIds].filter(
    (id) => id === focus.focusId || !filesWithFocusedFunctions.has(id),
  );
}
