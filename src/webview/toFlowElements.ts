/**
 * Converts the shared graph model into React Flow elements.
 */
import { MarkerType } from '@xyflow/react';

import type { FileGraphNode, FunctionGraphNode, GraphEdge, GraphSnapshot } from '../shared';
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

/**
 * Computes the height of a file container from its number of functions.
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
 * final position relative to their file.
 *
 * @param snapshot - Graph snapshot.
 * @returns Nodes (each parent before its children) and edges.
 */
export function toFlowElements(snapshot: GraphSnapshot): FlowElements {
  const functionsById = new Map<string, FunctionGraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'function') {
      functionsById.set(node.id, node);
    }
  }

  const nodes: CodeGraphFlowNode[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind !== 'file') {
      continue;
    }
    const functions = node.functionIds
      .map((id) => functionsById.get(id))
      .filter((fn): fn is FunctionGraphNode => fn !== undefined);
    nodes.push(createFileFlowNode(node, functions.length));
    functions.forEach((fn, index) => {
      nodes.push(createFunctionFlowNode(fn, index));
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map(createFlowEdge);

  return { nodes, edges };
}

/**
 * Creates the React Flow node of a file.
 *
 * @param file - File node of the model.
 * @param functionCount - Number of functions rendered inside it.
 * @returns The file container node, at the origin.
 */
function createFileFlowNode(file: FileGraphNode, functionCount: number): FileFlowNode {
  return {
    id: file.id,
    type: 'file',
    position: { x: 0, y: 0 },
    width: FILE_NODE_WIDTH,
    height: getFileNodeHeight(functionCount),
    data: { label: file.label, filePath: file.filePath, line: file.line, functionCount },
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
 * Creates the React Flow edge of a model edge.
 *
 * @param edge - Edge of the model.
 * @returns The styled edge (dashed for imports, solid for calls).
 */
function createFlowEdge(edge: GraphEdge): CodeGraphFlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    className: `cg-edge cg-edge--${edge.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { kind: edge.kind },
  };
}
