/**
 * Which kinds of connections are drawn on the canvas.
 */
import type { CodeGraphFlowEdge, CodeGraphFlowNode } from './flowTypes';

/** Visibility of each kind of connection. */
export interface EdgeFilters {
  /** Imports between files (dashed purple). */
  readonly imports: boolean;
  /** Calls between functions of different files (solid blue). */
  readonly calls: boolean;
  /** Calls between functions of the same file (only shown when `calls` is on too). */
  readonly internalCalls: boolean;
}

/** Initial filters: everything except calls inside a file, which are mostly noise. */
export const DEFAULT_EDGE_FILTERS: EdgeFilters = {
  imports: true,
  calls: true,
  internalCalls: false,
};

/**
 * Keeps the edges allowed by the filters. Filtering only changes what is
 * drawn: the layout still uses every edge, so toggling a filter never moves nodes.
 *
 * @param edges - Canvas edges.
 * @param nodes - Canvas nodes (to find the file of each function).
 * @param filters - Visibility of each kind of connection.
 * @returns The visible edges (the same array when nothing is filtered out).
 */
export function filterEdges(
  edges: readonly CodeGraphFlowEdge[],
  nodes: readonly CodeGraphFlowNode[],
  filters: EdgeFilters,
): readonly CodeGraphFlowEdge[] {
  if (filters.imports && filters.calls && filters.internalCalls) {
    return edges;
  }
  const fileOfFunction = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === 'function' && node.parentId !== undefined) {
      fileOfFunction.set(node.id, node.parentId);
    }
  }
  return edges.filter((edge) => {
    if (edge.data?.kind === 'import') {
      return filters.imports;
    }
    if (!filters.calls) {
      return false;
    }
    if (filters.internalCalls) {
      return true;
    }
    const sourceFile = fileOfFunction.get(edge.source);
    return sourceFile === undefined || sourceFile !== fileOfFunction.get(edge.target);
  });
}
