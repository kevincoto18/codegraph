/**
 * Automatic layout of file containers with dagre.
 */
import type { EdgeLabel, GraphLabel, NodeLabel } from '@dagrejs/dagre';
import dagre from '@dagrejs/dagre';

import type { GraphSnapshot } from '../shared';
import type { CodeGraphFlowEdge, CodeGraphFlowNode, FlowElements } from './flowTypes';
import { toFlowElements } from './toFlowElements';

/** Tunable dagre parameters. */
export interface LayoutOptions {
  /** Direction of dependencies: left-to-right or top-to-bottom. */
  readonly rankDirection: 'LR' | 'TB';
  /** Gap between files in the same rank, in pixels. */
  readonly nodeSeparation: number;
  /** Gap between ranks, in pixels. */
  readonly rankSeparation: number;
}

/** Default layout: dependencies flow left to right. */
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  rankDirection: 'LR',
  nodeSeparation: 40,
  rankSeparation: 140,
};

/** Outer margin of the laid-out graph, in pixels. */
const GRAPH_MARGIN = 20;

/**
 * Positions file containers with dagre. Every edge is projected to the file
 * level, so files that call each other are ranked like files that import each
 * other. Function nodes keep their positions relative to their file.
 *
 * @param elements - Unpositioned nodes and edges.
 * @param options - Layout parameters.
 * @returns A new node array with positioned file containers.
 */
export function layoutFileNodes(
  elements: FlowElements,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): CodeGraphFlowNode[] {
  const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
  graph.setGraph({
    rankdir: options.rankDirection,
    nodesep: options.nodeSeparation,
    ranksep: options.rankSeparation,
    marginx: GRAPH_MARGIN,
    marginy: GRAPH_MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const fileIdByNodeId = new Map<string, string>();
  for (const node of elements.nodes) {
    fileIdByNodeId.set(node.id, node.parentId ?? node.id);
    if (node.type === 'file') {
      graph.setNode(node.id, { width: node.width ?? 0, height: node.height ?? 0 });
    }
  }
  for (const [source, target] of projectEdgesToFiles(elements.edges, fileIdByNodeId)) {
    graph.setEdge(source, target);
  }

  dagre.layout(graph);

  return elements.nodes.map((node) => {
    if (node.type !== 'file') {
      return node;
    }
    // dagre reports the center of each node; React Flow expects the top-left corner.
    const { x = 0, y = 0 } = graph.node(node.id);
    return { ...node, position: { x: x - (node.width ?? 0) / 2, y: y - (node.height ?? 0) / 2 } };
  });
}

/**
 * Maps edges to distinct `[sourceFile, targetFile]` pairs, dropping edges
 * inside a single file.
 *
 * @param edges - Canvas edges.
 * @param fileIdByNodeId - File id of every node (files map to themselves).
 * @returns Unique file-level pairs.
 */
export function projectEdgesToFiles(
  edges: readonly CodeGraphFlowEdge[],
  fileIdByNodeId: ReadonlyMap<string, string>,
): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  for (const edge of edges) {
    const source = fileIdByNodeId.get(edge.source);
    const target = fileIdByNodeId.get(edge.target);
    if (source !== undefined && target !== undefined && source !== target) {
      pairs.set(`${source}\u0000${target}`, [source, target]);
    }
  }
  return [...pairs.values()];
}

/**
 * Converts a snapshot into positioned React Flow elements.
 *
 * @param snapshot - Graph snapshot.
 * @param options - Layout parameters.
 * @returns Positioned nodes and edges.
 */
export function buildFlowGraph(
  snapshot: GraphSnapshot,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): FlowElements {
  const elements = toFlowElements(snapshot);
  return { nodes: layoutFileNodes(elements, options), edges: elements.edges };
}
