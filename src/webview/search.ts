/**
 * Pure name search over the graph model.
 */
import type { GraphSnapshot } from '../shared';

/** Outcome of a search. */
export interface SearchResult {
  /** Ids of nodes whose name matches the query. */
  readonly matchedIds: ReadonlySet<string>;
  /** Matched ids plus the files that contain matched functions (shown undimmed). */
  readonly highlightedIds: ReadonlySet<string>;
}

/**
 * Normalizes a raw query for case-insensitive matching.
 *
 * @param query - Text typed by the user.
 * @returns The trimmed, lower-cased query.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Finds the nodes whose name contains the query. Files match on their path;
 * functions match on their qualified name only (matching them on the file path
 * would select every function of a matching file).
 *
 * @param snapshot - Graph snapshot.
 * @param query - Raw query.
 * @returns The matches, or `null` when the query is empty (no search active).
 */
export function matchNodes(snapshot: GraphSnapshot, query: string): SearchResult | null {
  const needle = normalizeQuery(query);
  if (needle === '') {
    return null;
  }
  const matchedIds = new Set<string>();
  const highlightedIds = new Set<string>();
  for (const node of snapshot.nodes) {
    const haystack = node.kind === 'file' ? node.filePath : node.qualifiedName;
    if (!haystack.toLowerCase().includes(needle)) {
      continue;
    }
    matchedIds.add(node.id);
    highlightedIds.add(node.id);
    if (node.kind === 'function') {
      highlightedIds.add(node.fileId);
    }
  }
  return { matchedIds, highlightedIds };
}

/** Visual role of an element while a search is active. */
export type SearchRole = 'match' | 'context' | 'dimmed';

/**
 * Classifies a node for display while a search is active.
 *
 * @param nodeId - Node id.
 * @param search - Active search result.
 * @returns `match` for matches, `context` for files containing matches,
 *   `dimmed` for everything else.
 */
export function getSearchRole(nodeId: string, search: SearchResult): SearchRole {
  if (search.matchedIds.has(nodeId)) {
    return 'match';
  }
  return search.highlightedIds.has(nodeId) ? 'context' : 'dimmed';
}

/**
 * Adds search CSS classes to nodes: `cg-match` for matches, `cg-context` for
 * files that contain matches, `cg-dimmed` for everything else.
 *
 * @param nodes - Nodes to decorate.
 * @param search - Active search, or `null` when no search is active.
 * @returns The same array when no search is active, otherwise decorated copies.
 */
export function decorateNodes<T extends { readonly id: string }>(
  nodes: readonly T[],
  search: SearchResult | null,
): readonly T[] {
  if (search === null) {
    return nodes;
  }
  return nodes.map((node) => {
    return { ...node, className: `cg-${getSearchRole(node.id, search)}` };
  });
}

/**
 * Dims edges whose endpoints are not both highlighted by the search.
 *
 * @param edges - Edges to decorate.
 * @param search - Active search, or `null` when no search is active.
 * @returns The same array when no search is active, otherwise decorated copies.
 */
export function decorateEdges<
  T extends { readonly source: string; readonly target: string; readonly className?: string },
>(edges: readonly T[], search: SearchResult | null): readonly T[] {
  if (search === null) {
    return edges;
  }
  return edges.map((edge) => {
    const visible =
      search.highlightedIds.has(edge.source) && search.highlightedIds.has(edge.target);
    return visible ? edge : { ...edge, className: `${edge.className ?? ''} cg-dimmed`.trim() };
  });
}

/**
 * Formats the number of search matches.
 *
 * @param count - Number of matches.
 * @returns Human-readable count.
 */
export function formatMatchCount(count: number): string {
  if (count === 0) {
    return 'No matches';
  }
  return count === 1 ? '1 match' : `${String(count)} matches`;
}
