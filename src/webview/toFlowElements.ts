/**
 * Converts the shared graph model into React Flow elements.
 */
import { MarkerType } from '@xyflow/react';

import type { FileGraphNode, FunctionGraphNode, GraphSnapshot } from '../shared';
import type { RoutedEdge } from './collapse';
import { routeEdges } from './collapse';
import type {
  CodeGraphFlowEdge,
  CodeGraphFlowNode,
  FileFlowNode,
  FlowElements,
  FolderFlowNode,
  FunctionFlowNode,
} from './flowTypes';
import type { FolderInfo, FolderTree } from './folders';

/** Width of a file container, in pixels. */
export const FILE_NODE_WIDTH = 280;

/** Height of a file container's header, in pixels. */
export const FILE_HEADER_HEIGHT = 36;

/** Height of a function row, in pixels. */
export const FUNCTION_ROW_HEIGHT = 26;

/** Vertical gap between function rows, in pixels. */
export const FUNCTION_ROW_GAP = 4;

/** Inner padding of a file container, in pixels. */
export const FILE_PADDING = 8;

/** Height of a folder container's header, in pixels. */
export const FOLDER_HEADER_HEIGHT = 40;

/** Inner padding of an expanded folder container, in pixels. */
export const FOLDER_PADDING = 20;

/** Shared empty set used when nothing is collapsed. */
const NO_COLLAPSED_IDS: ReadonlySet<string> = new Set();

/**
 * Computes the height of an expanded file container from its number of functions.
 *
 * @param functionCount - Number of functions rendered inside the file.
 * @returns Height in pixels.
 */
export function getFileNodeHeight(functionCount: number): number {
  const rowsHeight = Math.max(
    functionCount * (FUNCTION_ROW_HEIGHT + FUNCTION_ROW_GAP) - FUNCTION_ROW_GAP,
    0,
  );
  return FILE_HEADER_HEIGHT + rowsHeight + FILE_PADDING;
}

/**
 * Converts a snapshot into unpositioned React Flow elements. File and folder
 * containers are placed at the origin (the layout positions and sizes them);
 * function nodes get their final position relative to their file. Collapsed
 * files and folders render only their header, and edges of hidden nodes are
 * re-routed to the collapsed container that hides them.
 *
 * @param snapshot - Graph snapshot.
 * @param collapsedIds - Ids of the collapsed files and folders.
 * @param folderTree - Folder hierarchy, or `null` to show every file at the top level.
 * @returns Nodes (each parent before its children) and edges.
 */
export function toFlowElements(
  snapshot: GraphSnapshot,
  collapsedIds: ReadonlySet<string> = NO_COLLAPSED_IDS,
  folderTree: FolderTree | null = null,
): FlowElements {
  const filesById = new Map<string, FileGraphNode>();
  const functionsById = new Map<string, FunctionGraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'file') {
      filesById.set(node.id, node);
    } else {
      functionsById.set(node.id, node);
    }
  }

  const nodes: CodeGraphFlowNode[] = [];
  /** Visible node standing for each model node id. */
  const visibleIdByNodeId = new Map<string, string>();

  /**
   * Emits a file and its functions, or maps them to a hiding folder.
   *
   * @param file - File node of the model.
   * @param parentId - Folder that contains the file, if any.
   * @param hiddenBy - Collapsed folder that hides the file, if any.
   */
  const emitFile = (
    file: FileGraphNode,
    parentId: string | undefined,
    hiddenBy: string | undefined,
  ): void => {
    const functions = file.functionIds
      .map((id) => functionsById.get(id))
      .filter((fn): fn is FunctionGraphNode => fn !== undefined);
    if (hiddenBy !== undefined) {
      visibleIdByNodeId.set(file.id, hiddenBy);
      functions.forEach((fn) => visibleIdByNodeId.set(fn.id, hiddenBy));
      return;
    }
    const collapsed = collapsedIds.has(file.id);
    nodes.push(createFileFlowNode(file, functions.length, collapsed, parentId));
    visibleIdByNodeId.set(file.id, file.id);
    functions.forEach((fn, index) => {
      visibleIdByNodeId.set(fn.id, collapsed ? file.id : fn.id);
      if (!collapsed) {
        nodes.push(createFunctionFlowNode(fn, index));
      }
    });
  };

  /**
   * Emits a folder and its content, or maps its content to a hiding folder.
   *
   * @param tree - Folder hierarchy.
   * @param folder - Folder to emit.
   * @param hiddenBy - Collapsed ancestor that hides the folder, if any.
   */
  const emitFolder = (tree: FolderTree, folder: FolderInfo, hiddenBy: string | undefined): void => {
    let contentHiddenBy = hiddenBy;
    if (hiddenBy === undefined) {
      const collapsed = collapsedIds.has(folder.id);
      nodes.push(createFolderFlowNode(folder, collapsed));
      contentHiddenBy = collapsed ? folder.id : undefined;
    }
    for (const childId of folder.folderIds) {
      const child = tree.folders.get(childId);
      if (child !== undefined) {
        emitFolder(tree, child, contentHiddenBy);
      }
    }
    for (const fileId of folder.fileIds) {
      const file = filesById.get(fileId);
      if (file !== undefined) {
        emitFile(file, folder.id, contentHiddenBy);
      }
    }
  };

  if (folderTree === null) {
    for (const file of filesById.values()) {
      emitFile(file, undefined, undefined);
    }
  } else {
    for (const folderId of folderTree.rootFolderIds) {
      const folder = folderTree.folders.get(folderId);
      if (folder !== undefined) {
        emitFolder(folderTree, folder, undefined);
      }
    }
    for (const fileId of folderTree.rootFileIds) {
      const file = filesById.get(fileId);
      if (file !== undefined) {
        emitFile(file, undefined, undefined);
      }
    }
  }

  const edges = routeEdges(snapshot.edges, (id) => visibleIdByNodeId.get(id)).map(createFlowEdge);
  return { nodes, edges };
}

/**
 * Creates the React Flow node of a folder. Expanded folders are sized by the
 * layout once their content is positioned.
 *
 * @param folder - Folder of the hierarchy.
 * @param collapsed - Whether the content is hidden.
 * @returns The folder container node, at the origin.
 */
function createFolderFlowNode(folder: FolderInfo, collapsed: boolean): FolderFlowNode {
  return {
    id: folder.id,
    type: 'folder',
    position: { x: 0, y: 0 },
    width: FILE_NODE_WIDTH,
    height: FOLDER_HEADER_HEIGHT,
    ...(folder.parentId === null ? {} : { parentId: folder.parentId, extent: 'parent' as const }),
    data: { label: folder.label, path: folder.path, fileCount: folder.fileCount, collapsed },
  };
}

/**
 * Creates the React Flow node of a file.
 *
 * @param file - File node of the model.
 * @param functionCount - Number of functions declared in the file.
 * @param collapsed - Whether the functions are hidden.
 * @param parentId - Folder that contains the file, if any.
 * @returns The file container node, at the origin.
 */
function createFileFlowNode(
  file: FileGraphNode,
  functionCount: number,
  collapsed: boolean,
  parentId: string | undefined,
): FileFlowNode {
  return {
    id: file.id,
    type: 'file',
    position: { x: 0, y: 0 },
    width: FILE_NODE_WIDTH,
    height: collapsed ? FILE_HEADER_HEIGHT : getFileNodeHeight(functionCount),
    ...(parentId === undefined ? {} : { parentId, extent: 'parent' as const }),
    data: { label: file.label, filePath: file.filePath, line: file.line, functionCount, collapsed },
  };
}

/**
 * Creates the React Flow node of a function, positioned inside its file.
 *
 * @param fn - Function node of the model.
 * @param index - 0-based row inside the file container.
 * @returns The function node.
 */
function createFunctionFlowNode(fn: FunctionGraphNode, index: number): FunctionFlowNode {
  return {
    id: fn.id,
    type: 'function',
    parentId: fn.fileId,
    extent: 'parent',
    draggable: false,
    position: {
      x: FILE_PADDING,
      y: FILE_HEADER_HEIGHT + index * (FUNCTION_ROW_HEIGHT + FUNCTION_ROW_GAP),
    },
    width: FILE_NODE_WIDTH - 2 * FILE_PADDING,
    height: FUNCTION_ROW_HEIGHT,
    data: {
      label: fn.label,
      filePath: fn.filePath,
      line: fn.line,
      functionKind: fn.functionKind,
      exported: fn.exported,
    },
  };
}

/**
 * Creates the React Flow edge of a routed edge.
 *
 * @param edge - Edge between visible nodes.
 * @returns The styled edge (dashed for imports, solid for calls), labelled
 *   `×n` when it stands for several model edges.
 */
function createFlowEdge(edge: RoutedEdge): CodeGraphFlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    className: `cg-edge cg-edge--${edge.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    ...(edge.count > 1 ? { label: `×${String(edge.count)}` } : {}),
    data: { kind: edge.kind, count: edge.count },
  };
}
