/**
 * Pure helpers for collapsing file containers and re-routing edges to the
 * nodes that remain visible.
 */
import type { EdgeKind, GraphEdge, GraphSnapshot } from '../shared';
import { createEdgeId } from '../shared';

/** Above this many functions, every file starts collapsed. */
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
 * Decides which files start collapsed: all of them for large graphs, none otherwise.
 *
 * @param snapshot - Graph snapshot.
 * @param threshold - Function count above which everything is collapsed.
 * @returns Ids of the files to collapse initially.
 */
export function getInitialCollapsedFileIds(
  snapshot: GraphSnapshot,
  threshold: number = AUTO_COLLAPSE_FUNCTION_THRESHOLD,
): Set<string> {
  const functionCount = snapshot.nodes.filter((node) => node.kind === 'function').length;
  if (functionCount <= threshold) {
    return new Set();
  }
  return new Set(snapshot.nodes.filter((node) => node.kind === 'file').map((node) => node.id));
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
