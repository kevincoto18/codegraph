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
  FunctionFlowNode,
} from './flowTypes';

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

/** Shared empty set used when nothing is collapsed. */
const NO_COLLAPSED_FILES: ReadonlySet<string> = new Set();

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
 * Converts a snapshot into unpositioned React Flow elements. File nodes are
 * placed at the origin (the layout positions them); function nodes get their
 * final position relative to their file. Collapsed files render only their
 * header and their edges are re-routed to the file node.
 *
 * @param snapshot - Graph snapshot.
 * @param collapsedFileIds - Ids of the files whose functions are hidden.
 * @returns Nodes (each parent before its children) and edges.
 */
export function toFlowElements(
  snapshot: GraphSnapshot,
  collapsedFileIds: ReadonlySet<string> = NO_COLLAPSED_FILES,
): FlowElements {
  const functionsById = new Map<string, FunctionGraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      functionsById.set(node.id, node);
    }
  }

  const nodes: CodeGraphFlowNode[] = [];
  /** Visible node standing for each model node id. */
  const visibleIdByNodeId = new Map<string, string>();

  for (const node of snapshot.nodes) {
    if (node.kind !== 'file') {
      continue;
    }
    const functions = node.functionIds
      .map((id) => functionsById.get(id))
      .filter((fn): fn is FunctionGraphNode => fn !== undefined);
    const collapsed = collapsedFileIds.has(node.id);

    nodes.push(createFileFlowNode(node, functions.length, collapsed));
    visibleIdByNodeId.set(node.id, node.id);
    functions.forEach((fn, index) => {
      visibleIdByNodeId.set(fn.id, collapsed ? node.id : fn.id);
      if (!collapsed) {
        nodes.push(createFunctionFlowNode(fn, index));
      }
    });
  }

  const edges = routeEdges(snapshot.edges, (id) => visibleIdByNodeId.get(id)).map(createFlowEdge);
  return { nodes, edges };
}

/**
 * Creates the React Flow node of a file.
 *
 * @param file - File node of the model.
 * @param functionCount - Number of functions declared in the file.
 * @param collapsed - Whether the functions are hidden.
 * @returns The file container node, at the origin.
 */
function createFileFlowNode(
  file: FileGraphNode,
  functionCount: number,
  collapsed: boolean,
): FileFlowNode {
  return {
    id: file.id,
    type: 'file',
    position: { x: 0, y: 0 },
    width: FILE_NODE_WIDTH,
    height: collapsed ? FILE_HEADER_HEIGHT : getFileNodeHeight(functionCount),
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
